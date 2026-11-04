import * as child_process from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as parser from "../src/parser";

// Mock execFile to simulate GuessIt responses
vi.mock("node:child_process", async () => {
    return {
        execFile: vi.fn(),
    };
});

// Mock axios so tests can control the GuessIt HTTP API path.
// By default `post` rejects (so tests get the same null behavior as
// when the API is unreachable). Tests that need a real GuessIt call
// can override `axios.post` per-test with vi.mocked(axios.post).
vi.mock("axios", async () => {
    const post = vi.fn().mockRejectedValue(new Error("GuessIt API mocked to fail by default"));
    return {
        default: { post },
        post,
    };
});

// Mock util.promisify since we use it in the source code
// However, since we mock execFile which is used by promisify, we might need a different approach
// Actually, let's test the fallback parser which is pure JS regex logic.
// Testing calling external CLI (GuessIt) is integration testing and requires mocking execFile which is tricky with promisify.
// Let's rely on the fallback parser tests which are robust enough for our unit testing purposes.

describe("Parser Fallback Logic", () => {
    // The GuessIt HTTP API is mocked globally to reject. Reset the
    // mock before every test in this block so per-test overrides
    // (vi.mocked(axios.post).mockResolvedValue(...)) don't leak
    // into later tests and pollute the parseCache.
    beforeEach(async () => {
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockReset();
        vi.mocked(axios.default.post).mockRejectedValue(new Error("GuessIt API mocked to fail by default"));
    });

    // We can't easily export the non-exported fallbackParse from the module directly
    // unless we export it or use rewind.
    // However, if we force "GuessIt" to fail (by mocking it to throw or return null),
    // parseFilename will naturally use the fallback.

    // We can mock the internal "callGuessIt" effectively by mocking what execFile returns
    // OR we can make a testable version of `parseFilename` that skips `callGuessIt` if we wanted.
    // But better yet, let's just make sure "checkAvailability" returns false or fails so it falls back.
    // Wait, the code tries `callGuessIt` first. If `callGuessIt` returns null, it uses fallback.

    // So if we mock `execFile` to fail, `callGuessIt` catches error and returns null.
    // Then `fallbackParse` is used. This is what we want to test.

    it("should parse S01E01 correctly", async () => {
        // Mock failure of guessit to force fallback
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename("[Fansub] Anime Name - S01E01 [1080p].mkv");

        expect(result.series_title).toBe("Anime Name");
        expect(result.season).toBe(1);
        expect(result.episode).toBe(1);
    });

    it("should parse Episode only correctly", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename("One Piece - Episode 1000.mkv");

        expect(result.series_title).toBe("One Piece");
        expect(result.season).toBeNull();
        expect(result.episode).toBe(1000);
    });

    it("should parse clean title with underscores", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename("My_Hero_Academia_S03E12.mp4");

        expect(result.series_title).toBe("My Hero Academia");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(12);
    });

    it("should handle N/A filename", async () => {
        const result = await parser.parseFilename("N/A");
        expect(result.series_title).toBe("N/A");
    });

    it("should parse Bunny Girl Senpai complex filename correctly", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename =
            "Rascal.Does.Not.Dream.of.Bunny.Girl.Senpai.S02E07.From.Beyond.Hilbert.Space.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264.MSubs-ToonsHub.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Rascal Does Not Dream of Bunny Girl Senpai");
        expect(result.season).toBe(2);
        expect(result.episode).toBe(7);
    });

    it("should parse Jujutsu Kaisen NF WEB-DL as anime", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = "Jujutsu.Kaisen.S03E03.1080p.NF.WEB-DL.JPN.AAC2.0.H.264.MSubs-ToonsHub.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Jujutsu Kaisen");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(3);
        expect(result.media_type).toBe("anime"); // JPN + streaming service = anime
    });
    it("should parse URL-encoded filenames correctly", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        // The HTTP GuessIt API is mocked globally to fail. This test
        // exercises the URL-decode + GuessIt pipeline, so we need the
        // API to return a realistic GuessIt payload here.
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockResolvedValue({
            data: { title: "Oshi no Ko", season: 3, episode: 9 },
        } as any);

        const filename = "%5BErai%20raws%5D%20Oshi%20no%20Ko%203rd%20Season%20-%2009.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Oshi no Ko");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
    });

    it('should fix Guessit detecting "Ko" as Korean for "Oshi no Ko"', async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            // Mock guessit returning "Oshi no" and language "Korean"
            const stdout = JSON.stringify({ title: "Oshi no", language: "Korean", season: 3, episode: 9 });
            if (callback) callback(null, stdout, "");
            return {} as any;
        });

        // The HTTP GuessIt API is mocked globally to fail. Route this
        // test through the API so processGuessitResult sees the
        // "language: Korean" payload that drives the Oshi-no-Ko fix.
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockResolvedValue({
            data: { title: "Oshi no", language: "Korean", season: 3, episode: 9 },
        } as any);

        const filename = "[Trix] Oshi no Ko S03E09 [WEBRip 1080p AV1] (Multi Subs).mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Oshi no Ko");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
    });

    it('should fix "Ko" as Korean for dot-separated filenames (OSHI.NO.KO)', async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            const stdout = JSON.stringify({ title: "OSHI NO", language: "Korean", season: 3, episode: 10 });
            if (callback) callback(null, stdout, "");
            return {} as any;
        });

        // The HTTP GuessIt API is mocked globally to fail. Route this
        // test through the API so processGuessitResult sees the
        // "language: Korean" payload that drives the Oshi-no-Ko fix.
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockResolvedValue({
            data: { title: "OSHI NO", language: "Korean", season: 3, episode: 10 },
        } as any);

        const filename = "OSHI.NO.KO.S03E10.Private.Audition.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("OSHI NO KO");
        expect(result.season).toBe(3);
        expect(result.episode).toBe(10);
    });

    it("should recover episode number when GuessIt misses hyphenated anime episodes", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            const stdout = JSON.stringify({ title: "Dr Stone", episode_title: "New World" });
            if (callback) callback(null, stdout, "");
            return {} as any;
        });

        // The HTTP GuessIt API is mocked globally to fail. Route this
        // test through the API so processGuessitResult is exercised
        // with the partial GuessIt payload (title + episode_title only).
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockResolvedValue({
            data: { title: "Dr Stone", episode_title: "New World" },
        } as any);

        const filename = "[Erai-raws] Dr Stone - New World - 02 [1080p][HEVC][93028C2D].mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Dr Stone - New World");
        expect(result.episode).toBe(2);
        expect(result.episode_title).toBeNull();
        expect(result.full_title).toBe("Dr Stone - New World - E02");
    });

    it("should extract torrent_name from URL query parameters (Comet streams)", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        // Simulates a Comet/Stremio URL where the real filename is in torrent_name param
        const urlWithTorrentName =
            "https://comet.example.com/playback/abc123/0/18/4/3?torrent_name=Dr.STONE.S04E03.Light.Trap.in.the.Darkness.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264-VARYG.mkv&name=Dr.%20Stone";
        const result = await parser.parseFilename(urlWithTorrentName);

        expect(result.series_title).toBe("Dr STONE");
        expect(result.season).toBe(4);
        expect(result.episode).toBe(3);
    });

    it("should combine alternative_title when GuessIt splits season name", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            const stdout = JSON.stringify({
                title: "Dr Stone",
                alternative_title: "New World",
                episode: 2,
            });
            if (callback) callback(null, stdout, "");
            return {} as any;
        });

        const filename = "Dr Stone - New World - 02.mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Dr Stone - New World");
        expect(result.episode).toBe(2);
        expect(result.full_title).toBe("Dr Stone - New World - E02");
    });
});

