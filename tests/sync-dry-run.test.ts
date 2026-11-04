/**
 * Tests for the SYNC_DRY_RUN guard.
 *
 * These tests verify that when `config.syncDryRun` is true, the mutating
 * entry points in Trakt, Stremio, and Auto-Fetch log what they WOULD do
 * without making the real network call. When the flag is false (control),
 * the call goes through normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MpvData } from "../src/integrations/mpv";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEpisode(
    season: number,
    number: number,
    title?: string,
): {
    season: number;
    number: number;
    title: string;
    ids: { trakt: number; slug: string; imdb: string };
} {
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

function makeShow(
    id: number,
    title: string,
): {
    title: string;
    year: number;
    ids: { trakt: number; slug: string };
} {
    return {
        title,
        year: 2020,
        ids: { trakt: id, slug: `show-${id}` },
    };
}

function makeMpvData(overrides: Partial<MpvData> = {}): MpvData {
    return {
        media_title: "Test Show S03E05",
        series_title: "Test Show",
        season: 3,
        episode: 5,
        episode_title: null,
        filename: "Test.Show.S03E05.mkv",
        pause: false,
        percent_pos: 95,
        time_pos: 123,
        duration: 1500,
        artist: "N/A",
        cover_image: null,
        mal_id: null,
        total_episodes: null,
        adjusted_episode: null,
        imdb_id: "tt1234567",
        type: "series",
        playlistPos: 0,
        playlistCount: 1,
        ...overrides,
    };
}

function mockJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const SHARED_CONFIG = {
    stremioMeta: {
        imdbId: "tt1234567",
        name: "Test Show",
        season: 3,
        episode: 5,
        type: "series",
    },
    extraEpisodes: 2,
};

// ---------------------------------------------------------------------------
// Helpers to control config + reload modules
// ---------------------------------------------------------------------------

/**
 * Set the config mock to a specific syncDryRun value.
 */
function setConfigSyncDryRun(syncDryRun: boolean): void {
    vi.doMock("../src/core/config", () => ({
        config: {
            syncDryRun,
            stremio: {
                enabled: true,
                syncThreshold: 85,
                progressIntervalMs: 30000,
            },
            autoFetch: {
                enabled: true,
            },
            trakt: {
                enabled: true,
                useTor: false,
                torProxy: "",
                clientId: "",
                clientSecret: "",
                syncThreshold: 81,
            },
        },
    }));
}

afterEach(() => {
    vi.doUnmock("../src/core/config");
    vi.resetModules();
});

// ===========================================================================
// Trakt dry-run
// ===========================================================================

