import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearParseCacheForTests, parseFilename } from "../src/core/parser";
import { setPttImporterForTests } from "../src/core/parser-ptt";

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    clearParseCacheForTests();
    setPttImporterForTests(null);
    vi.restoreAllMocks();
});

describe("parseFilename with PTT first", () => {
    it("uses PTT first", async () => {
        const result = await parseFilename("[SubsPlease] Jujutsu Kaisen - 05 [1080p][HEVC].mkv");

        expect(result.series_title).toBe("Jujutsu Kaisen");
        expect(result.season).toBeNull();
        expect(result.episode).toBe(5);
        expect(result.parseMethod).toBe("ptt");
        expect(result.releaseGroup).toBe("SubsPlease");
    });

    it("exposes year on ParsedFilename", async () => {
        const result = await parseFilename("Link.Click.2021.S04E10.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu.mkv");

        expect(result.year).toBe(2021);
    });

    it("leaves year unset when the filename has none", async () => {
        const result = await parseFilename("[SubsPlease] Jujutsu Kaisen - 05 [1080p][HEVC].mkv");

        expect(result).not.toHaveProperty("year");
    });

    it("rejects the PTT result when a marker exists but no episode was extracted", async () => {
        setPttImporterForTests(async () => ({ parseTorrentTitle: () => ({ title: "Algum Titulo" }) }));

        const result = await parseFilename("Algum Titulo - 05.mkv");

        expect(result.parseMethod).toBe("regex");
        expect(result.episode).toBe(5);
    });

    it("does not read S12E3 inside a word as an episode marker", async () => {
        setPttImporterForTests(async () => ({ parseTorrentTitle: () => ({ title: "Foo Bar" }) }));

        const result = await parseFilename("Foo Bar xS12E3 Special.mkv");

        expect(result.parseMethod).toBe("ptt");
        expect(result.episode).toBeNull();
    });

    it("still reads a real S01E02 marker", async () => {
        setPttImporterForTests(async () => ({ parseTorrentTitle: () => ({ title: "Foo Bar" }) }));

        const result = await parseFilename("Foo Bar S01E02.mkv");

        expect(result.parseMethod).toBe("regex");
        expect(result.episode).toBe(2);
    });

    it("parses the same filename again after the cache is cleared", async () => {
        setPttImporterForTests(async () => ({ parseTorrentTitle: () => ({}) }));
        const first = await parseFilename("Cache Clear Show - 04.mkv");
        expect(first.parseMethod).not.toBe("ptt");

        setPttImporterForTests(null);
        clearParseCacheForTests();
        const second = await parseFilename("Cache Clear Show - 04.mkv");

        expect(second.parseMethod).toBe("ptt");
    });

    it("accepts a name without an episode marker", async () => {
        const result = await parseFilename("Example Movie.mkv");

        expect(result.series_title).toBe("Example Movie");
        expect(result.episode).toBeNull();
        expect(result.parseMethod).toBe("ptt");
    });

    it("rejects an invalid search title", async () => {
        setPttImporterForTests(async () => ({ parseTorrentTitle: () => ({ title: "12345" }) }));

        const result = await parseFilename("12345.mkv");

        expect(result.parseMethod).toBe("regex");
    });

    it("short-circuits N/A and stremio-playlist names without loading PTT", async () => {
        const parse = vi.fn(() => ({ title: "Should Not Be Used" }));
        const importer = vi.fn(async () => ({ parseTorrentTitle: parse }));
        setPttImporterForTests(importer);

        const notAvailable = await parseFilename("N/A");
        const playlist = await parseFilename("stremio-playlist-abc.mkv");

        expect(notAvailable.series_title).toBe("N/A");
        expect(playlist.series_title).toBe("N/A");
        expect(importer).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
    });

    it("survives a 5000-character filename", async () => {
        const started = performance.now();

        const result = await parseFilename(`${"A".repeat(5000)} - 05.mkv`);

        expect(result.parseMethod).toBe("ptt");
        expect(result.episode).toBe(5);
        expect(result.series_title.startsWith("AAAA")).toBe(true);
        expect(result.series_title.length).toBeGreaterThan(4000);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it("decodes URL-encoded names before PTT", async () => {
        const result = await parseFilename("%5BErai%20raws%5D%20Oshi%20no%20Ko%203rd%20Season%20-%2009.mkv");

        expect(result.series_title).toBe("Oshi no Ko");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
    });

    it("does not keep a regex result produced while PTT could not load", async () => {
        setPttImporterForTests(async () => {
            throw new Error("cannot load");
        });
        const first = await parseFilename("Cache Recovery - 07.mkv");
        expect(first.parseMethod).toBe("regex");

        setPttImporterForTests(null);
        const second = await parseFilename("Cache Recovery - 07.mkv");

        expect(second.parseMethod).toBe("ptt");
    });

    it("falls back to the regex when PTT cannot load", async () => {
        setPttImporterForTests(async () => {
            throw new Error("cannot load");
        });

        const result = await parseFilename("Another Show - 06.mkv");

        expect(result.episode).toBe(6);
        expect(result.parseMethod).toBe("regex");
    });
});
