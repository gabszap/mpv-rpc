import * as child_process from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseFilename } from "../src/parser";

// The CLI subcommand (`npm start -- parse "<filename>"`) lives in
// `src/index.ts` and is best exercised end-to-end. The pragmatic
// unit-level guarantee is to test the underlying `parseFilename`
// function with the same canonical filenames the CLI would receive.
// We mock GuessIt at the network boundary so the test stays offline
// and deterministic across environments.

// Mock execFile to force the local fallback pipeline (no GuessIt CLI).
vi.mock("node:child_process", async () => {
    return {
        execFile: vi.fn(),
    };
});

// Mock axios so the HTTP GuessIt API path is unavailable. Tests can
// override this per-test if they need to drive the API path.
vi.mock("axios", async () => {
    const post = vi.fn().mockRejectedValue(new Error("GuessIt API mocked to fail by default"));
    return {
        default: { post },
        post,
    };
});

describe("Parser CLI Subcommand (parseFilename contract)", () => {
    // Reset axios mock before each test so per-test overrides don't leak
    // into later tests via the internal parseCache.
    beforeEach(async () => {
        const axios = await import("axios");
        vi.mocked(axios.default.post).mockReset();
        vi.mocked(axios.default.post).mockRejectedValue(new Error("GuessIt API mocked to fail by default"));
    });

    it("should parse a well-formed anime release (SubsPlease Jujutsu Kaisen)", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = "[SubsPlease] Jujutsu Kaisen - 05 [1080p][HEVC].mkv";
        const result = await parseFilename(filename);

        expect(result.episode).toBe(5);
        expect(result.series_title).toBe("Jujutsu Kaisen");
    });

    it("should parse a non-anime SxxExx release via the fallback parser (Breaking Bad)", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = "Breaking.Bad.S05E14.1080p.BluRay.x264.mkv";
        const result = await parseFilename(filename);

        expect(result.episode).toBe(14);
        // The SxxExx fallback replaces dots with spaces, so the cleaned
        // title is "Breaking Bad". Using a substring check guards against
        // minor cleanTitle changes (e.g. trailing whitespace).
        expect(result.series_title).toContain("Breaking Bad");
    });

    it("should parse the Dr Stone Science Future Part 3 release via the anime release fallback", async () => {
        const execFileMock = vi.spyOn(child_process, "execFile");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p CR WEBRip HEVC]";
        const result = await parseFilename(filename);

        expect(result.episode).toBe(6);
        expect(result.series_title).toBe("Dr Stone - Science Future Part 3");
    });

    it("should reject an empty filename argument (CLI guard contract)", async () => {
        // The CLI guard lives in src/index.ts and exits before calling
        // parseFilename. Here we only assert the contract that the
        // CLI relies on: parseFilename must not throw on empty input
        // (the CLI guard is the one that handles the missing argument).
        const result = await parseFilename("");
        expect(result).toBeDefined();
        expect(result.series_title).toBe("N/A");
    });
});
