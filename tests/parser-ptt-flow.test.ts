import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFilename } from "../src/core/parser";
import { setPttImporterForTests } from "../src/core/parser-ptt";

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
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

    it("rejects the PTT result when a marker exists but no episode was extracted", async () => {
        setPttImporterForTests(async () => ({ parseTorrentTitle: () => ({ title: "Algum Titulo" }) }));

        const result = await parseFilename("Algum Titulo - 05.mkv");

        expect(result.parseMethod).toBe("regex");
        expect(result.episode).toBe(5);
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

        expect(typeof result.series_title).toBe("string");
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it("decodes URL-encoded names before PTT", async () => {
        const result = await parseFilename("%5BErai%20raws%5D%20Oshi%20no%20Ko%203rd%20Season%20-%2009.mkv");

        expect(result.series_title).toBe("Oshi no Ko");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
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