describe("Invalid Title Validation", () => {
    beforeEach(async () => {
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockReset();
        vi.mocked(axios.default.post).mockRejectedValue(new Error("GuessIt API mocked to fail by default"));
    });

    it('should mark "0" as unknown media type (streaming URL bug)', async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename("0");

        // Title is just a number, should be marked as unknown to prevent bad API searches
        expect(result.media_type).toBe("unknown");
    });

    it('should mark "123" as unknown media type', async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename("123");

        expect(result.media_type).toBe("unknown");
    });

    it('should mark single letter "X" as unknown media type', async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename("X");

        // Only 1 letter, need at least 2 for valid title
        expect(result.media_type).toBe("unknown");
    });

    it('should accept "Re Zero" as valid title and parse correctly', async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

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
        const { sanitizeMediaTitle } = await import("../src/mpv");

        const dirtyTitle =
            "OSHI NO KO S03E10 Private Audition 1080p CR WEB-DL AAC2.0 H 264-VARYG ([Oshi no Ko] Multi-Subs)\n👤 153 💾 1.39 GB ⚙️ NyaaSi\nMulti Subs / 🇬🇧 / 🇷🇺 / 🇮🇹 / 🇵🇹 / 🇪🇸 / 🇲🇽 / 🇨🇳 / 🇫🇷 / 🇩🇪 / 🇸🇦 / 🇮🇩 / 🇲🇾 / 🇹🇭";
        const clean = sanitizeMediaTitle(dirtyTitle);

        expect(clean).toBe("OSHI NO KO S03E10 Private Audition 1080p CR WEB-DL AAC2.0 H 264-VARYG");
    });

    it("should not modify clean filenames", async () => {
        const { sanitizeMediaTitle } = await import("../src/mpv");

        const clean = "Rascal.Does.Not.Dream.of.Bunny.Girl.Senpai.S02E07.1080p.CR.WEB-DL.mkv";
        expect(sanitizeMediaTitle(clean)).toBe(clean);
    });

    it("should handle N/A and empty strings", async () => {
        const { sanitizeMediaTitle } = await import("../src/mpv");

        expect(sanitizeMediaTitle("N/A")).toBe("N/A");
        expect(sanitizeMediaTitle("")).toBe("");
    });

    it("should strip title with only Multi Subs parenthesis", async () => {
        const { sanitizeMediaTitle } = await import("../src/mpv");

        const title = "Jujutsu Kaisen S03E03 1080p NF WEB-DL (Multi Subs)";
        expect(sanitizeMediaTitle(title)).toBe("Jujutsu Kaisen S03E03 1080p NF WEB-DL");
    });
});