describe("Trakt scrobble dry-run", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let axiosPostMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        // Per-describe axios mock so we can assert post was/wasn't called.
        axiosPostMock = vi.fn();
        vi.doMock("axios", () => ({
            default: {
                get: vi.fn(),
                post: axiosPostMock,
                create: () => ({
                    get: vi.fn(),
                    post: axiosPostMock,
                }),
                isAxiosError: () => false,
            },
            isAxiosError: () => false,
        }));

        // Mock trakt-sync/auth so getAccessToken returns a valid token.
        // Required for the dry-run=false control test to reach axios.post.
        vi.doMock("../src/trakt-sync/auth", () => ({
            getAccessToken: vi.fn().mockResolvedValue("test-access-token"),
            isAuthenticated: vi.fn().mockReturnValue(true),
        }));

        logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        logSpy.mockRestore();
        vi.doUnmock("axios");
        vi.doUnmock("../src/trakt-sync/auth");
    });

    it("scrobbleStart with dry-run=true: axios.post is NOT called, log emitted, returns true", async () => {
        setConfigSyncDryRun(true);
        vi.resetModules();
        const { scrobbleStart } = await import("../src/trakt-sync/api");

        const result = await scrobbleStart(makeEpisode(3, 5), makeShow(1, "Jujutsu Kaisen"), 50);

        expect(result).toBe(true);
        expect(axiosPostMock).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining("[Trakt][dry-run] Would start: Jujutsu Kaisen S03E05 (50%)"),
        );
    });

    it("scrobbleStop with dry-run=false: axios.post IS called (control)", async () => {
        setConfigSyncDryRun(false);
        axiosPostMock.mockResolvedValue({ status: 200, data: {} });
        vi.resetModules();
        const { scrobbleStop } = await import("../src/trakt-sync/api");

        const result = await scrobbleStop(makeEpisode(3, 5), makeShow(1, "Jujutsu Kaisen"), 90);

        expect(result).toBe(true);
        expect(axiosPostMock).toHaveBeenCalledTimes(1);
        // First positional arg of post is the URL
        const [url] = axiosPostMock.mock.calls[0];
        expect(String(url)).toContain("/scrobble/stop");
        // Ensure no dry-run log was emitted in the control case
        const dryRunLogCalls = logSpy.mock.calls.filter((args) => String(args[0]).includes("[Trakt][dry-run]"));
        expect(dryRunLogCalls).toHaveLength(0);
    });

    it("scrobblePause with dry-run=true: axios.post is NOT called, log emitted, returns true", async () => {
        setConfigSyncDryRun(true);
        vi.resetModules();
        const { scrobblePause } = await import("../src/trakt-sync/api");

        const result = await scrobblePause(makeEpisode(2, 12), makeShow(1, "Frieren"), 25);

        expect(result).toBe(true);
        expect(axiosPostMock).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining("[Trakt][dry-run] Would pause: Frieren S02E12 (25%)"),
        );
    });
});

// ===========================================================================
// Stremio dry-run
// ===========================================================================

describe("Stremio sync dry-run", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let putLibraryItemMock: ReturnType<typeof vi.fn>;
    let getLibraryItemMock: ReturnType<typeof vi.fn>;
    let getStremioAuthKey: () => unknown;
    let readStremioPlaybackContext: () => unknown;
    let fetchVideoIds: () => unknown;

    beforeEach(async () => {
        putLibraryItemMock = vi.fn();
        getLibraryItemMock = vi.fn();
        vi.doMock("../src/stremio-sync/api", () => ({
            getLibraryItem: getLibraryItemMock,
            putLibraryItem: putLibraryItemMock,
            nowTimestamp: () => "2026-05-11T20:00:00.000-04:00",
        }));
        vi.doMock("../src/stremio-sync/auth", () => ({
            getStremioAuthKey: vi.fn(),
        }));
        vi.doMock("../src/stremio-sync/context", () => ({
            readStremioPlaybackContext: vi.fn(),
        }));
        vi.doMock("../src/stremio-sync/meta", () => ({
            fetchVideoIds: vi.fn(),
        }));

        logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        const auth = await import("../src/stremio-sync/auth");
        const context = await import("../src/stremio-sync/context");
        const meta = await import("../src/stremio-sync/meta");
        getStremioAuthKey = vi.mocked(auth.getStremioAuthKey);
        readStremioPlaybackContext = vi.mocked(context.readStremioPlaybackContext);
        fetchVideoIds = vi.mocked(meta.fetchVideoIds);

        getStremioAuthKey.mockReturnValue("auth-key");
        readStremioPlaybackContext.mockReturnValue({
            libraryItemId: "tt1234567",
            imdbId: "tt1234567",
            videoId: "tt1234567:3:5",
            name: "Test Show",
            type: "series",
            season: 3,
            episode: 5,
            episodesInSeason: 12,
        });
        fetchVideoIds.mockResolvedValue(null);
    });

    afterEach(() => {
        logSpy.mockRestore();
        vi.doUnmock("../src/stremio-sync/api");
        vi.doUnmock("../src/stremio-sync/auth");
        vi.doUnmock("../src/stremio-sync/context");
        vi.doUnmock("../src/stremio-sync/meta");
    });

    it("trySyncStremio with dry-run=true: putLibraryItem is NOT called, log emitted, returns dry-run skip", async () => {
        setConfigSyncDryRun(true);
        vi.resetModules();
        const { trySyncStremio } = await import("../src/stremio-sync/sync");

        const result = await trySyncStremio(makeMpvData());

        expect(result).toEqual({ status: "skipped", reason: "dry-run" });
        expect(putLibraryItemMock).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining("[Stremio][dry-run] Would write continue-watching: Test Show S03E05"),
        );
        expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Continue Watching skipped"));
    });

    it("trySyncStremio with dry-run=false: putLibraryItem IS called (control)", async () => {
        setConfigSyncDryRun(false);
        getLibraryItemMock.mockResolvedValue({
            _id: "tt1234567",
            _mtime: "2026-03-15T10:00:00.000Z",
            state: {},
        });
        putLibraryItemMock.mockResolvedValue();

        vi.resetModules();
        const { trySyncStremio } = await import("../src/stremio-sync/sync");

        const result = await trySyncStremio(makeMpvData());

        expect(result).toEqual({ status: "synced", libraryItemId: "tt1234567" });
        expect(putLibraryItemMock).toHaveBeenCalledTimes(1);
        const dryRunLogCalls = logSpy.mock.calls.filter((args) => String(args[0]).includes("[Stremio][dry-run]"));
        expect(dryRunLogCalls).toHaveLength(0);
    });
});

