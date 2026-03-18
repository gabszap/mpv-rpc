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

    it('should parse Jujutsu Kaisen NF WEB-DL as anime', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = 'Jujutsu.Kaisen.S03E03.1080p.NF.WEB-DL.JPN.AAC2.0.H.264.MSubs-ToonsHub.mkv';
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe('Jujutsu Kaisen');
        expect(result.season).toBe(3);
        expect(result.episode).toBe(3);
        expect(result.media_type).toBe('anime'); // JPN + streaming service = anime
    });
    it('should parse URL-encoded filenames correctly', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const filename = '%5BErai%20raws%5D%20Oshi%20no%20Ko%203rd%20Season%20-%2009.mkv';
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe('Oshi no Ko');
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
    });

    it('should fix Guessit detecting "Ko" as Korean for "Oshi no Ko"', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            // Mock guessit returning "Oshi no" and language "Korean"
            const stdout = JSON.stringify({ title: "Oshi no", language: "Korean", season: 3, episode: 9 });
            if (callback) callback(null, stdout, "");
            return {} as any;
        });

        const filename = '[Trix] Oshi no Ko S03E09 [WEBRip 1080p AV1] (Multi Subs).mkv';
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe('Oshi no Ko');
        expect(result.season).toBe(3);
        expect(result.episode).toBe(9);
    });

    it('should fix "Ko" as Korean for dot-separated filenames (OSHI.NO.KO)', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            const stdout = JSON.stringify({ title: "OSHI NO", language: "Korean", season: 3, episode: 10 });
            if (callback) callback(null, stdout, "");
            return {} as any;
        });

        const filename = 'OSHI.NO.KO.S03E10.Private.Audition.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv';
        const result = await parser.parseFilename(filename);

        expect(result.series_title).toBe('OSHI NO KO');
        expect(result.season).toBe(3);
        expect(result.episode).toBe(10);
    });
});

describe('Invalid Title Validation', () => {
    it('should mark "0" as unknown media type (streaming URL bug)', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename('0');

        // Title is just a number, should be marked as unknown to prevent bad API searches
        expect(result.media_type).toBe('unknown');
    });

    it('should mark "123" as unknown media type', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename('123');

        expect(result.media_type).toBe('unknown');
    });

    it('should mark single letter "X" as unknown media type', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename('X');

        // Only 1 letter, need at least 2 for valid title
        expect(result.media_type).toBe('unknown');
    });

    it('should accept "Re Zero" as valid title and parse correctly', async () => {
        const execFileMock = vi.spyOn(child_process, 'execFile');
        execFileMock.mockImplementation((file, args, options, callback) => {
            if (callback) callback(new Error("Generic error"), "", "");
            return {} as any;
        });

        const result = await parser.parseFilename('Re Zero - S01E01.mkv');

        // Title is valid (has letters), should be parsed correctly
        expect(result.series_title).toBe('Re Zero');
        expect(result.season).toBe(1);
        expect(result.episode).toBe(1);
        // media_type may be 'unknown' since there's no anime/series indicators in filename
        // but the title itself should NOT be rejected as invalid
    });
});

describe('Media Title Sanitization', () => {
    // Import directly from mpv module
    it('should strip Multi-Subs and tracker metadata from Torrentio title', async () => {
        const { sanitizeMediaTitle } = await import('../src/mpv');

        const dirtyTitle = 'OSHI NO KO S03E10 Private Audition 1080p CR WEB-DL AAC2.0 H 264-VARYG ([Oshi no Ko] Multi-Subs)\n👤 153 💾 1.39 GB ⚙️ NyaaSi\nMulti Subs / 🇬🇧 / 🇷🇺 / 🇮🇹 / 🇵🇹 / 🇪🇸 / 🇲🇽 / 🇨🇳 / 🇫🇷 / 🇩🇪 / 🇸🇦 / 🇮🇩 / 🇲🇾 / 🇹🇭';
        const clean = sanitizeMediaTitle(dirtyTitle);

        expect(clean).toBe('OSHI NO KO S03E10 Private Audition 1080p CR WEB-DL AAC2.0 H 264-VARYG');
    });

    it('should not modify clean filenames', async () => {
        const { sanitizeMediaTitle } = await import('../src/mpv');

        const clean = 'Rascal.Does.Not.Dream.of.Bunny.Girl.Senpai.S02E07.1080p.CR.WEB-DL.mkv';
        expect(sanitizeMediaTitle(clean)).toBe(clean);
    });

    it('should handle N/A and empty strings', async () => {
        const { sanitizeMediaTitle } = await import('../src/mpv');

        expect(sanitizeMediaTitle('N/A')).toBe('N/A');
        expect(sanitizeMediaTitle('')).toBe('');
    });

    it('should strip title with only Multi Subs parenthesis', async () => {
        const { sanitizeMediaTitle } = await import('../src/mpv');

        const title = 'Jujutsu Kaisen S03E03 1080p NF WEB-DL (Multi Subs)';
        expect(sanitizeMediaTitle(title)).toBe('Jujutsu Kaisen S03E03 1080p NF WEB-DL');
    });
});
