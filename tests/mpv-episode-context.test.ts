import { beforeEach, describe, expect, it, vi } from "vitest";

const createConnectionMock = vi.fn();
const parseFilenameMock = vi.fn();
const extractEpisodeMarkerMock = vi.fn();
const getAnimeInfoMock = vi.fn();
const getEpisodeTitleMock = vi.fn();
const checkSeriesNameOverrideMock = vi.fn();

vi.mock("net", () => ({
    default: {
        createConnection: createConnectionMock,
    },
    createConnection: createConnectionMock,
}));

vi.mock("../src/config", () => ({
    config: {
        mpvPipePath: "\\\\.\\pipe\\mpv",
        debug: true,
        settings: {
            preferredTitleLanguage: "none",
        },
    },
}));

vi.mock("../src/parser", () => ({
    parseFilename: parseFilenameMock,
    extractEpisodeMarker: extractEpisodeMarkerMock,
}));

vi.mock("../src/anime", () => ({
    getAnimeInfo: getAnimeInfoMock,
    getEpisodeTitle: getEpisodeTitleMock,
}));

vi.mock("../src/console", () => ({
    checkSeriesNameOverride: checkSeriesNameOverrideMock,
}));

let mpvProperties: Record<string, unknown> = {};

function buildBase64UrlJson(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(payload), "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function buildContextMediaTitle(
    context: Record<string, unknown>,
    displayTitle = "Episode title only"
): string {
    return `#MPVRPC-CTX:${buildBase64UrlJson(context)}\n${displayTitle}`;
}

function buildInlineContextMediaTitle(
    context: Record<string, unknown>,
    displayTitle = "Episode title only"
): string {
    return `${displayTitle} #MPVRPC-CTX:${buildBase64UrlJson(context)}`;
}

function buildConnectedSocket(): {
    handlers: Record<string, (data?: unknown) => void>;
    socket: {
        on: (event: string, handler: (data?: unknown) => void) => void;
        write: (message: string) => void;
        destroy: () => void;
    };
} {
    const handlers: Record<string, (data?: unknown) => void> = {};
    let requestId = 0;

    const socket = {
        on(event: string, handler: (data?: unknown) => void): void {
            handlers[event] = handler;
        },
        write(message: string): void {
            const parsedMessage = JSON.parse(message) as {
                command: ["get_property", string];
                request_id: number;
            };

            requestId = parsedMessage.request_id;
            const prop = parsedMessage.command[1];

            const response = {
                request_id: requestId,
                data: mpvProperties[prop] ?? "N/A",
            };

            const dataHandler = handlers["data"];
            if (dataHandler) {
                dataHandler(Buffer.from(`${JSON.stringify(response)}\n`, "utf-8"));
            }
        },
        destroy(): void {
            const closeHandler = handlers["close"];
            if (closeHandler) {
                closeHandler();
            }
        },
    };

    return { handlers, socket };
}

