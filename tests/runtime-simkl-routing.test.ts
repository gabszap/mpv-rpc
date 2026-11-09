import { afterAll, beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getData: vi.fn(),
    connected: vi.fn(() => true),
    update: vi.fn(),
    stop: vi.fn(),
    flush: vi.fn(async () => undefined),
    options: { enabled: true, clientId: "client", syncThreshold: 80 },
    reload: vi.fn(),
    reloadConfig: vi.fn(() => ["SIMKL_SYNC_THRESHOLD: 80 -> 90"]),
    handlers: new Map<string, (...args: string[]) => unknown>(),
}));
vi.mock("../src/core/config", () => ({
    reloadConfig: mocks.reloadConfig,
    config: {
        settings: { discordRpc: false },
        updateInterval: 1000,
        mal: { enabled: false },
        trakt: { enabled: false },
        stremio: { enabled: false },
        simkl: mocks.options,
    },
}));
vi.mock("../src/core/anime", () => ({ getProviderName: () => "jikan" }));
vi.mock("../src/core/media", () => ({ isMediaProviderConfigured: () => true, reloadMediaProvider: vi.fn() }));
vi.mock("../src/core/auto-fetch", () => ({ checkAndTriggerAutoFetch: vi.fn() }));
vi.mock("../src/console", () => ({
    ConsoleRepl: class {
        on(name: string, handler: (...args: string[]) => unknown): void {
            mocks.handlers.set(name, handler);
        }
        updateContext(): void {}
        close(): void {}
    },
    createEpisodeContext: vi.fn(),
}));
vi.mock("../src/integrations/mpv", () => ({
    connect: async () => true,
    getMpvData: mocks.getData,
    getConnectionStatus: mocks.connected,
    updateMpvTitle: vi.fn(),
    clearForcedTitle: vi.fn(),
    disconnect: vi.fn(),
}));
vi.mock("../src/integrations/discord", () => ({ logStatus: vi.fn(), clearActivity: vi.fn() }));
vi.mock("../src/simkl-sync/auth", () => ({ isAuthenticated: () => true }));
vi.mock("../src/simkl-sync/sync", () => ({
    updateSimklPlayback: mocks.update,
    stopSimklPlayback: mocks.stop,
    flushSimklPlayback: mocks.flush,
    reloadSimklPlayback: mocks.reload,
}));

let tick: () => Promise<void>;
let shutdown: () => Promise<void>;
const previous = new Map<string, Array<(...args: unknown[]) => void>>();
beforeAll(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    for (const s of ["SIGINT", "SIGTERM"]) previous.set(s, process.listeners(s));
    const intervals = vi.spyOn(globalThis, "setInterval");
    mocks.getData.mockResolvedValue(null);
    await import("../src/index");
    await vi.advanceTimersByTimeAsync(0);
    tick = intervals.mock.calls[0][0] as () => Promise<void>;
    shutdown = process.listeners("SIGTERM").at(-1) as () => Promise<void>;
    vi.clearAllMocks();
});
afterAll(() => {
    for (const [signal, handlers] of previous)
        for (const handler of process.listeners(signal))
            if (!handlers.includes(handler)) process.removeListener(signal, handler);
    vi.useRealTimers();
    vi.restoreAllMocks();
});
it.each(["movie", "series", undefined])("routes %s to Simkl independently of MAL/Trakt", async (media_kind) => {
    const data = {
        filename: "file.mkv",
        playlistCount: 1,
        media_kind,
        season: 1,
        episode: 2,
        series_title: "Title",
        percent_pos: 85,
    };
    mocks.getData.mockResolvedValue(data);
    mocks.update.mockClear();
    await tick();
    expect(mocks.update).toHaveBeenCalledWith(data);
});
it("does not stop for unavailable metadata while MPV remains connected", async () => {
    mocks.getData.mockResolvedValue(null);
    mocks.stop.mockClear();
    await tick();
    expect(mocks.stop).not.toHaveBeenCalled();
});
it("stops on a real disconnect even when Trakt is disabled", async () => {
    mocks.connected.mockReturnValue(false);
    mocks.stop.mockClear();
    await tick();
    expect(mocks.stop).toHaveBeenCalledOnce();
    mocks.connected.mockReturnValue(true);
});
it("stops when no media remains", async () => {
    mocks.getData.mockResolvedValue({ filename: "N/A", playlistCount: 0 });
    mocks.stop.mockClear();
    await tick();
    expect(mocks.stop).toHaveBeenCalledOnce();
});
it("reloads Simkl settings without forcing a terminal event", async () => {
    mocks.stop.mockClear();
    await mocks.handlers.get("reload")?.("");
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.reload).toHaveBeenCalledOnce();
});
it("flushes shutdown without restarting from an in-flight playback read", async () => {
    let releaseRead!: (data: unknown) => void;
    let finishFlush!: () => void;
    mocks.getData.mockImplementationOnce(
        () =>
            new Promise((r) => {
                releaseRead = r;
            }),
    );
    mocks.flush.mockImplementationOnce(
        () =>
            new Promise<void>((r) => {
                finishFlush = r;
            }),
    );
    mocks.update.mockClear();
    const pendingTick = tick();
    mocks.stop.mockClear();
    const stopping = shutdown();
    releaseRead({ filename: "movie.mkv", playlistCount: 1 });
    await pendingTick;
    expect(mocks.update).not.toHaveBeenCalled();
    finishFlush();
    await stopping;
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
});
