/**
 * Tests for Trakt sync episode resolution.
 *
 * These tests do NOT hit the real Trakt API. The pure helper
 * `mapSeasonEpisodeToAbsolute` is exercised directly with synthetic data;
 * `resolveEpisode` is exercised with the `./api` module mocked so
 * `getShowSeasons` returns a fake season list.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapSeasonEpisodeToAbsolute } from "../src/trakt-sync/sync";
import type { TraktEpisode, TraktSeasonEpisode, TraktShow } from "../src/trakt-sync/types";

// Mock the api module so getShowSeasons (and friends) can be controlled.
vi.mock("../src/trakt-sync/api", () => ({
    getShowSeasons: vi.fn(),
    lookupById: vi.fn(),
    searchByTitle: vi.fn(),
    normalizeTitle: (s: string) => s.toLowerCase(),
    scrobbleStart: vi.fn(),
    scrobblePause: vi.fn(),
    scrobbleStop: vi.fn(),
    getHistory: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEpisode(season: number, number: number, title?: string): TraktEpisode {
    return {
        season,
        number,
        title: title ?? `S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`,
        ids: {
            trakt: season * 1000 + number,
            slug: `ep-${season}-${number}`,
            imdb: `tt${season}${number}`,
        },
    };
}

function makeSeason(number: number, episodeCount: number): TraktSeasonEpisode {
    return {
        number,
        episodes: Array.from({ length: episodeCount }, (_, i) => makeEpisode(number, i + 1)),
    };
}

function makeShow(id: number, title: string): TraktShow {
    return {
        title,
        year: 2020,
        ids: { trakt: id, slug: `show-${id}` },
    };
}

// ---------------------------------------------------------------------------
// mapSeasonEpisodeToAbsolute
// ---------------------------------------------------------------------------

describe("mapSeasonEpisodeToAbsolute", () => {
    it("returns the cumulative absolute episode for the middle of a long show", () => {
        // 24 + 23 + 5 = 52 → S03E05 of a JJK-like layout
        const result = mapSeasonEpisodeToAbsolute({ season: 3, episode: 5 }, [
            { season: 1, episodeCount: 24 },
            { season: 2, episodeCount: 23 },
            { season: 3, episodeCount: 24 },
        ]);
        expect(result).not.toBeNull();
        expect(result?.absoluteEpisode).toBe(52);
    });

    it("returns the boundary case at the start of season 2", () => {
        const result = mapSeasonEpisodeToAbsolute({ season: 2, episode: 1 }, [{ season: 1, episodeCount: 12 }]);
        expect(result).toEqual({
            absoluteEpisode: 13,
            seasonEpisode: "S02E01",
        });
    });

    it("returns null when a previous season is missing", () => {
        // Season 2 is absent, so season 3 cannot be safely mapped
        const result = mapSeasonEpisodeToAbsolute({ season: 3, episode: 1 }, [{ season: 1, episodeCount: 12 }]);
        expect(result).toBeNull();
    });

    it("returns the first absolute episode when no prior seasons exist", () => {
        const result = mapSeasonEpisodeToAbsolute({ season: 1, episode: 1 }, []);
        expect(result).toEqual({
            absoluteEpisode: 1,
            seasonEpisode: "S01E01",
        });
    });

    it("sorts seasons internally and still returns the correct absolute", () => {
        const result = mapSeasonEpisodeToAbsolute({ season: 3, episode: 5 }, [
            { season: 3, episodeCount: 24 },
            { season: 1, episodeCount: 24 },
            { season: 2, episodeCount: 23 },
        ]);
        expect(result?.absoluteEpisode).toBe(52);
    });
});

// ---------------------------------------------------------------------------
// resolveEpisode integration
// ---------------------------------------------------------------------------

describe("resolveEpisode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("resolves S03E05 to the matching TraktEpisode in a 3-season show", async () => {
        // Re-import after resetModules so the in-memory season cache is fresh
        const localApi = await import("../src/trakt-sync/api");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(1, 24), makeSeason(2, 23), makeSeason(3, 24)]);

        const result = await localSync.resolveEpisode(makeShow(1, "Jujutsu Kaisen"), 3, 5);
        expect(result).not.toBeNull();
        expect(result?.season).toBe(3);
        expect(result?.number).toBe(5);
    });
});
