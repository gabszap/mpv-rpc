import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function useTempProject(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stremio-context-test-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, ".config"));
    return tempDir;
}

async function importContextModule(): Promise<typeof import("../src/stremio-sync/context")> {
    vi.resetModules();
    return import("../src/stremio-sync/context");
}

describe("Stremio playback context", () => {
    afterEach(() => {
        process.chdir(originalCwd);
        for (const tempDir of tempDirs.splice(0)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("reads and separates library item, real IMDb id, and video id", async () => {
        const tempDir = useTempProject();
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                stremioMeta: {
                    libraryItemId: "tt9679542",
                    imdbId: "tt9679542",
                    videoId: "tt9679542:4:24",
                    name: "Frieren",
                    type: "series",
                    season: 4,
                    episode: 24,
                    episodesInSeason: 30,
                    savedAt: new Date().toISOString(),
                },
            }),
        );

        const { readStremioPlaybackContext } = await importContextModule();

        expect(readStremioPlaybackContext()).toEqual({
            libraryItemId: "tt9679542",
            imdbId: "tt9679542",
            videoId: "tt9679542:4:24",
            name: "Frieren",
            type: "series",
            season: 4,
            episode: 24,
            episodesInSeason: 30,
        });
    });

    it("rejects kitsu and mal values as IMDb ids while preserving library ids", async () => {
        const { parseStremioPlaybackContext } = await importContextModule();

        expect(
            parseStremioPlaybackContext({
                stremioMeta: {
                    libraryItemId: "kitsu:1234",
                    imdbId: "mal:5678",
                    videoId: "kitsu:1234:2",
                    type: "series",
                    season: 1,
                    episode: 2,
                },
            }),
        ).toMatchObject({
            libraryItemId: "kitsu:1234",
            imdbId: null,
            videoId: "kitsu:1234:2",
        });
    });

    it("keeps older context readable so identity validation can decide whether it is stale", async () => {
        const tempDir = useTempProject();
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                stremioMeta: {
                    libraryItemId: "tt9679542",
                    imdbId: "tt9679542",
                    videoId: "tt9679542:4:24",
                    name: "Frieren",
                    type: "series",
                    season: 4,
                    episode: 24,
                    savedAt: "2000-01-01T00:00:00.000Z",
                },
            }),
        );

        const { readStremioPlaybackContext } = await importContextModule();
        const context = readStremioPlaybackContext();

        expect(context).toMatchObject({
            libraryItemId: "tt9679542",
            imdbId: "tt9679542",
            videoId: "tt9679542:4:24",
            name: "Frieren",
            type: "series",
            season: 4,
            episode: 24,
        });
        expect(context?.isFresh).toBe(false);
        expect(context?.savedAtMs).toBe(Date.parse("2000-01-01T00:00:00.000Z"));
    });

    it("returns null for missing or structurally invalid context", async () => {
        const tempDir = useTempProject();
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                stremioMeta: {
                    imdbId: "tt9679542",
                    savedAt: new Date().toISOString(),
                },
            }),
        );

        const { readStremioPlaybackContext } = await importContextModule();

        expect(readStremioPlaybackContext()).toBeNull();
    });

    it("supports existing configs that only saved seriesId", async () => {
        const { parseStremioPlaybackContext } = await importContextModule();

        expect(
            parseStremioPlaybackContext({
                stremioMeta: {
                    seriesId: "tt22248376",
                    imdbId: "tt22248376",
                    type: "series",
                    season: 1,
                    episode: 1,
                },
            }),
        ).toMatchObject({
            libraryItemId: "tt22248376",
            seriesId: "tt22248376",
            imdbId: "tt22248376",
            videoId: null,
        });
    });

    it("promotes a matching auto-fetched URL context over stale current metadata", async () => {
        const tempDir = useTempProject();
        const streamUrl = "https://streams.example.test/jjk-s03e08.mkv?token=redacted";
        const urlKey = `url:${crypto.createHash("sha256").update(streamUrl).digest("hex")}`;
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                providers: [{ id: "torrentio", name: "Torrentio", url: "https://provider.example", enabled: true }],
                autoFetch: { enabled: true },
                stremioMeta: {
                    libraryItemId: "mal:57658",
                    seriesId: "mal:57658",
                    imdbId: "tt12343534",
                    videoId: "tt12343534:3:7",
                    name: "Jujutsu Kaisen",
                    type: "series",
                    season: 3,
                    episode: 7,
                    savedAt: "2026-06-10T10:00:00.000Z",
                },
                autoFetchedPlaybackContexts: {
                    [urlKey]: {
                        matchKey: urlKey,
                        titleKey: "jujutsu kaisen s03e08",
                        libraryItemId: "mal:57658",
                        seriesId: "mal:57658",
                        imdbId: "tt12343534",
                        videoId: "tt12343534:3:8",
                        name: "Jujutsu Kaisen",
                        type: "series",
                        season: 3,
                        episode: 8,
                        episodesInSeason: null,
                        savedAt: "2026-06-10T10:05:00.000Z",
                    },
                },
            }),
        );

        const { readStremioPlaybackContext } = await importContextModule();
        const context = readStremioPlaybackContext(
            {
                media_title: "Jujutsu Kaisen S03E08",
                series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
                season: 3,
                episode: 8,
                episode_title: null,
                filename: "jjk-s03e08",
                path: streamUrl,
                pause: false,
                percent_pos: 6,
                time_pos: 60,
                duration: 1200,
                artist: "N/A",
                cover_image: null,
                mal_id: 57658,
                total_episodes: null,
                adjusted_episode: null,
                imdb_id: "tt12343534",
                type: "series",
                playlistPos: 1,
                playlistCount: 3,
            },
            Date.parse("2026-06-10T10:06:00.000Z"),
        );

        expect(context).toMatchObject({
            libraryItemId: "mal:57658",
            imdbId: "tt12343534",
            videoId: "tt12343534:3:8",
            season: 3,
            episode: 8,
        });

        const persisted = JSON.parse(
            fs.readFileSync(path.join(tempDir, ".config", ".stremio-mpv-config.json"), "utf-8"),
        );
        expect(persisted.stremioMeta).toMatchObject({ videoId: "tt12343534:3:8", season: 3, episode: 8 });
        expect(persisted.providers).toEqual([
            { id: "torrentio", name: "Torrentio", url: "https://provider.example", enabled: true },
        ]);
        expect(persisted.autoFetch).toEqual({ enabled: true });
    });

    it("ignores expired auto-fetched contexts after six hours", async () => {
        const tempDir = useTempProject();
        const streamUrl = "https://streams.example.test/jjk-s03e08.mkv?token=redacted";
        const urlKey = `url:${crypto.createHash("sha256").update(streamUrl).digest("hex")}`;
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                stremioMeta: {
                    libraryItemId: "mal:57658",
                    seriesId: "mal:57658",
                    imdbId: "tt12343534",
                    videoId: "tt12343534:3:7",
                    name: "Jujutsu Kaisen",
                    type: "series",
                    season: 3,
                    episode: 7,
                    savedAt: "2026-06-10T10:00:00.000Z",
                },
                autoFetchedPlaybackContexts: {
                    [urlKey]: {
                        matchKey: urlKey,
                        titleKey: "jujutsu kaisen s03e08",
                        libraryItemId: "mal:57658",
                        seriesId: "mal:57658",
                        imdbId: "tt12343534",
                        videoId: "tt12343534:3:8",
                        name: "Jujutsu Kaisen",
                        type: "series",
                        season: 3,
                        episode: 8,
                        episodesInSeason: null,
                        savedAt: "2026-06-10T10:05:00.000Z",
                    },
                },
            }),
        );

        const { readStremioPlaybackContext } = await importContextModule();
        const context = readStremioPlaybackContext(
            {
                media_title: "Jujutsu Kaisen S03E08",
                series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
                season: 3,
                episode: 8,
                episode_title: null,
                filename: "jjk-s03e08",
                path: streamUrl,
                pause: false,
                percent_pos: 6,
                time_pos: 60,
                duration: 1200,
                artist: "N/A",
                cover_image: null,
                mal_id: 57658,
                total_episodes: null,
                adjusted_episode: null,
                imdb_id: "tt12343534",
                type: "series",
                playlistPos: 1,
                playlistCount: 3,
            },
            Date.parse("2026-06-10T16:06:00.000Z"),
        );

        expect(context).toMatchObject({ videoId: "tt12343534:3:7", season: 3, episode: 7 });

        const persisted = JSON.parse(
            fs.readFileSync(path.join(tempDir, ".config", ".stremio-mpv-config.json"), "utf-8"),
        );
        expect(persisted.stremioMeta).toMatchObject({ videoId: "tt12343534:3:7", season: 3, episode: 7 });
    });

    it("normalizes a promoted auto-fetched context when videoId lags behind season and episode", async () => {
        const tempDir = useTempProject();
        const streamUrl = "https://streams.example.test/jjk-s03e09.mkv?token=redacted";
        const urlKey = `url:${crypto.createHash("sha256").update(streamUrl).digest("hex")}`;
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                stremioMeta: {
                    libraryItemId: "mal:57658",
                    seriesId: "mal:57658",
                    imdbId: "tt12343534",
                    videoId: "tt12343534:3:8",
                    name: "Jujutsu Kaisen",
                    type: "series",
                    season: 3,
                    episode: 8,
                    savedAt: "2026-06-10T10:00:00.000Z",
                },
                autoFetchedPlaybackContexts: {
                    [urlKey]: {
                        matchKey: urlKey,
                        titleKey: "jujutsu kaisen s03e09",
                        libraryItemId: "mal:57658",
                        seriesId: "mal:57658",
                        imdbId: "tt12343534",
                        videoId: "tt12343534:3:8",
                        name: "Jujutsu Kaisen",
                        type: "series",
                        season: 3,
                        episode: 9,
                        episodesInSeason: null,
                        savedAt: "2026-06-10T10:05:00.000Z",
                    },
                },
            }),
        );

        const { readStremioPlaybackContext } = await importContextModule();
        const context = readStremioPlaybackContext(
            {
                media_title: "Jujutsu Kaisen S03E09",
                series_title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
                season: 3,
                episode: 9,
                episode_title: null,
                filename: "jjk-s03e09",
                path: streamUrl,
                pause: false,
                percent_pos: 6,
                time_pos: 60,
                duration: 1200,
                artist: "N/A",
                cover_image: null,
                mal_id: 57658,
                total_episodes: null,
                adjusted_episode: null,
                imdb_id: "tt12343534",
                type: "series",
                playlistPos: 1,
                playlistCount: 3,
            },
            Date.parse("2026-06-10T10:06:00.000Z"),
        );

        expect(context).toMatchObject({ videoId: "tt12343534:3:9", season: 3, episode: 9 });

        const persisted = JSON.parse(
            fs.readFileSync(path.join(tempDir, ".config", ".stremio-mpv-config.json"), "utf-8"),
        );
        expect(persisted.stremioMeta).toMatchObject({ videoId: "tt12343534:3:9", season: 3, episode: 9 });
    });

    it("does not promote a title-matched auto-fetched context with a conflicting secure id", async () => {
        const tempDir = useTempProject();
        const titleKey = "jujutsu kaisen s03e08";
        const matchKey = `title:${crypto.createHash("sha256").update(titleKey).digest("hex")}`;
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                stremioMeta: {
                    libraryItemId: "mal:57658",
                    seriesId: "mal:57658",
                    imdbId: "tt12343534",
                    videoId: "tt12343534:3:7",
                    name: "Jujutsu Kaisen",
                    type: "series",
                    season: 3,
                    episode: 7,
                    savedAt: "2026-06-10T10:00:00.000Z",
                },
                autoFetchedPlaybackContexts: {
                    [matchKey]: {
                        matchKey,
                        titleKey,
                        libraryItemId: "mal:57658",
                        seriesId: "mal:57658",
                        imdbId: "tt12343534",
                        videoId: "tt12343534:3:8",
                        name: "Jujutsu Kaisen",
                        type: "series",
                        season: 3,
                        episode: 8,
                        savedAt: "2026-06-10T10:05:00.000Z",
                    },
                },
            }),
        );

        const { readStremioPlaybackContext } = await importContextModule();
        const context = readStremioPlaybackContext(
            {
                media_title: "Jujutsu Kaisen S03E08",
                series_title: "Different Show",
                season: 3,
                episode: 8,
                episode_title: null,
                filename: "Different Show S03E08.mkv",
                pause: false,
                percent_pos: 6,
                time_pos: 60,
                duration: 1200,
                artist: "N/A",
                cover_image: null,
                mal_id: 99999,
                total_episodes: null,
                adjusted_episode: null,
                imdb_id: "tt9999999",
                type: "series",
                playlistPos: 0,
                playlistCount: 1,
            },
            Date.parse("2026-06-10T10:06:00.000Z"),
        );

        expect(context).toMatchObject({ videoId: "tt12343534:3:7", season: 3, episode: 7 });
        const persisted = JSON.parse(
            fs.readFileSync(path.join(tempDir, ".config", ".stremio-mpv-config.json"), "utf-8"),
        );
        expect(persisted.stremioMeta).toMatchObject({ videoId: "tt12343534:3:7", season: 3, episode: 7 });
    });
});
