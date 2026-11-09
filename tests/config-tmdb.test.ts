import { afterEach, describe, expect, it, vi } from "vitest";

const originalKey = process.env.TMDB_API_KEY;
const originalLang = process.env.TMDB_LANG;

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}

describe("config tmdb settings", () => {
    afterEach(() => {
        restoreEnv("TMDB_API_KEY", originalKey);
        restoreEnv("TMDB_LANG", originalLang);
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("defaults to an empty key and en-US", async () => {
        delete process.env.TMDB_API_KEY;
        delete process.env.TMDB_LANG;

        const { config } = await import("../src/core/config");

        expect(config.tmdb.apiKey).toBe("");
        expect(config.tmdb.language).toBe("en-US");
    });

    it("reloadConfig reports a changed key and language", async () => {
        delete process.env.TMDB_API_KEY;
        delete process.env.TMDB_LANG;
        const { config, reloadConfig } = await import("../src/core/config");

        process.env.TMDB_API_KEY = "new-key";
        process.env.TMDB_LANG = "pt-BR";
        const changes = reloadConfig();

        expect(changes).toContain("TMDB_API_KEY changed");
        expect(changes).toContain("TMDB_LANG: en-US -> pt-BR");
        expect(config.tmdb.apiKey).toBe("new-key");
        expect(config.tmdb.language).toBe("pt-BR");
    });
});
