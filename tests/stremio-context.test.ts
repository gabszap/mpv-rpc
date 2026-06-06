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

    it("returns null for missing or stale context", async () => {
        const tempDir = useTempProject();
        fs.writeFileSync(
            path.join(tempDir, ".config", ".stremio-mpv-config.json"),
            JSON.stringify({
                stremioMeta: {
                    libraryItemId: "tt9679542",
                    savedAt: "2000-01-01T00:00:00.000Z",
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
});
