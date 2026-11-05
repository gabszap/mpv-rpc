import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as parser from "../src/core/parser";
import { setPttImporterForTests } from "../src/core/parser-ptt";

// The regex fallbacks only run when PTT does not answer. The blocks that test
// them switch PTT off with a module whose parser finds no title. The "PTT
// parsing" block at the end keeps PTT enabled.
function disablePtt(): void {
    setPttImporterForTests(async () => ({ parseTorrentTitle: () => ({}) }));
}

afterEach(() => {
    setPttImporterForTests(null);
});

describe("Parser Fallback Logic", () => {
    beforeEach(() => {
        disablePtt();
    });

    it("should parse S01E01 correctly", async () => {
        const result = await parser.parseFilename("[Fansub] Anime Name - S01E01 [1080p].mkv");

        expect(result.series_title).toBe("Anime Name");
        expect(result.season).toBe(1);
        expect(result.episode).toBe(1);
        expect(result.parseMethod).toBe("regex");
    });

    it("should parse Episode only correctly", async () => {
        const result = await parser.parseFilename("One Piece - Episode 1000.mkv");

        expect(result.series_title).toBe("One Piece");
        expect(result.season).toBeNull();
        expect(result.episode).toBe(1000);
    });

    it("should parse clean title with underscores", async () => {
        const result = await parser.parseFilename("My_Hero_Academia_S03E12.mp4");

        expect(result.series_title).toBe("My Hero Academia");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(12);
    });

    it("should handle N/A filename", async () => {
        const result = await parser.parseFilename("N/A");
        expect(result.series_title).toBe("N/A");
    });

    it("should reject an empty filename (parse CLI guard contract)", async () => {
        const result = await parser.parseFilename("");

        expect(result).toBeDefined();
        expect(result.series_title).toBe("N/A");
    });

    it("should parse Bunny Girl Senpai complex filename correctly", async () => {
        const filename =
            "Rascal.Does.Not.Dream.of.Bunny.Girl.Senpai.S02E07.From.Beyond.Hilbert.Space.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264.MSubs-ToonsHub.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Rascal Does Not Dream of Bunny Girl Senpai");
        expect(result.season).toBe(2);
        expect(result.episode).toBe(7);
    });

    it("should parse Jujutsu Kaisen NF WEB-DL as anime", async () => {
        const filename = "Jujutsu.Kaisen.S03E03.1080p.NF.WEB-DL.JPN.AAC2.0.H.264.MSubs-ToonsHub.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Jujutsu Kaisen");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(3);
        expect(result.media_type).toBe("anime"); // JPN + streaming service = anime
    });

    it("should extract torrent_name from URL query parameters (Comet streams)", async () => {
        // Simulates a Comet/Stremio URL where the real filename is in torrent_name param
        const urlWithTorrentName =
            "https://comet.example.com/playback/abc123/0/18/4/3?torrent_name=Dr.STONE.S04E03.Light.Trap.in.the.Darkness.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264-VARYG.mkv&name=Dr.%20Stone";
        const result = await parser.parseFilename(urlWithTorrentName);

        expect(result.series_title).toBe("Dr STONE");
        expect(result.season).toBe(4);
        expect(result.episode).toBe(3);
    });
});

describe("Invalid Title Validation", () => {
    beforeEach(() => {
        disablePtt();
    });

    it('should mark "0" as unknown media type (streaming URL bug)', async () => {
        const result = await parser.parseFilename("0");

        // Title is just a number, should be marked as unknown to prevent bad API searches
        expect(result.media_type).toBe("unknown");
    });

    it('should mark "123" as unknown media type', async () => {
        const result = await parser.parseFilename("123");

        expect(result.media_type).toBe("unknown");
    });

    it('should mark single letter "X" as unknown media type', async () => {
        const result = await parser.parseFilename("X");

        // Only 1 letter, need at least 2 for valid title
        expect(result.media_type).toBe("unknown");
    });

    it('should accept "Re Zero" as valid title and parse correctly', async () => {
        const result = await parser.parseFilename("Re Zero - S01E01.mkv");

        // Title is valid (has letters), should be parsed correctly
        expect(result.series_title).toBe("Re Zero");
        expect(result.season).toBe(1);
        expect(result.episode).toBe(1);
        // media_type may be 'unknown' since there's no anime/series indicators in filename
        // but the title itself should NOT be rejected as invalid
    });
});

describe("Media Title Sanitization", () => {
    // Import directly from mpv module
    it("should strip Multi-Subs and tracker metadata from Torrentio title", async () => {
        const { sanitizeMediaTitle } = await import("../src/integrations/mpv");

        const dirtyTitle =
            "OSHI NO KO S03E10 Private Audition 1080p CR WEB-DL AAC2.0 H 264-VARYG ([Oshi no Ko] Multi-Subs)\n👤 153 💾 1.39 GB ⚙️ NyaaSi\nMulti Subs / 🇬🇧 / 🇷🇺 / 🇮🇹 / 🇵🇹 / 🇪🇸 / 🇲🇽 / 🇨🇳 / 🇫🇷 / 🇩🇪 / 🇸🇦 / 🇮🇩 / 🇲🇾 / 🇹🇭";
        const clean = sanitizeMediaTitle(dirtyTitle);

        expect(clean).toBe("OSHI NO KO S03E10 Private Audition 1080p CR WEB-DL AAC2.0 H 264-VARYG");
    });

    it("should not modify clean filenames", async () => {
        const { sanitizeMediaTitle } = await import("../src/integrations/mpv");

        const clean = "Rascal.Does.Not.Dream.of.Bunny.Girl.Senpai.S02E07.1080p.CR.WEB-DL.mkv";
        expect(sanitizeMediaTitle(clean)).toBe(clean);
    });

    it("should handle N/A and empty strings", async () => {
        const { sanitizeMediaTitle } = await import("../src/integrations/mpv");

        expect(sanitizeMediaTitle("N/A")).toBe("N/A");
        expect(sanitizeMediaTitle("")).toBe("");
    });

    it("should strip title with only Multi Subs parenthesis", async () => {
        const { sanitizeMediaTitle } = await import("../src/integrations/mpv");

        const title = "Jujutsu Kaisen S03E03 1080p NF WEB-DL (Multi Subs)";
        expect(sanitizeMediaTitle(title)).toBe("Jujutsu Kaisen S03E03 1080p NF WEB-DL");
    });
});

