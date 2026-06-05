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

vi.mock("../src/config", () => ({
    config: {
        syncDryRun: true,
        trakt: {
            enabled: true,
            syncThreshold: 85,
        },
    },
}));

vi.mock("../src/trakt-sync/auth", () => ({
    isAuthenticated: vi.fn(),
}));

vi.mock("../src/stremio-sync/context", () => ({
    readStremioPlaybackContext: vi.fn(),
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

    it("ignores season 0 (specials) when mapping a regular season", () => {
        // Season 0 has 5 specials but does not shift the cumulative count.
        // Season 2 Episode 1 should land at absolute 13 (12 from S1 + 1).
        const result = mapSeasonEpisodeToAbsolute({ season: 2, episode: 1 }, [
            { season: 0, episodeCount: 5 },
            { season: 1, episodeCount: 12 },
        ]);
        expect(result).toEqual({
            absoluteEpisode: 13,
            seasonEpisode: "S02E01",
        });
    });

    it("returns null when a regular season between 1 and current is missing, even with season 0 present", () => {
        // Seasons 0, 1, 3 are present — season 2 is missing, so season 3
        // cannot be safely mapped even though specials are accounted for.
        const result = mapSeasonEpisodeToAbsolute({ season: 3, episode: 1 }, [
            { season: 0, episodeCount: 5 },
            { season: 1, episodeCount: 12 },
            { season: 3, episodeCount: 24 },
        ]);
        expect(result).toBeNull();
    });

    it("returns the current episode when only season 0 is present alongside no prior regular seasons", () => {
        // Season 0 doesn't count, so the first episode of season 1 is
        // absolute episode 1.
        const result = mapSeasonEpisodeToAbsolute({ season: 1, episode: 1 }, [{ season: 0, episodeCount: 5 }]);
        expect(result).toEqual({
            absoluteEpisode: 1,
            seasonEpisode: "S01E01",
        });
    });

    it("returns null when the target itself is in season 0", () => {
        // Specials are outside the main series; this helper isn't useful for them.
        const result = mapSeasonEpisodeToAbsolute({ season: 0, episode: 1 }, [
            { season: 0, episodeCount: 5 },
            { season: 1, episodeCount: 12 },
        ]);
        expect(result).toBeNull();
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

describe("tryScrobble canonical Stremio identity", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("uses canonical S04E30 from Stremio context instead of parser-local E06", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(1, "Dr. Stone") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(4, 30)]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt9679542",
            imdbId: "tt9679542",
            videoId: "tt9679542:4:30",
            name: "Dr. Stone",
            type: "series",
            season: 4,
            episode: 30,
            episodesInSeason: 30,
        });

        await localSync.tryScrobble({
            media_title: "[Erai-raws] Dr Stone - Science Future Part 3 - 06",
            series_title: "Dr. Stone",
            season: null,
            episode: 6,
            episode_title: null,
            filename: "[Erai-raws] Dr Stone - Science Future Part 3 - 06.mkv",
            pause: false,
            percent_pos: 10,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 62568,
            total_episodes: null,
            adjusted_episode: null,
            imdb_id: "tt9679542",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.getShowSeasons).toHaveBeenCalledWith(1);
        expect(localApi.scrobbleStart).toHaveBeenCalledWith(
            expect.objectContaining({ season: 4, number: 30 }),
            expect.anything(),
            10,
        );
    });

    it("uses deterministic split-part S04E30 without Stremio context", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(1, "Dr. Stone") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(4, 30)]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue(null);

        await localSync.tryScrobble({
            media_title: "[Erai-raws] Dr Stone - Science Future Part 3 - 06",
            series_title: "Dr. Stone: Science Future Part 3",
            season: null,
            episode: 6,
            episode_title: "Stone to Space",
            filename: "[Erai-raws] Dr Stone - Science Future Part 3 - 06.mkv",
            pause: false,
            percent_pos: 10,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 62568,
            total_episodes: 13,
            adjusted_episode: null,
            imdb_id: "tt9679542",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.scrobbleStart).toHaveBeenCalledWith(
            expect.objectContaining({ season: 4, number: 30 }),
            expect.anything(),
            10,
        );
    });

    it("uses explicit canonical filename position instead of MAL-local overflow episode", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(1, "Dr. Stone") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(4, 35)]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue(null);

        await localSync.tryScrobble({
            media_title: "Dr.STONE.S04E33.Wanting.Everything",
            series_title: "Dr. Stone",
            season: 4,
            episode: 9,
            episode_title: "Wanting Everything",
            filename: "Dr.STONE.S04E33.Wanting.Everything.mkv",
            pause: false,
            percent_pos: 79.5,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57592,
            total_episodes: 12,
            adjusted_episode: 9,
            imdb_id: "tt9679542",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.scrobbleStart).toHaveBeenCalledWith(
            expect.objectContaining({ season: 4, number: 33 }),
            expect.anything(),
            79.5,
        );
    });

    it("stops the active canonical scrobble when playback closes before the watched threshold", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(1, "Dr. Stone") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(4, 35)]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localApi.scrobbleStop).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue(null);

        await localSync.tryScrobble({
            media_title: "Dr.STONE.S04E33.Wanting.Everything",
            series_title: "Dr. Stone",
            season: 4,
            episode: 9,
            episode_title: "Wanting Everything",
            filename: "Dr.STONE.S04E33.Wanting.Everything.mkv",
            pause: false,
            percent_pos: 11,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57592,
            total_episodes: 12,
            adjusted_episode: 9,
            imdb_id: "tt9679542",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        await localSync.stopCurrentScrobble();

        expect(localApi.scrobbleStop).toHaveBeenCalledWith(
            expect.objectContaining({ season: 4, number: 33 }),
            expect.anything(),
            11,
        );
    });

    it("dedupes concurrent shutdown cleanup for an active low-progress scrobble", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(1, "Dr. Stone") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(4, 35)]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localApi.scrobbleStop).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue(null);

        await localSync.tryScrobble({
            media_title: "Dr.STONE.S04E33.Wanting.Everything",
            series_title: "Dr. Stone",
            season: 4,
            episode: 9,
            episode_title: "Wanting Everything",
            filename: "Dr.STONE.S04E33.Wanting.Everything.mkv",
            pause: false,
            percent_pos: 14,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57592,
            total_episodes: 12,
            adjusted_episode: 9,
            imdb_id: "tt9679542",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        await Promise.all([localSync.stopCurrentScrobble(), localSync.stopCurrentScrobble()]);

        expect(localApi.scrobbleStop).toHaveBeenCalledTimes(1);
        expect(localApi.scrobbleStop).toHaveBeenCalledWith(
            expect.objectContaining({ season: 4, number: 33 }),
            expect.anything(),
            14,
        );
    });
});
