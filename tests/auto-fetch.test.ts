import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config";
import type { MpvData } from "../src/mpv";

// Mock config so autoFetch.enabled is predictable.
vi.mock("../src/config", () => ({
    config: {
        syncDryRun: false,
        autoFetch: {
            enabled: true,
        },
    },
}));

// Mock trakt-sync/api so importing auto-fetch.ts doesn't pull in axios +
// the full trakt axios instance (which is constructed at module-load time
// and would otherwise need a real config.trakt object).
vi.mock("../src/trakt-sync/api", () => ({
    normalizeTitle: (s: string) =>
        s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim(),
}));

// Mock node:fs so readSharedConfig returns a known config without touching disk.
vi.mock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
        ...actual,
        readFileSync: vi.fn(),
    };
});

const SHARED_CONFIG = {
    stremioMeta: {
        imdbId: "tt1234567",
        name: "Test Show",
        season: 3,
        episode: 5,
        type: "series",
    },
    extraEpisodes: 2,
};

function makeMpvData(overrides: Partial<MpvData> = {}): MpvData {
    return {
        media_title: "Test Show S03E05",
        series_title: "Test Show",
        season: 3,
        episode: 5,
        episode_title: null,
        filename: "Test.Show.S03E05.mkv",
        pause: false,
        percent_pos: 95,
        time_pos: 0,
        duration: 0,
        artist: "N/A",
        cover_image: null,
        mal_id: null,
        total_episodes: null,
        adjusted_episode: null,
        imdb_id: "tt1234567",
        type: "series",
        playlistPos: 0,
        playlistCount: 1,
        ...overrides,
    };
}

function mockJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

async function importAutoFetchModule(): Promise<typeof import("../src/auto-fetch")> {
    vi.resetModules();
    return import("../src/auto-fetch");
}

describe("buildCurrentEpisodeKey", () => {
    it("builds a zero-padded key from imdb_id + season + episode", async () => {
        const { buildCurrentEpisodeKey } = await importAutoFetchModule();
        const data = makeMpvData({ imdb_id: "tt1234567", season: 3, episode: 5 });
        expect(buildCurrentEpisodeKey(data)).toBe("tt1234567:S03E05");
    });

    it("falls back to series_title when imdb_id is missing", async () => {
        const { buildCurrentEpisodeKey } = await importAutoFetchModule();
        const data = makeMpvData({ imdb_id: undefined, series_title: "Frieren", season: 2, episode: 12 });
        expect(buildCurrentEpisodeKey(data)).toBe("Frieren:S02E12");
    });

    it("collapses null season to S00", async () => {
        const { buildCurrentEpisodeKey } = await importAutoFetchModule();
        const data = makeMpvData({ season: null, episode: 7 });
        expect(buildCurrentEpisodeKey(data)).toBe("tt1234567:S00E07");
    });

    it("collapses null episode to E00", async () => {
        const { buildCurrentEpisodeKey } = await importAutoFetchModule();
        const data = makeMpvData({ season: 2, episode: null });
        expect(buildCurrentEpisodeKey(data)).toBe("tt1234567:S02E00");
    });

    it("is idempotent — same inputs always produce the same key", async () => {
        const { buildCurrentEpisodeKey } = await importAutoFetchModule();
        const data = makeMpvData();
        const k1 = buildCurrentEpisodeKey(data);
        const k2 = buildCurrentEpisodeKey(data);
        const k3 = buildCurrentEpisodeKey(makeMpvData());
        expect(k1).toBe(k2);
        expect(k2).toBe(k3);
    });
});

