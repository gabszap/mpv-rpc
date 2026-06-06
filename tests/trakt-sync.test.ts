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
    logTraktDiagnostic: vi.fn(),
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

function makeAbsoluteNumberedSeasonBucket(
    bucketSeason: number,
    firstEpisodeNumber: number,
    episodeCount: number,
    traktSeason = 1,
    summaryEpisodeCount?: number,
): TraktSeasonEpisode {
    return {
        number: bucketSeason,
        episode_count: summaryEpisodeCount,
        episodes: Array.from({ length: episodeCount }, (_, i) =>
            makeEpisode(traktSeason, firstEpisodeNumber + i, `Absolute ${firstEpisodeNumber + i}`),
        ),
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
        // 24 + 24 + 5 = 53 → S03E05 of a generic 24-episode-season layout
        const result = mapSeasonEpisodeToAbsolute({ season: 3, episode: 5 }, [
            { season: 1, episodeCount: 24 },
            { season: 2, episodeCount: 24 },
            { season: 3, episodeCount: 24 },
        ]);
        expect(result).not.toBeNull();
        expect(result?.absoluteEpisode).toBe(53);
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
            { season: 2, episodeCount: 24 },
        ]);
        expect(result?.absoluteEpisode).toBe(53);
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

    it("resolves direct nested S03E05 when the Trakt episode entry carries canonical season data", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localApi.getShowSeasons).mockResolvedValue([
            {
                number: 1,
                episodes: [makeEpisode(1, 1), makeEpisode(3, 5, "Fever")],
            },
        ]);

        const result = await localSync.resolveEpisode(makeShow(2, "Jujutsu Kaisen"), 3, 5);

        expect(result).toMatchObject({ season: 3, number: 5, title: "Fever" });
    });

    it("maps Jujutsu Kaisen canonical S03E05 to absolute episode 52 from actual episode lists", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localApi.getShowSeasons).mockResolvedValue([
            makeAbsoluteNumberedSeasonBucket(1, 1, 24),
            makeAbsoluteNumberedSeasonBucket(2, 25, 23, 1, 24),
            makeAbsoluteNumberedSeasonBucket(3, 48, 24),
        ]);

        const result = await localSync.resolveEpisode(makeShow(3, "Jujutsu Kaisen"), 3, 5);

        expect(result).toMatchObject({ season: 1, number: 52, title: "Absolute 52" });
        expect(localApi.logTraktDiagnostic).toHaveBeenCalledWith(
            "[Trakt] Cumulative episode match: S03E05 → absolute ep 52 → S01E52",
        );
    });

    it("maps Jujutsu Kaisen canonical S03E06 to absolute episode 53 from actual episode lists", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localApi.getShowSeasons).mockResolvedValue([
            makeAbsoluteNumberedSeasonBucket(1, 1, 24),
            makeAbsoluteNumberedSeasonBucket(2, 25, 23, 1, 24),
            makeAbsoluteNumberedSeasonBucket(3, 48, 24),
        ]);

        const result = await localSync.resolveEpisode(makeShow(6, "Jujutsu Kaisen"), 3, 6);

        expect(result).toMatchObject({ season: 1, number: 53, title: "Absolute 53" });
    });

    it("maps Jujutsu Kaisen canonical S03E05 to absolute episode 52 in one continuous Trakt season", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(1, 80)]);

        const result = await localSync.resolveEpisode(makeShow(5, "Jujutsu Kaisen"), 3, 5);

        expect(result).toMatchObject({ season: 1, number: 52 });
    });

    it("does not map canonical S03E05 when prior season data is missing", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localApi.getShowSeasons).mockResolvedValue([
            makeAbsoluteNumberedSeasonBucket(1, 1, 24),
            makeAbsoluteNumberedSeasonBucket(3, 49, 24),
        ]);

        const result = await localSync.resolveEpisode(makeShow(4, "Jujutsu Kaisen"), 3, 5);

        expect(result).toBeNull();
    });

    it("does not treat parser-only S03E05 as absolute episode 5 when direct S03E05 is absent", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(1, 100)]);

        const result = await localSync.resolveEpisode(makeShow(2, "Jujutsu Kaisen"), 3, 5, {
            allowKnownAbsoluteSeasonMapping: false,
        });

        expect(result).toBeNull();
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

    it("uses Jujutsu Kaisen bridge canonical S03E05 instead of parser-local S01E05", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(2, "Jujutsu Kaisen") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(1, 24), makeSeason(2, 23), makeSeason(3, 24)]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "mal:57658",
            seriesId: "mal:57658",
            imdbId: "tt12343534",
            videoId: "tt12343534:3:5",
            name: "Jujutsu Kaisen",
            type: "series",
            season: 3,
            episode: 5,
            episodesInSeason: null,
        });

        await localSync.tryScrobble({
            media_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - E05",
            series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
            season: null,
            episode: 5,
            episode_title: "Fever",
            filename:
                "[Erai-raws] Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - 05 [1080p CR WEB-DL AVC AAC][MultiSub][FDCB43F3].mkv",
            pause: false,
            percent_pos: 24,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57658,
            total_episodes: null,
            adjusted_episode: null,
            imdb_id: "tt12343534",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.scrobbleStart).toHaveBeenCalledWith(
            expect.objectContaining({ season: 3, number: 5 }),
            expect.anything(),
            24,
        );
        expect(localApi.scrobbleStart).not.toHaveBeenCalledWith(
            expect.objectContaining({ season: 1, number: 5 }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("scrobbles Jujutsu Kaisen bridge canonical S03E05 as Trakt absolute episode 52", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(2, "Jujutsu Kaisen") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([
            makeAbsoluteNumberedSeasonBucket(1, 1, 24),
            makeAbsoluteNumberedSeasonBucket(2, 25, 23, 1, 24),
            makeAbsoluteNumberedSeasonBucket(3, 48, 24),
        ]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "mal:57658",
            seriesId: "mal:57658",
            imdbId: "tt12343534",
            videoId: "tt12343534:3:5",
            name: "Jujutsu Kaisen",
            type: "series",
            season: 3,
            episode: 5,
            episodesInSeason: null,
        });

        await localSync.tryScrobble({
            media_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - E05",
            series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
            season: null,
            episode: 5,
            episode_title: "Fever",
            filename:
                "[Erai-raws] Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - 05 [1080p CR WEB-DL AVC AAC][MultiSub][FDCB43F3].mkv",
            pause: false,
            percent_pos: 24,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57658,
            total_episodes: null,
            adjusted_episode: null,
            imdb_id: "tt12343534",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.scrobbleStart).toHaveBeenCalledWith(
            expect.objectContaining({ season: 1, number: 52, title: "Absolute 52" }),
            expect.anything(),
            24,
        );
        expect(localApi.scrobbleStart).not.toHaveBeenCalledWith(
            expect.objectContaining({ season: 1, number: 5 }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("scrobbles Jujutsu Kaisen bridge canonical S03E05 as absolute episode 52 in one Trakt season", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(2, "Jujutsu Kaisen") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(1, 80)]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "mal:57658",
            seriesId: "mal:57658",
            imdbId: "tt12343534",
            videoId: "tt12343534:3:5",
            name: "Jujutsu Kaisen",
            type: "series",
            season: 3,
            episode: 5,
            episodesInSeason: null,
        });

        await localSync.tryScrobble({
            media_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - E05",
            series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
            season: null,
            episode: 5,
            episode_title: "Fever",
            filename:
                "[Erai-raws] Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - 05 [1080p CR WEB-DL AVC AAC][MultiSub][FDCB43F3].mkv",
            pause: false,
            percent_pos: 24,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57658,
            total_episodes: null,
            adjusted_episode: null,
            imdb_id: "tt12343534",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.scrobbleStart).toHaveBeenCalledWith(
            expect.objectContaining({ season: 1, number: 52 }),
            expect.anything(),
            24,
        );
        expect(localApi.scrobbleStart).not.toHaveBeenCalledWith(
            expect.objectContaining({ season: 1, number: 5 }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("scrobbles Jujutsu Kaisen bridge canonical S03E05 from direct nested Trakt season data", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(2, "Jujutsu Kaisen") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([
            {
                number: 1,
                episodes: [makeEpisode(1, 1), makeEpisode(3, 5, "Fever")],
            },
        ]);
        vi.mocked(localApi.getHistory).mockResolvedValue([]);
        vi.mocked(localApi.scrobbleStart).mockResolvedValue(true);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "mal:57658",
            seriesId: "mal:57658",
            imdbId: "tt12343534",
            videoId: "tt12343534:3:5",
            name: "Jujutsu Kaisen",
            type: "series",
            season: 3,
            episode: 5,
            episodesInSeason: null,
        });

        await localSync.tryScrobble({
            media_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - Fever",
            series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
            season: null,
            episode: 5,
            episode_title: "Fever",
            filename:
                "[Erai-raws] Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - 05 [1080p CR WEB-DL AVC AAC][MultiSub][FDCB43F3].mkv",
            pause: false,
            percent_pos: 24,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57658,
            total_episodes: null,
            adjusted_episode: null,
            imdb_id: "tt12343534",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.scrobbleStart).toHaveBeenCalledWith(
            expect.objectContaining({ season: 3, number: 5, title: "Fever" }),
            expect.anything(),
            24,
        );
    });

    it("does not scrobble unsafe parser-only S03E05 as Trakt S01E05", async () => {
        const localApi = await import("../src/trakt-sync/api");
        const localAuth = await import("../src/trakt-sync/auth");
        const localContext = await import("../src/stremio-sync/context");
        const localSync = await import("../src/trakt-sync/sync");

        vi.mocked(localAuth.isAuthenticated).mockReturnValue(true);
        vi.mocked(localApi.lookupById).mockResolvedValue({ show: makeShow(2, "Jujutsu Kaisen") });
        vi.mocked(localApi.getShowSeasons).mockResolvedValue([makeSeason(1, 100)]);
        vi.mocked(localContext.readStremioPlaybackContext).mockReturnValue(null);

        await localSync.tryScrobble({
            media_title: "Jujutsu Kaisen S03E05",
            series_title: "Jujutsu Kaisen",
            season: 3,
            episode: 5,
            episode_title: "Fever",
            filename: "Jujutsu.Kaisen.S03E05.mkv",
            pause: false,
            percent_pos: 24,
            time_pos: 120,
            duration: 1200,
            artist: "N/A",
            cover_image: null,
            mal_id: 57658,
            total_episodes: null,
            adjusted_episode: null,
            imdb_id: "tt12343534",
            type: "series",
            playlistPos: 0,
            playlistCount: 1,
        });

        expect(localApi.scrobbleStart).not.toHaveBeenCalled();
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
