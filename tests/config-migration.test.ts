import { describe, expect, it } from "vitest";
import {
    CURRENT_CONFIG_VERSION,
    inferIconMode,
    migrateBridgeConfig,
    migrateV1ToV2,
} from "../src/core/bridge-config-migration";

describe("bridge-config-migration", () => {
    describe("CURRENT_CONFIG_VERSION", () => {
        it("is 2", () => {
            expect(CURRENT_CONFIG_VERSION).toBe(2);
        });
    });

    describe("migrateV1ToV2", () => {
        it("returns a fresh default v2 config when given an empty object", () => {
            expect(migrateV1ToV2({})).toEqual({
                configVersion: 2,
                autoFetch: { enabled: true },
                extraEpisodes: 2,
                iconMode: "default",
            });
        });

        it("preserves autoFetchEnabled: false as autoFetch.enabled = false", () => {
            const result = migrateV1ToV2({ autoFetchEnabled: false });
            expect(result.autoFetch).toEqual({ enabled: false });
        });

        it("infers iconMode 'disabled' when both icons are hidden", () => {
            const result = migrateV1ToV2({ showMpvIcon: false, showConfigIcon: false });
            expect(result.iconMode).toBe("disabled");
        });

        it("infers iconMode 'config-only' when only the config icon is shown", () => {
            const result = migrateV1ToV2({ showMpvIcon: false, showConfigIcon: true });
            expect(result.iconMode).toBe("config-only");
        });

        it("infers iconMode 'compact' when config icon is shown and compact mode is on", () => {
            const result = migrateV1ToV2({ showMpvIcon: false, showConfigIcon: true, compactMode: true });
            expect(result.iconMode).toBe("compact");
        });

        it("infers iconMode 'compact' from compactMode alone", () => {
            const result = migrateV1ToV2({ compactMode: true });
            expect(result.iconMode).toBe("compact");
        });

        it("preserves an explicit extraEpisodes value", () => {
            const result = migrateV1ToV2({ extraEpisodes: 5 });
            expect(result.extraEpisodes).toBe(5);
        });

        it("preserves unrelated fields like stremioMeta", () => {
            const stremioMeta = { imdbId: "tt1234567", name: "Test", season: 1, episode: 1 };
            const result = migrateV1ToV2({ stremioMeta });
            expect(result.stremioMeta).toEqual(stremioMeta);
        });
    });

    describe("migrateBridgeConfig (top-level entry point)", () => {
        it("returns the same object when configVersion is already 2", () => {
            const v2 = {
                configVersion: 2,
                autoFetch: { enabled: true },
                extraEpisodes: 2,
                iconMode: "default",
            };
            expect(migrateBridgeConfig(v2)).toBe(v2);
        });

        it("returns fresh v2 defaults for null", () => {
            expect(migrateBridgeConfig(null)).toEqual({
                configVersion: 2,
                autoFetch: { enabled: true },
                extraEpisodes: 2,
                iconMode: "default",
            });
        });

        it("returns fresh v2 defaults for an array (arrays are not configs)", () => {
            expect(migrateBridgeConfig([])).toEqual({
                configVersion: 2,
                autoFetch: { enabled: true },
                extraEpisodes: 2,
                iconMode: "default",
            });
        });
    });

    describe("inferIconMode (direct)", () => {
        it("returns 'default' for undefined", () => {
            expect(inferIconMode(undefined)).toBe("default");
        });

        it("returns 'default' for an empty object", () => {
            expect(inferIconMode({})).toBe("default");
        });

        it("returns 'default' when showMpvIcon is true (no other flags)", () => {
            expect(inferIconMode({ showMpvIcon: true })).toBe("default");
        });
    });
});