// ===========================================================================
// Auto-Fetch dry-run
// ===========================================================================

describe("Auto-Fetch dry-run", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        // Mock fs so readSharedConfig returns a known config.
        vi.doMock("node:fs", async () => {
            const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
            return {
                ...actual,
                readFileSync: vi.fn(),
            };
        });

        // Mock trakt-sync/api (auto-fetch imports normalizeTitle from there).
        vi.doMock("../src/trakt-sync/api", () => ({
            normalizeTitle: (s: string) =>
                s
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, " ")
                    .trim(),
        }));

        const fs = await import("node:fs");
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SHARED_CONFIG));

        logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("/health")) {
                return mockJsonResponse({ status: "ok" });
            }
            if (url.endsWith("/auto-fetch")) {
                return mockJsonResponse({ success: true, added: 2 });
            }
            return mockJsonResponse({}, 404);
        });
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        logSpy.mockRestore();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.doUnmock("node:fs");
        vi.doUnmock("../src/trakt-sync/api");
    });

    it("checkAndTriggerAutoFetch with dry-run=true: auto-fetch POST is NOT called, log emitted", async () => {
        setConfigSyncDryRun(true);
        vi.resetModules();
        const { checkAndTriggerAutoFetch } = await import("../src/core/auto-fetch");

        await checkAndTriggerAutoFetch(makeMpvData());

        // health check is still performed; auto-fetch POST must NOT be.
        const urls = fetchMock.mock.calls.map(([u]) => (typeof u === "string" ? u : u.toString()));
        expect(urls.some((u) => u.endsWith("/auto-fetch"))).toBe(false);
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining("[AutoFetch][dry-run] Would POST /auto-fetch: 2 episode(s)"),
        );
    });

    it("checkAndTriggerAutoFetch with dry-run=false: auto-fetch POST IS called (control)", async () => {
        setConfigSyncDryRun(false);
        vi.resetModules();
        const { checkAndTriggerAutoFetch } = await import("../src/core/auto-fetch");

        await checkAndTriggerAutoFetch(makeMpvData());

        const urls = fetchMock.mock.calls.map(([u]) => (typeof u === "string" ? u : u.toString()));
        expect(urls.some((u) => u.endsWith("/auto-fetch"))).toBe(true);
        const dryRunLogCalls = logSpy.mock.calls.filter((args) => String(args[0]).includes("[AutoFetch][dry-run]"));
        expect(dryRunLogCalls).toHaveLength(0);
    });
});