describe("Anime Release Fallback", () => {
    // The anime-release fallback sits AFTER GuessIt in the parseFilename
    // pipeline, so each of these tests must make BOTH GuessIt paths
    // (HTTP API and CLI) fail before the new fallback is exercised.
    // The CLI is mocked via vi.spyOn on child_process.execFile (same
    // pattern as the other test blocks). The HTTP API is mocked here
    // locally with vi.mocked to keep this block self-contained and to
    // avoid disrupting tests that depend on a real GuessIt API call.
    beforeEach(async () => {
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockRejectedValue(new Error("GuessIt API disabled in test"));
    });

    it("should parse the Dr Stone Science Future Part 3 release", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p CR WEBRip HEVC]";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Dr Stone - Science Future Part 3");
        expect(result.episode).toBe(6);
        expect(result.media_type).toBe("anime");
    });

    it("should parse SubsPlease-style release with codec tag", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = "[SubsPlease] Jujutsu Kaisen - 05 [1080p][HEVC].mkv";
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe("Jujutsu Kaisen");
        expect(result.episode).toBe(5);
        expect(result.media_type).toBe("anime");
    });

    it("should fall through to existing fallback for non-anime SxxExx patterns", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = "Breaking.Bad.S05E14.1080p.BluRay.x264.mkv";
        const result = await parser.parseFilename(filename);

        // Non-anime, SxxExx pattern: the anime release fallback returns null,
        // so the existing fallbackParse must still do its job.
        expect(result.series_title).toBe("Breaking Bad");
        expect(result.season).toBe(5);
        expect(result.episode).toBe(14);
    });

    it("should return N/A title and unknown media type for garbage input", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

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

    it("recovers full title from anime regex when GuessIt returns truncated title", async () => {
        // The default beforeEach in this block rejects the GuessIt API; override
        // it so processGuessitResult sees a partial (truncated) GuessIt payload.
        // This is the user-reported bug: GuessIt returns {title:"Dr Stone",
        // episode:6, release_group:"Erai-raws"} and the parser used to stop
        // there instead of consulting the anime regex fallback.
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockResolvedValue({
            data: {
                title: "Dr Stone",
                episode: 6,
                release_group: "Erai-raws",
                source: "CR WEBRip",
            },
        } as any);

        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename(
            "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p CR WEBRip HEVC]",
        );

        expect(result.series_title).toBe("Dr Stone - Science Future Part 3");
        expect(result.episode).toBe(6);
        expect(result.season).toBeNull();
        expect(result.media_type).toBe("anime");
    });

    it("does not extend non-anime titles when GuessIt returns a clean result", async () => {
        // Override the default beforeEach: GuessIt API returns a real payload
        // for a non-anime SxxExx release. The post-processor must not touch
        // the title because the anime regex won't match this shape.
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockResolvedValue({
            data: {
                title: "Dr STONE",
                season: 4,
                episode: 33,
                episode_title: "Wanting Everything",
            },
        } as any);

        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename(
            "Dr.STONE.S04E33.Wanting.Everything.1080p.CR.WEB-DL.MULTi.AAC2.0.H.264-VARYG.mkv",
        );

        // Title should remain "Dr STONE" (not extended by anime regex)
        expect(result.series_title).toBe("Dr STONE");
    });
});
