import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MpvData } from "../src/mpv";
import * as api from "../src/stremio-sync/api";
import * as auth from "../src/stremio-sync/auth";
import { encodeWatched } from "../src/stremio-sync/bitset";
import * as context from "../src/stremio-sync/context";
import * as meta from "../src/stremio-sync/meta";
import { resetStremioSyncStateForTests, trySyncStremio } from "../src/stremio-sync/sync";

vi.mock("../src/config", () => ({
    config: {
        stremio: {
            enabled: true,
            syncThreshold: 85,
            progressIntervalMs: 30000,
        },
    },
}));

vi.mock("../src/stremio-sync/api", () => ({
    getLibraryItem: vi.fn(),
    putLibraryItem: vi.fn(),
    nowTimestamp: () => "2026-05-11T20:00:00.000-04:00",
}));

vi.mock("../src/stremio-sync/auth", () => ({
    getStremioAuthKey: vi.fn(),
}));

vi.mock("../src/stremio-sync/context", () => ({
    readStremioPlaybackContext: vi.fn(),
}));

vi.mock("../src/stremio-sync/meta", () => ({
    fetchVideoIds: vi.fn(),
}));

function createMpvData(overrides: Partial<MpvData> = {}): MpvData {
    return {
        media_title: "Example",
        series_title: "Example",
        season: 1,
        episode: 2,
        episode_title: null,
        filename: "Example S01E02.mkv",
        pause: false,
        percent_pos: 50,
        time_pos: 123,
        duration: 1500,
        artist: "",
        cover_image: null,
        mal_id: null,
        total_episodes: null,
        adjusted_episode: null,
        playlistPos: 0,
        playlistCount: 1,
        ...overrides,
    };
}

