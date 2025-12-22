import { describe, it, expect, vi } from 'vitest';
import * as parser from '../src/parser';
import * as child_process from 'child_process';

// Mock execFile to simulate GuessIt responses
vi.mock('node:child_process', async () => {
    return {
        execFile: vi.fn(),
    };
});

// Mock util.promisify since we use it in the source code
// However, since we mock execFile which is used by promisify, we might need a different approach
// Actually, let's test the fallback parser which is pure JS regex logic.
// Testing calling external CLI (GuessIt) is integration testing and requires mocking execFile which is tricky with promisify.
// Let's rely on the fallback parser tests which are robust enough for our unit testing purposes.

describe('Parser Fallback Logic', () => {
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

    it('should parse S01E01 correctly', async () => {
        // Mock failure of guessit to force fallback
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename('[Fansub] Anime Name - S01E01 [1080p].mkv');

        expect(result.series_title).toBe('Anime Name');
        expect(result.season).toBe(1);
        expect(result.episode).toBe(1);
    });

    it('should parse Episode only correctly', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename('One Piece - Episode 1000.mkv');

        expect(result.series_title).toBe('One Piece');
        expect(result.season).toBeNull();
        expect(result.episode).toBe(1000);
    });

    it('should parse clean title with underscores', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename('My_Hero_Academia_S03E12.mp4');

        expect(result.series_title).toBe('My Hero Academia');
        expect(result.season).toBe(3);
        expect(result.episode).toBe(12);
    });

    it('should handle N/A filename', async () => {
        const result = await parser.parseFilename('N/A');
        expect(result.series_title).toBe('N/A');
    });

    it('should parse Bunny Girl Senpai complex filename correctly', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = 'Rascal.Does.Not.Dream.of.Bunny.Girl.Senpai.S02E07.From.Beyond.Hilbert.Space.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264.MSubs-ToonsHub.mkv';
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe('Rascal Does Not Dream of Bunny Girl Senpai');
        expect(result.season).toBe(2);
        expect(result.episode).toBe(7);
    });
});