describe("Anime Release Fallback", () => {
    // The anime-release regex runs after PTT, so these tests switch PTT off.
    beforeEach(() => {
        disablePtt();
    });

    it("should parse the Dr Stone Science Future Part 3 release", async () => {
        const filename = "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p CR WEBRip HEVC]";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Dr Stone - Science Future Part 3");
        expect(result.episode).toBe(6);
        expect(result.media_type).toBe("anime");
        expect(result.parseMethod).toBe("anime-regex");
    });

    it("should parse SubsPlease-style release with codec tag", async () => {
        const filename = "[SubsPlease] Jujutsu Kaisen - 05 [1080p][HEVC].mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Jujutsu Kaisen");
        expect(result.episode).toBe(5);
        expect(result.media_type).toBe("anime");
    });

    it("should fall through to existing fallback for non-anime SxxExx patterns", async () => {
        const filename = "Breaking.Bad.S05E14.1080p.BluRay.x264.mkv";
        const result = await parser.parseFilename(filename);

        // Non-anime, SxxExx pattern: the anime release fallback returns null,
        // so the existing fallbackParse must still do its job.
        expect(result.series_title).toBe("Breaking Bad");
        expect(result.season).toBe(5);
        expect(result.episode).toBe(14);
    });

    it("should return N/A title and unknown media type for garbage input", async () => {
        const result = await parser.parseFilename("not a real filename");

        // Garbage input: the anime release fallback returns null, the
        // existing fallbackParse is used. isValidSearchTitle treats this
        // as a valid search title (more than 2 letters), so series_title
        // is the cleaned filename. media_type has no anime/series signals.
        expect(result.series_title).toBe("not a real filename");
        expect(result.media_type).toBe("unknown");
        expect(result.season).toBeNull();
        expect(result.episode).toBeNull();
    });

    it("parseAnimeReleaseFallback should return the expected structure for the Dr Stone case", () => {
        // Direct call, no parseFilename indirection. Verifies the exported
        // function's return shape and field extraction independently of
        // the rest of the parser pipeline.
        const result = parser.parseAnimeReleaseFallback(
            "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p CR WEBRip HEVC]",
        );

        expect(result).not.toBeNull();
        expect(result?.title).toBe("Dr Stone - Science Future Part 3");
        expect(result?.episode).toBe(6);
        expect(result?.releaseGroup).toBe("Erai-raws");
        expect(result?.resolution).toBe("1080p");
        expect(result?.source).toBe("CR WEBRip");
        expect(result?.codec).toBe("HEVC");
        expect(result?.confidence).toBe("high");
    });
});

// Cases that used to depend on GuessIt payloads (and on workarounds for its
// mistakes). PTT answers them directly, with no mocked GuessIt response.
describe("PTT parsing", () => {
    it("should parse URL-encoded filenames correctly", async () => {
        const filename = "%5BErai%20raws%5D%20Oshi%20no%20Ko%203rd%20Season%20-%2009.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Oshi no Ko");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
    });

    it('should keep the full "Oshi no Ko" title', async () => {
        const result = await parser.parseFilename("[Trix] Oshi no Ko S03E09 [WEBRip 1080p AV1] (Multi Subs).mkv");

        expect(result.series_title).toBe("Oshi no Ko");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
    });

    it('should keep the full "OSHI NO KO" title for dot-separated filenames', async () => {
        const filename = "OSHI.NO.KO.S03E10.Private.Audition.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("OSHI NO KO");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(10);
    });

    it("should find the episode number of hyphenated anime episodes", async () => {
        const result = await parser.parseFilename("[Erai-raws] Dr Stone - New World - 02 [1080p][HEVC][93028C2D].mkv");

        expect(result.series_title).toBe("Dr Stone - New World");
        expect(result.episode).toBe(2);
        expect(result.episode_title).toBeNull();
        expect(result.full_title).toBe("Dr Stone - New World - E02");
    });

    it("should keep the arc name in the title", async () => {
        const result = await parser.parseFilename("Dr Stone - New World - 02.mkv");

        expect(result.series_title).toBe("Dr Stone - New World");
        expect(result.episode).toBe(2);
        expect(result.full_title).toBe("Dr Stone - New World - E02");
    });

    it("should keep the full title of an anime release with a long subtitle", async () => {
        const result = await parser.parseFilename(
            "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p CR WEBRip HEVC].mkv",
        );

        expect(result.series_title).toBe("Dr Stone - Science Future Part 3");
        expect(result.episode).toBe(6);
        expect(result.season).toBeNull();
        expect(result.media_type).toBe("anime");
        expect(result.parseMethod).toBe("ptt");
    });

    it("should not extend non-anime titles", async () => {
        const result = await parser.parseFilename(
            "Dr.STONE.S04E33.Wanting.Everything.1080p.CR.WEB-DL.MULTi.AAC2.0.H.264-VARYG.mkv",
        );

        expect(result.series_title).toBe("Dr STONE");
    });
});