describe("Stremio sync MVP", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetStremioSyncStateForTests();
        vi.mocked(auth.getStremioAuthKey).mockReturnValue("auth-key");
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt1234567",
            imdbId: "tt1234567",
            videoId: "tt1234567:1:2",
            name: "Example",
            type: "series",
            season: 1,
            episode: 2,
            episodesInSeason: 12,
        });
        vi.mocked(meta.fetchVideoIds).mockResolvedValue(null);
        vi.mocked(api.getLibraryItem).mockResolvedValue({
            _id: "tt1234567",
            _mtime: "2026-03-15T10:00:00.000Z",
            state: {
                timeWatched: 111,
                overallTimeWatched: 222,
                timesWatched: 3,
                flaggedWatched: 1,
                watched: "existing-watched",
            },
        });
        vi.mocked(api.putLibraryItem).mockResolvedValue();
    });

    it("skips when auth is missing", async () => {
        vi.mocked(auth.getStremioAuthKey).mockReturnValue(null);

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({ status: "skipped", reason: "missing-auth" });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
    });

    it("skips when context is missing or invalid", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue(null);

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "skipped",
            reason: "missing-or-invalid-context",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
    });

    it("treats empty datastoreGet as a controlled skip", async () => {
        vi.mocked(api.getLibraryItem).mockResolvedValue(null);

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "skipped",
            reason: "library-item-not-found",
        });
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("syncs Continue Watching below the future watched threshold", async () => {
        await expect(trySyncStremio(createMpvData({ percent_pos: 10 }))).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        expect(api.putLibraryItem).toHaveBeenCalledTimes(1);
    });

    it("returns a controlled interval skip after a successful progress write", async () => {
        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });
        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "skipped",
            reason: "progress-interval",
        });

        expect(api.putLibraryItem).toHaveBeenCalledTimes(1);
    });

    it("skips without datastore calls when progress is at zero percent", async () => {
        await expect(trySyncStremio(createMpvData({ percent_pos: 0, time_pos: 0, duration: 1500 }))).resolves.toEqual({
            status: "skipped",
            reason: "progress-too-low",
        });

        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("does not throttle useful progress after a zero percent skip", async () => {
        await expect(trySyncStremio(createMpvData({ percent_pos: 0, time_pos: 0, duration: 1500 }))).resolves.toEqual({
            status: "skipped",
            reason: "progress-too-low",
        });
        await expect(trySyncStremio(createMpvData({ percent_pos: 2, time_pos: 30, duration: 1500 }))).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        expect(api.getLibraryItem).toHaveBeenCalledTimes(1);
        expect(api.putLibraryItem).toHaveBeenCalledTimes(1);
    });

    it("skips without datastore calls when elapsed time is below useful progress minimum", async () => {
        await expect(trySyncStremio(createMpvData({ percent_pos: 2, time_pos: 4, duration: 1500 }))).resolves.toEqual({
            status: "skipped",
            reason: "progress-too-low",
        });

        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("skips stale series context when season does not match current playback", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt1234567",
            imdbId: "tt1234567",
            videoId: "tt1234567:2:2",
            name: "Example",
            type: "series",
            season: 2,
            episode: 2,
            episodesInSeason: 12,
        });

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "skipped",
            reason: "playback-context-mismatch",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("skips stale series context when episode does not match current playback", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt1234567",
            imdbId: "tt1234567",
            videoId: "tt1234567:1:3",
            name: "Example",
            type: "series",
            season: 1,
            episode: 3,
            episodesInSeason: 12,
        });

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "skipped",
            reason: "playback-context-mismatch",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("uses filename episode parsing when parsed MPV fields are unavailable", async () => {
        await expect(trySyncStremio(createMpvData({ season: null, episode: null }))).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        expect(api.putLibraryItem).toHaveBeenCalledTimes(1);
    });

    it("skips partial series context when season is missing", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt1234567",
            imdbId: "tt1234567",
            videoId: "tt1234567:1:2",
            name: "Example",
            type: "series",
            season: null,
            episode: 2,
            episodesInSeason: 12,
        });

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "skipped",
            reason: "playback-context-mismatch",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("skips partial series context when episode is missing", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt1234567",
            imdbId: "tt1234567",
            videoId: "tt1234567:1:2",
            name: "Example",
            type: "series",
            season: 1,
            episode: null,
            episodesInSeason: 12,
        });

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "skipped",
            reason: "playback-context-mismatch",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("skips same-position series context when title identity does not match", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt7654321",
            imdbId: null,
            videoId: "tt7654321:1:2",
            name: "Old Show",
            type: "series",
            season: 1,
            episode: 2,
            episodesInSeason: 12,
        });

        await expect(
            trySyncStremio(
                createMpvData({
                    media_title: "New Show",
                    series_title: "New Show",
                    filename: "New Show S01E02.mkv",
                }),
            ),
        ).resolves.toEqual({
            status: "skipped",
            reason: "playback-context-mismatch",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("skips same-position generic context name that is only a substring of playback title", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt7654321",
            imdbId: null,
            videoId: "tt7654321:1:2",
            name: "Show",
            type: "series",
            season: 1,
            episode: 2,
            episodesInSeason: 12,
        });

        await expect(
            trySyncStremio(
                createMpvData({
                    media_title: "New Show - Episode 2",
                    series_title: "New Show",
                    filename: "New Show S01E02.mkv",
                }),
            ),
        ).resolves.toEqual({
            status: "skipped",
            reason: "playback-context-mismatch",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("skips same-position tiny context name contained in unrelated playback fields", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt7654321",
            imdbId: null,
            videoId: "tt7654321:1:2",
            name: "It",
            type: "series",
            season: 1,
            episode: 2,
            episodesInSeason: 12,
        });

        await expect(
            trySyncStremio(
                createMpvData({
                    media_title: "Little Witch - Episode 2",
                    series_title: "Little Witch",
                    filename: "Little Witch S01E02.mkv",
                }),
            ),
        ).resolves.toEqual({
            status: "skipped",
            reason: "playback-context-mismatch",
        });
        expect(api.getLibraryItem).not.toHaveBeenCalled();
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("syncs same-position series context when exact normalized title identity matches", async () => {
        await expect(
            trySyncStremio(
                createMpvData({
                    media_title: "Example - Episode 2",
                    series_title: "Example",
                    filename: "Example S01E02.mkv",
                }),
            ),
        ).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        expect(api.putLibraryItem).toHaveBeenCalledTimes(1);
    });

    it("updates only Continue Watching MVP fields", async () => {
        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        expect(api.putLibraryItem).toHaveBeenCalledTimes(1);
        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];

        expect(updatedItem.state).toMatchObject({
            timeOffset: 123000,
            duration: 1500000,
            video_id: "tt1234567:1:2",
            season: 1,
            episode: 2,
            timeWatched: 111,
            overallTimeWatched: 222,
            timesWatched: 3,
            flaggedWatched: 1,
            watched: "existing-watched",
        });
        expect(typeof updatedItem.state?.lastWatched).toBe("string");
    });

    it("updates _mtime to current time in put payload", async () => {
        const beforeSync = new Date();

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        const afterSync = new Date();
        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];

        expect(updatedItem._mtime).toBeDefined();
        const mtimeMs = Date.parse(updatedItem._mtime as string);
        expect(mtimeMs).toBeGreaterThanOrEqual(beforeSync.getTime());
        expect(mtimeMs).toBeLessThanOrEqual(afterSync.getTime());
    });

    it("sets season and episode for series items", async () => {
        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];
        expect(updatedItem.state).toMatchObject({
            season: 1,
            episode: 2,
        });
    });

    it("does not set season/episode for movie items", async () => {
        vi.mocked(context.readStremioPlaybackContext).mockReturnValue({
            libraryItemId: "tt1234567",
            imdbId: "tt1234567",
            videoId: "tt1234567",
            name: "Example Movie",
            type: "movie",
            season: null,
            episode: null,
            episodesInSeason: null,
        });

        await expect(
            trySyncStremio(
                createMpvData({
                    season: null,
                    episode: null,
                    filename: "Example Movie.mkv",
                }),
            ),
        ).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];
        expect(updatedItem.state).not.toHaveProperty("season");
        expect(updatedItem.state).not.toHaveProperty("episode");
    });

    it("handles API errors as controlled sync errors", async () => {
        vi.mocked(api.getLibraryItem).mockRejectedValue(new Error("api down"));

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({ status: "error", reason: "api down" });
        expect(api.putLibraryItem).not.toHaveBeenCalled();
    });

    it("does not throttle a retry after a failed API attempt", async () => {
        vi.mocked(api.getLibraryItem).mockRejectedValueOnce(new Error("api down"));

        await expect(trySyncStremio(createMpvData())).resolves.toEqual({ status: "error", reason: "api down" });
        await expect(trySyncStremio(createMpvData())).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        expect(api.getLibraryItem).toHaveBeenCalledTimes(2);
        expect(api.putLibraryItem).toHaveBeenCalledTimes(1);
    });

    it("does not run risky watched writes even when threshold is reached", async () => {
        await trySyncStremio(createMpvData({ percent_pos: 99 }));

        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];
        expect(updatedItem.state?.watched).toBe("existing-watched");
        expect(updatedItem.state?.timesWatched).toBe(3);
    });

    it("marks episode as watched when video IDs are available and episode not yet watched", async () => {
        const videoIds = ["tt1234567:1:1", "tt1234567:1:2", "tt1234567:1:3"];
        vi.mocked(meta.fetchVideoIds).mockResolvedValue(videoIds);
        vi.mocked(api.getLibraryItem).mockResolvedValue({
            _id: "tt1234567",
            _mtime: "2026-03-15T10:00:00.000Z",
            state: {
                timeWatched: 111,
                overallTimeWatched: 222,
                times_watched: 3,
                flagged_watched: 1,
            },
        });

        await expect(trySyncStremio(createMpvData({ percent_pos: 90 }))).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];
        expect(typeof updatedItem.state?.watched).toBe("string");
        expect(updatedItem.state?.watched).toBeTruthy();
        expect(updatedItem.state?.flagged_watched).toBe(1);
        expect(updatedItem.state?.times_watched).toBe(4);
    });

    it("does not re-mark an already watched episode", async () => {
        const videoIds = ["tt1234567:1:1", "tt1234567:1:2", "tt1234567:1:3"];
        const existingWatched = encodeWatched({
            anchorVideoId: "tt1234567:1:2",
            anchorLength: 2,
            watchedEpisodes: [false, true, false],
        });
        vi.mocked(meta.fetchVideoIds).mockResolvedValue(videoIds);
        vi.mocked(api.getLibraryItem).mockResolvedValue({
            _id: "tt1234567",
            _mtime: "2026-03-15T10:00:00.000Z",
            state: {
                timeWatched: 111,
                overallTimeWatched: 222,
                timesWatched: 3,
                flaggedWatched: 1,
                watched: existingWatched,
            },
        });

        await expect(trySyncStremio(createMpvData({ percent_pos: 90 }))).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];
        expect(updatedItem.state?.watched).toBe(existingWatched);
        expect(updatedItem.state?.timesWatched).toBe(3);
    });

    it("does not update watched when video IDs are null", async () => {
        vi.mocked(meta.fetchVideoIds).mockResolvedValue(null);

        await expect(trySyncStremio(createMpvData({ percent_pos: 99 }))).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];
        expect(updatedItem.state?.watched).toBe("existing-watched");
        expect(updatedItem.state?.timesWatched).toBe(3);
    });

    it("does not mark watched when below threshold even with video IDs", async () => {
        const videoIds = ["tt1234567:1:1", "tt1234567:1:2", "tt1234567:1:3"];
        vi.mocked(meta.fetchVideoIds).mockResolvedValue(videoIds);

        await expect(trySyncStremio(createMpvData({ percent_pos: 70 }))).resolves.toEqual({
            status: "synced",
            libraryItemId: "tt1234567",
        });

        const [updatedItem] = vi.mocked(api.putLibraryItem).mock.calls[0];
        expect(updatedItem.state?.watched).toBe("existing-watched");
    });
});
