import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWithPtt, setDefaultPttImporterForTests, setPttImporterForTests } from "../src/core/parser-ptt";

type FakePtt = { parseTorrentTitle: (title: string) => unknown };

function fakeImporter(parse: (title: string) => unknown): () => Promise<FakePtt> {
    return async () => ({ parseTorrentTitle: parse });
}

afterEach(() => {
    setPttImporterForTests(null);
    vi.restoreAllMocks();
});

describe("parseWithPtt with the real PTT", () => {
    it("maps the PTT result to PttParsed", async () => {
        const result = await parseWithPtt(
            "[Erai-raws] Oshi no Ko 3rd Season - 09 [1080p][Multiple Subtitle][ABCD1234].mkv",
        );

        expect(result).toMatchObject({
            title: "Oshi no Ko",
            season: 3,
            episode: 9,
            releaseGroup: "Erai-raws",
            resolution: "1080p",
        });
        expect(result?.episodeTitle).toBeNull();
    });

    it("maps episodeTitle and source", async () => {
        const result = await parseWithPtt(
            "Dr.STONE.S04E33.Wanting.Everything.1080p.CR.WEB-DL.MULTi.AAC2.0.H.264-VARYG.mkv",
        );

        expect(result).toMatchObject({
            title: "Dr STONE",
            season: 4,
            episode: 33,
            episodeTitle: "Wanting Everything",
            releaseGroup: "VARYG",
            source: "WEB-DL",
        });
    });
});

describe("parseWithPtt with a fake importer", () => {
    it("uses null season and episode when the arrays are missing or empty", async () => {
        setPttImporterForTests(fakeImporter(() => ({ title: "X", seasons: [], episodes: undefined })));

        const result = await parseWithPtt("X.mkv");

        expect(result).toEqual({ title: "X", season: null, episode: null, episodeTitle: null });
    });

    it("returns null for an empty or missing title", async () => {
        setPttImporterForTests(fakeImporter(() => ({ title: "" })));
        expect(await parseWithPtt("a.mkv")).toBeNull();

        setPttImporterForTests(fakeImporter(() => ({})));
        expect(await parseWithPtt("b.mkv")).toBeNull();
    });

    it("returns null when the importer rejects", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        setPttImporterForTests(async () => {
            throw new Error("cannot load");
        });

        expect(await parseWithPtt("Show - 05.mkv")).toBeNull();
    });

    it("warns only once across repeated load failures", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        setPttImporterForTests(async () => {
            throw new Error("cannot load");
        });

        await parseWithPtt("a.mkv");
        await parseWithPtt("b.mkv");

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("retries the load after a failure", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        let calls = 0;
        setPttImporterForTests(async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error("transient");
            }
            return { parseTorrentTitle: () => ({ title: "Recovered" }) };
        });

        expect(await parseWithPtt("a.mkv")).toBeNull();
        const second = await parseWithPtt("b.mkv");

        expect(second?.title).toBe("Recovered");
        expect(calls).toBe(2);
    });

    it("returns null when parseTorrentTitle throws", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        setPttImporterForTests(
            fakeImporter(() => {
                throw new Error("bad input");
            }),
        );

        await expect(parseWithPtt("weird\u0000name.mkv")).resolves.toBeNull();
    });
});

describe("default importer", () => {
    it("is restored by setPttImporterForTests(null) after an override", async () => {
        setDefaultPttImporterForTests(async () => ({ parseTorrentTitle: () => ({ title: "FromDefault" }) }));
        try {
            setPttImporterForTests(async () => {
                throw new Error("override");
            });
            vi.spyOn(console, "warn").mockImplementation(() => undefined);
            expect(await parseWithPtt("a.mkv")).toBeNull();

            setPttImporterForTests(null);

            expect((await parseWithPtt("b.mkv"))?.title).toBe("FromDefault");
        } finally {
            // Put back the real importer installed by tests/setup/ptt-importer.ts.
            setDefaultPttImporterForTests(() => import("@aiostreams/release-parser"));
            setPttImporterForTests(null);
        }
    });
});