describe("MPV metadata resolution episode context", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        extractEpisodeMarkerMock.mockImplementation((input: string) => {
            const seMatch = input.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
            if (seMatch) {
                return {
                    hasMarker: true,
                    season: parseInt(seMatch[1], 10),
                    episode: parseInt(seMatch[2], 10),
                };
            }

            const explicitEpisodeMatch = input.match(/(?:^|[\s._-])[Ee][Pp]?(?:isode)?[\s._-]*(\d{1,3})(?=[^\d]|$)/);
            if (explicitEpisodeMatch) {
                return {
                    hasMarker: true,
                    season: null,
                    episode: parseInt(explicitEpisodeMatch[1], 10),
                };
            }

            const trailingEpisodeMatch = input.match(/-\s*(\d{1,3})(?=\s*(?:\[|\(|v\d|$))/i);
            if (trailingEpisodeMatch) {
                return {
                    hasMarker: true,
                    season: null,
                    episode: parseInt(trailingEpisodeMatch[1], 10),
                };
            }

            return {
                hasMarker: false,
                season: null,
                episode: null,
            };
        });

        mpvProperties = {
            "filename/no-ext": "Dr.Stone.S03E12",
            "media-title": "Dr Stone S03E12",
            "pause": false,
            "percent-pos": 42,
            "time-pos": 120,
            "duration": 300,
            "metadata/by-key/Artist": "N/A",
        };

        parseFilenameMock.mockResolvedValue({
            full_title: "Dr Stone - S03E12",
            series_title: "Dr Stone",
            season: 3,
            episode: 12,
            episode_title: null,
            media_type: "anime",
            release_group: null,
            languages: null,
            parse_method: "ptt",
        });

        getAnimeInfoMock.mockResolvedValue({
            id: 58187,
            mal_id: 58187,
            title_english: "Dr. STONE NEW WORLD",
            title_romaji: "Dr. Stone: New World",
            cover_url: null,
            total_episodes: 22,
        });

        getEpisodeTitleMock.mockResolvedValue("Science Is Elegant");
        checkSeriesNameOverrideMock.mockReturnValue(null);

        const { handlers, socket } = buildConnectedSocket();

        createConnectionMock.mockImplementation(() => {
            setTimeout(() => {
                const connectHandler = handlers["connect"];
                if (connectHandler) {
                    connectHandler();
                }
            }, 0);

            return socket;
        });
    });

    it("passes parsed episode into anime info resolution", async () => {
        const mpvModule = await import("../src/mpv");

        const data = await mpvModule.getMpvData();

        expect(data?.series_title).toBe("Dr Stone");
        expect(getAnimeInfoMock).toHaveBeenCalledWith("Dr Stone", 3, 12);
    });

    it("uses streamTitleRaw when filename is ambiguous", async () => {
        mpvProperties["filename/no-ext"] = "stremio-playlist-123456";
        mpvProperties["media-title"] = buildContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E12",
            behaviorHintsFilename: "Dr.Stone.S03E12.mkv",
        }, "Science Is Elegant");

        const mpvModule = await import("../src/mpv");
        await mpvModule.getMpvData();

        expect(parseFilenameMock).toHaveBeenCalledWith("Dr Stone S03E12");
    });

    it("uses streamTitleRaw for primary marker when behaviorHintsFilename is null", async () => {
        mpvProperties["filename/no-ext"] = "stremio-playlist-999999";
        mpvProperties["media-title"] = buildContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E12",
            behaviorHintsFilename: null,
        }, "Science Is Elegant");

        const mpvModule = await import("../src/mpv");
        await mpvModule.getMpvData();

        expect(parseFilenameMock).toHaveBeenCalledWith("Dr Stone S03E12");
    });

    it("keeps filename when filename is sufficient", async () => {
        mpvProperties["filename/no-ext"] = "Dr.Stone.S03E12";
        mpvProperties["media-title"] = buildContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E12",
            behaviorHintsFilename: "Dr.Stone.S03E12.mkv",
        }, "Science Is Elegant");

        const mpvModule = await import("../src/mpv");
        await mpvModule.getMpvData();

        expect(parseFilenameMock).toHaveBeenCalledWith("Dr.Stone.S03E12");
    });

    it("logs marker conflict and takes ambiguity path", async () => {
        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        mpvProperties["filename/no-ext"] = "Dr.Stone.S03E12";
        mpvProperties["media-title"] = buildContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E11",
            behaviorHintsFilename: "Dr.Stone.S03E11.mkv",
        }, "Dr Stone S03E11");

        const mpvModule = await import("../src/mpv");
        await mpvModule.getMpvData();

        expect(parseFilenameMock).toHaveBeenCalledWith("Dr Stone S03E11");
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("marker conflict detected"));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("selected parse source: streamTitleRaw"));

        consoleSpy.mockRestore();
    });

    it("dedupes parse source debug logs until source/context changes", async () => {
        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const mpvModule = await import("../src/mpv");

        await mpvModule.getMpvData();
        await mpvModule.getMpvData();

        const filenameSourceLogs = consoleSpy.mock.calls.filter(([message]) =>
            typeof message === "string"
            && message.includes("selected parse source: filename")
        );
        expect(filenameSourceLogs).toHaveLength(1);

        mpvProperties["filename/no-ext"] = "stremio-playlist-123456";
        mpvProperties["media-title"] = buildContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E12",
            behaviorHintsFilename: "Dr.Stone.S03E12.mkv",
        }, "Science Is Elegant");

        await mpvModule.getMpvData();

        const streamSourceLogs = consoleSpy.mock.calls.filter(([message]) =>
            typeof message === "string"
            && message.includes("selected parse source: streamTitleRaw")
        );
        expect(streamSourceLogs).toHaveLength(1);

        consoleSpy.mockRestore();
    });

    it("dedupes skip/conflict debug logs and re-logs when reason changes", async () => {
        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const mpvModule = await import("../src/mpv");

        mpvProperties["filename/no-ext"] = "stremio-playlist-123456";
        mpvProperties["media-title"] = "Episode title only";

        await mpvModule.getMpvData();
        await mpvModule.getMpvData();

        const waitingLogs = consoleSpy.mock.calls.filter(([message]) =>
            typeof message === "string"
            && message.includes("skipping parse target selection (waiting_for_title)")
        );
        expect(waitingLogs).toHaveLength(1);

        mpvProperties["filename/no-ext"] = "Dr.Stone.S03E12";
        mpvProperties["media-title"] = buildContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E11",
            behaviorHintsFilename: "Dr.Stone.S03E11.mkv",
        }, "Dr Stone S03E11");

        await mpvModule.getMpvData();

        const conflictLogs = consoleSpy.mock.calls.filter(([message]) =>
            typeof message === "string"
            && message.includes("marker conflict detected")
        );
        expect(conflictLogs).toHaveLength(1);

        mpvProperties["media-title"] = buildContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E11",
            behaviorHintsFilename: "Dr.Stone.S03E11.mkv",
        }, "Episode title only");

        await mpvModule.getMpvData();

        const updatedConflictLogs = consoleSpy.mock.calls.filter(([message]) =>
            typeof message === "string"
            && message.includes("marker conflict detected")
        );
        expect(updatedConflictLogs).toHaveLength(2);

        consoleSpy.mockRestore();
    });

    it("ignores corrupted context marker and still parses via fallback source", async () => {
        mpvProperties["filename/no-ext"] = "stremio-playlist-123456";
        mpvProperties["media-title"] = "#MPVRPC-CTX:not-valid-base64\nDr Stone S03E12";

        const mpvModule = await import("../src/mpv");
        await mpvModule.getMpvData();

        expect(parseFilenameMock).toHaveBeenCalledWith("Dr Stone S03E12");
    });

    it("uses legacy no-context path and parses filename when marker exists", async () => {
        mpvProperties["filename/no-ext"] = "Dr.Stone.S03E12";
        mpvProperties["media-title"] = "Science Is Elegant";

        const mpvModule = await import("../src/mpv");
        await mpvModule.getMpvData();

        expect(parseFilenameMock).toHaveBeenCalledWith("Dr.Stone.S03E12");
    });

    it("supports inline MPVRPC context marker format", async () => {
        mpvProperties["filename/no-ext"] = "stremio-playlist-123456";
        mpvProperties["media-title"] = buildInlineContextMediaTitle({
            streamTitleRaw: "Dr Stone S03E12",
            behaviorHintsFilename: null,
        }, "Science Is Elegant");

        const mpvModule = await import("../src/mpv");
        await mpvModule.getMpvData();

        expect(parseFilenameMock).toHaveBeenCalledWith("Dr Stone S03E12");
    });
});
