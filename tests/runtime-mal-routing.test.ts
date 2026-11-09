import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MpvData } from "../src/integrations/mpv";

const mocks = vi.hoisted(() => ({
    getMpvData: vi.fn(),
    syncEpisodeDetailed: vi.fn(async () => "updated"),
    isAuthenticated: vi.fn(() => true),
}));

vi.mock("../src/core/config", () => ({
    config: {
        settings: { discordRpc: false },
        updateInterval: 1000,
        mal: { enabled: true, syncThreshold: 90 },
        trakt: { enabled: false },
        stremio: { enabled: false },
    },
}));
vi.mock("../src/core/anime", () => ({ getProviderName: () => "jikan" }));
vi.mock("../src/core/media", () => ({ isMediaProviderConfigured: () => true }));
vi.mock("../src/core/auto-fetch", () => ({ checkAndTriggerAutoFetch: vi.fn() }));
vi.mock("../src/console", () => ({
    ConsoleRepl: class {
        on(): void {}
        updateContext(): void {}
    },
    createEpisodeContext: vi.fn(),
}));
vi.mock("../src/integrations/mpv", () => ({
    connect: async () => true,
    getMpvData: mocks.getMpvData,
    updateMpvTitle: vi.fn(),
}));
vi.mock("../src/integrations/discord", () => ({ logStatus: vi.fn() }));
vi.mock("../src/mal-sync/sync", () => ({
    isAuthenticated: mocks.isAuthenticated,
    getUsername: async () => "test-user",
    syncEpisodeDetailed: mocks.syncEpisodeDetailed,
}));

function playback(overrides: Partial<MpvData> = {}): MpvData {
    return {
        media_title: "Doctor Who",
        series_title: "Doctor Who",
        filename: "Doctor.Who.S04E09.mkv",
        season: 4,
        episode: 9,
        episode_title: null,
        pause: false,
        percent_pos: 95,
        time_pos: 95,
        duration: 100,
        artist: "N/A",
        cover_image: null,
        mal_id: null,
        total_episodes: null,
        adjusted_episode: null,
        playlistPos: 0,
        playlistCount: 1,
        media_kind: "series",
        ...overrides,
    };
}

describe("MAL routing in the real playback update loop", () => {
    let tick: () => Promise<void>;
    let logs: ReturnType<typeof vi.spyOn>;
    const signalHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

    beforeAll(async () => {
        vi.useFakeTimers();
        logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
        for (const signal of ["SIGINT", "SIGTERM"]) signalHandlers.set(signal, process.listeners(signal));
        const interval = vi.spyOn(globalThis, "setInterval");
        mocks.getMpvData.mockResolvedValue(playback());
        await import("../src/index");
        await vi.advanceTimersByTimeAsync(0);
        expect(interval).toHaveBeenCalled();
        tick = interval.mock.calls[0][0] as () => Promise<void>;
    });

    afterAll(() => {
        for (const [signal, previous] of signalHandlers) {
            for (const handler of process.listeners(signal)) {
                if (!previous.includes(handler)) process.removeListener(signal, handler);
            }
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        "series",
        "movie",
    ] as const)("skips MAL diagnostics and sync for TMDb %s even with a stray MAL id", async (kind) => {
        mocks.syncEpisodeDetailed.mockClear();
        logs.mockClear();
        mocks.getMpvData.mockResolvedValue(playback({ filename: `${kind}.mkv`, media_kind: kind, mal_id: 123 }));
        await tick();
        expect(mocks.syncEpisodeDetailed).not.toHaveBeenCalled();
        expect(logs.mock.calls.some(([message]) => String(message).startsWith("[MAL]"))).toBe(false);
    });

    it("does not report a missing MAL id for a non-anime series", async () => {
        logs.mockClear();
        mocks.getMpvData.mockResolvedValue(playback({ filename: "another-series.mkv" }));
        await tick();
        expect(logs.mock.calls.some(([message]) => String(message).startsWith("[MAL]"))).toBe(false);
    });

    it("still syncs anime progress", async () => {
        mocks.syncEpisodeDetailed.mockClear();
        mocks.getMpvData.mockResolvedValue(
            playback({ media_kind: undefined, mal_id: 52991, episode: 5, total_episodes: 28 }),
        );
        await tick();
        expect(mocks.syncEpisodeDetailed).toHaveBeenCalledWith(52991, 5, 95, 28);
    });

    it("retains missing-id diagnostics for unresolved anime", async () => {
        logs.mockClear();
        mocks.getMpvData.mockResolvedValue(playback({ filename: "anime-without-id.mkv", media_kind: undefined }));
        await tick();
        expect(logs.mock.calls.some(([message]) => String(message).includes("MAL ID not found"))).toBe(true);
    });
});