describe("checkAndTriggerAutoFetch — single-flight guard", () => {
    let readFileSyncMock: ReturnType<typeof vi.fn>;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        config.syncDryRun = false;

        // Setup fs mock to return our shared config.
        const fs = await import("node:fs");
        readFileSyncMock = vi.mocked(fs.readFileSync);
        readFileSyncMock.mockReturnValue(JSON.stringify(SHARED_CONFIG));

        // Default fetch mock: bridge is healthy + auto-fetch succeeds.
        fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) {
                return mockJsonResponse({ status: "ok" });
            }
            if (url.endsWith("/auto-fetch")) {
                return mockJsonResponse({ success: true, added: 2 });
            }
            return mockJsonResponse({}, 404);
        });
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("calls fetch exactly once for the happy path", async () => {
        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        await checkAndTriggerAutoFetch(makeMpvData());

        // Expect: 1 health check + 1 auto-fetch POST.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const autoFetchCall = fetchMock.mock.calls.find(([u]) =>
            typeof u === "string" ? u.endsWith("/auto-fetch") : u.toString().endsWith("/auto-fetch"),
        );
        expect(autoFetchCall).toBeDefined();
    });

    it("logs bridge in-progress responses without saying zero episodes were added", async () => {
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) {
                return mockJsonResponse({ status: "ok" });
            }
            if (url.endsWith("/auto-fetch")) {
                return mockJsonResponse({ success: true, status: "in_progress", added: 0, skippedInFlight: 2 });
            }
            return mockJsonResponse({}, 404);
        });

        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        await checkAndTriggerAutoFetch(makeMpvData());

        expect(consoleLogSpy).toHaveBeenCalledWith(
            "[AutoFetch] Auto-fetch already in progress for 2 target episode(s).",
        );
        expect(consoleLogSpy).not.toHaveBeenCalledWith("[AutoFetch] Added 0 episode(s) to playlist.");
        consoleLogSpy.mockRestore();
    });

    it("uses Stremio metadata season and episode for split-part playback", async () => {
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                stremioMeta: {
                    imdbId: "tt9679542",
                    name: "Dr. Stone",
                    season: 4,
                    episode: 30,
                    type: "series",
                },
                extraEpisodes: 2,
            }),
        );

        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        await checkAndTriggerAutoFetch(
            makeMpvData({
                media_title: "[Erai-raws] Dr Stone - Science Future Part 3 - 06",
                series_title: "Dr. Stone",
                season: null,
                episode: 6,
                filename: "[Erai-raws] Dr Stone - Science Future Part 3 - 06.mkv",
                imdb_id: "tt9679542",
            }),
        );

        const autoFetchCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/auto-fetch"));
        expect(autoFetchCall).toBeDefined();
        const request = autoFetchCall?.[1] as RequestInit;
        expect(JSON.parse(String(request.body))).toMatchObject({
            season: 4,
            episode: 30,
        });
    });

    it("uses deterministic split-part canonical identity when Stremio metadata lacks season and episode", async () => {
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                stremioMeta: {
                    imdbId: "tt9679542",
                    name: "Dr. Stone",
                    type: "series",
                },
                extraEpisodes: 2,
            }),
        );

        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        await checkAndTriggerAutoFetch(
            makeMpvData({
                media_title: "[Erai-raws] Dr Stone - Science Future Part 3 - 06",
                series_title: "Dr. Stone: Science Future Part 3",
                season: null,
                episode: 6,
                filename: "[Erai-raws] Dr Stone - Science Future Part 3 - 06.mkv",
                imdb_id: "tt9679542",
            }),
        );

        const autoFetchCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/auto-fetch"));
        expect(autoFetchCall).toBeDefined();
        const request = autoFetchCall?.[1] as RequestInit;
        expect(JSON.parse(String(request.body))).toMatchObject({
            season: 4,
            episode: 30,
        });
    });

    it("uses Jujutsu Kaisen Stremio metadata as canonical for split-entry playback", async () => {
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                stremioMeta: {
                    seriesId: "mal:57658",
                    imdbId: "tt12343534",
                    libraryItemId: "mal:57658",
                    videoId: "tt12343534:3:5",
                    name: "Jujutsu Kaisen",
                    season: 3,
                    episode: 5,
                    type: "series",
                },
                extraEpisodes: 2,
            }),
        );

        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        await checkAndTriggerAutoFetch(
            makeMpvData({
                media_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - E05",
                series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
                season: null,
                episode: 5,
                filename:
                    "[Erai-raws] Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - 05 [1080p CR WEB-DL AVC AAC][MultiSub][FDCB43F3].mkv",
                imdb_id: "tt12343534",
            }),
        );

        const autoFetchCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/auto-fetch"));
        expect(autoFetchCall).toBeDefined();
        const request = autoFetchCall?.[1] as RequestInit;
        expect(JSON.parse(String(request.body))).toMatchObject({
            season: 3,
            episode: 5,
        });
    });

    it("uses split-part canonical position atomically for dry-run next episodes", async () => {
        config.syncDryRun = true;
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                stremioMeta: {
                    imdbId: "tt9679542",
                    name: "Dr. Stone",
                    season: 4,
                    episode: 6,
                    type: "series",
                },
                extraEpisodes: 2,
            }),
        );

        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        await checkAndTriggerAutoFetch(
            makeMpvData({
                media_title: "Dr Stone - Science Future Part 3 - Ep 06",
                series_title: "Dr. Stone: Science Future Part 3",
                season: null,
                episode: 6,
                filename: "Dr Stone - Science Future Part 3 - Ep 06.mkv",
                imdb_id: "tt9679542",
            }),
        );

        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("Would POST /auto-fetch: 2 episode(s) (S04E31, S04E32)"),
        );
        expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("S04E07"));
        expect(fetchMock).not.toHaveBeenCalledWith("http://localhost:9632/auto-fetch", expect.anything());
        consoleLogSpy.mockRestore();
    });

    it("keeps explicit canonical filename position ahead of MAL-local split episode", async () => {
        config.syncDryRun = true;
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                stremioMeta: {
                    imdbId: "tt9679542",
                    name: "Dr. Stone",
                    season: 4,
                    episode: 9,
                    type: "series",
                },
                extraEpisodes: 2,
            }),
        );

        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        await checkAndTriggerAutoFetch(
            makeMpvData({
                media_title: "Dr.STONE.S04E33.Wanting.Everything",
                series_title: "Dr Stone: Science Future",
                season: 4,
                episode: 9,
                filename: "Dr.STONE.S04E33.Wanting.Everything.mkv",
                imdb_id: "tt9679542",
            }),
        );

        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining("Would POST /auto-fetch: 2 episode(s) (S04E34, S04E35)"),
        );
        expect(fetchMock).not.toHaveBeenCalledWith("http://localhost:9632/auto-fetch", expect.anything());
        consoleLogSpy.mockRestore();
    });

    it("skips a second concurrent tick that hits the same episode identity", async () => {
        // Make the auto-fetch POST slow so the second call observes the in-flight Set.
        let releasePost: (() => void) | null = null;
        const slowFetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) {
                return mockJsonResponse({ status: "ok" });
            }
            if (url.endsWith("/auto-fetch")) {
                // Block until the test releases the response.
                await new Promise<void>((resolve) => {
                    releasePost = resolve;
                });
                return mockJsonResponse({ success: true, added: 2 });
            }
            return mockJsonResponse({}, 404);
        });
        vi.stubGlobal("fetch", slowFetch);

        const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
        const data = makeMpvData();

        // Fire two concurrent ticks. The first should mark in-flight and
        // the second should bail out at the in-flight guard.
        const first = checkAndTriggerAutoFetch(data);
        // Yield so the first call's `autoFetchInFlight.add(currentKey)` runs
        // before the second call hits the in-flight check.
        await Promise.resolve();
        const second = checkAndTriggerAutoFetch(data);

        // Second call should have returned without waiting for the slow POST.
        // Release the POST so the first call can finish.
        if (releasePost) releasePost();

        await Promise.all([first, second]);

        // health + auto-fetch = 2 calls (only the first tick reaches the POST).
        const autoFetchCalls = slowFetch.mock.calls.filter(([u]) => {
            const url = typeof u === "string" ? u : u.toString();
            return url.endsWith("/auto-fetch");
        });
        expect(autoFetchCalls).toHaveLength(1);
    });

    it("releases the in-flight slot on fetch failure so retries can proceed", async () => {
        // Use fake timers to bypass the 30s cooldown between calls.
        vi.useFakeTimers();
        try {
            // First call: bridge health returns 500 → triggers nothing.
            fetchMock.mockImplementation(async () => mockJsonResponse({}, 500));
            const { checkAndTriggerAutoFetch } = await importAutoFetchModule();
            const data = makeMpvData();

            await checkAndTriggerAutoFetch(data);
            expect(fetchMock).toHaveBeenCalledTimes(1); // health only

            // Advance past the 30s cooldown.
            vi.advanceTimersByTime(31_000);

            // Now mock a healthy bridge + successful auto-fetch.
            fetchMock.mockClear();
            fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
                const url = typeof input === "string" ? input : input.toString();
                if (url.endsWith("/health")) {
                    return mockJsonResponse({ status: "ok" });
                }
                return mockJsonResponse({ success: true, added: 2 });
            });

            await checkAndTriggerAutoFetch(data);
            // The retry should reach the bridge (proving the in-flight slot was
            // released by the previous call's finally block). Without the finally
            // block, the in-flight Set would still contain the key.
            const healthCalls = fetchMock.mock.calls.filter(([u]) => {
                const url = typeof u === "string" ? u : u.toString();
                return url.endsWith("/health");
            });
            const postCalls = fetchMock.mock.calls.filter(([u]) => {
                const url = typeof u === "string" ? u : u.toString();
                return url.endsWith("/auto-fetch");
            });
            expect(healthCalls).toHaveLength(1);
            expect(postCalls).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
