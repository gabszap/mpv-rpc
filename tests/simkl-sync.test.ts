import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MpvData } from "../src/integrations/mpv";
import { SimklScrobbler } from "../src/simkl-sync/sync";
import { SimklApiError, type SimklEvent } from "../src/simkl-sync/types";

vi.mock("../src/core/config", () => ({ config: {} }));
const settings = { enabled: true, clientId: "client", sessionKey: "grant", threshold: 80, dryRun: false };
const data = (fields: Partial<MpvData> = {}): MpvData =>
    ({
        filename: "movie.mkv",
        path: "movie.mkv",
        playlistPos: 0,
        series_title: "Movie",
        media_kind: "movie",
        tmdb_id: 1,
        episode: null,
        season: null,
        mal_id: null,
        pause: false,
        percent_pos: 10,
        time_pos: 60,
        duration: 600,
        ...fields,
    }) as MpvData;
let send: ReturnType<typeof vi.fn>;
let sync: SimklScrobbler;
beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn(async (_event: SimklEvent) => undefined);
    sync = new SimklScrobbler(send);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});
const tick = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
};
it("does not complete when playback crosses 80%; pause and resume send only transitions", async () => {
    sync.update(data(), settings);
    await tick();
    sync.update(data({ percent_pos: 85 }), settings);
    await tick();
    expect(send.mock.calls.map(([e]) => e.action)).toEqual(["start"]);
    sync.update(data({ percent_pos: 85, pause: true }), settings);
    await tick();
    sync.update(data({ percent_pos: 86, pause: true }), settings);
    await tick();
    sync.update(data({ percent_pos: 86 }), settings);
    await tick();
    expect(send.mock.calls.map(([e]) => e.action)).toEqual(["start", "pause", "start"]);
});
it.each([79, 80, 100])("stops once with the last real progress (%s)", async (progress) => {
    sync.update(data({ percent_pos: progress, pause: true }), settings);
    await tick();
    sync.stop();
    sync.stop();
    await tick();
    expect(send.mock.calls.map(([e]) => [e.action, e.progress])).toEqual([
        ["pause", progress],
        ["stop", progress],
    ]);
});
it("a backward seek never retains the maximum percentage", async () => {
    sync.update(data({ percent_pos: 95 }), settings);
    await tick();
    sync.update(data({ percent_pos: 20, time_pos: 120 }), settings);
    await tick();
    sync.stop();
    await tick();
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ action: "stop", progress: 20 });
});
it("finishes the old file before starting the next, using the old threshold", async () => {
    sync.update(data({ percent_pos: 85 }), settings);
    await tick();
    sync.update(data({ path: "next.mkv", tmdb_id: 2, percent_pos: 1 }), { ...settings, threshold: 90 });
    await tick();
    expect(send.mock.calls.map(([e]) => [e.action, e.progress, e.threshold])).toEqual([
        ["start", 85, 80],
        ["stop", 85, 80],
        ["start", 1, 90],
    ]);
});
it("retains same-file identity across temporary missing metadata", async () => {
    sync.update(data(), settings);
    await tick();
    sync.update(data({ tmdb_id: undefined, percent_pos: 82 }), settings);
    await tick();
    sync.stop();
    await tick();
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ action: "stop", progress: 82 });
});
it("serializes retrying stops and respects a twenty-second rate lock", async () => {
    sync.update(data({ percent_pos: 85 }), settings);
    await tick();
    send.mockRejectedValueOnce(new SimklApiError("transient", 20000));
    sync.update(data({ path: "next", tmdb_id: 2, percent_pos: 2 }), settings);
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.map(([e]) => e.action)).toEqual(["start", "stop", "stop", "start"]);
});
it("does not overlap network calls and coalesces obsolete phases", async () => {
    let release!: () => void;
    send.mockImplementationOnce(
        () =>
            new Promise<void>((r) => {
                release = r;
            }),
    );
    sync.update(data(), settings);
    await tick();
    sync.update(data({ pause: true }), settings);
    sync.update(data({ pause: false }), settings);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await tick();
    expect(send.mock.calls.map(([e]) => e.action)).toEqual(["start", "start"]);
});
it("disabling finalizes once, without new starts", async () => {
    sync.update(data({ percent_pos: 85 }), settings);
    await tick();
    sync.update(data(), { ...settings, enabled: false });
    await tick();
    sync.update(data(), { ...settings, enabled: false });
    await tick();
    expect(send.mock.calls.map(([e]) => e.action)).toEqual(["start", "stop"]);
});
it("binds old finalization to its original login", async () => {
    sync.update(data({ percent_pos: 85 }), settings);
    await tick();
    sync.update(data(), { ...settings, sessionKey: "new-grant" });
    await tick();
    expect(send.mock.calls.map(([e]) => [e.action, e.sessionKey])).toEqual([
        ["start", "grant"],
        ["stop", "grant"],
        ["start", "new-grant"],
    ]);
});
it("dry-run never sends and does not consume a later real session", async () => {
    sync.update(data({ percent_pos: 90 }), { ...settings, dryRun: true });
    sync.stop();
    await tick();
    expect(send).not.toHaveBeenCalled();
    sync.update(data(), settings);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
});
it("suppresses repeated authorization failures for the same grant", async () => {
    send.mockRejectedValue(new SimklApiError("auth"));
    sync.update(data(), settings);
    await tick();
    sync.update(data({ pause: true }), settings);
    sync.stop();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
});
it("bounds shutdown while the API is unavailable", async () => {
    send.mockRejectedValue(new SimklApiError("transient", 20000));
    sync.update(data(), settings);
    await tick();
    sync.stop();
    const done = sync.flush(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBeUndefined();
});
it("preserves the rate lock when a retrying phase is replaced by stop", async () => {
    send.mockRejectedValueOnce(new SimklApiError("transient", 20000));
    sync.update(data(), settings);
    await tick();
    sync.stop();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(send.mock.calls.at(-1)?.[0].action).toBe("stop");
});
it("does not write queued real events after switching to dry-run", async () => {
    send.mockRejectedValueOnce(new SimklApiError("transient", 20000));
    sync.update(data(), settings);
    await tick();
    sync.update(data(), { ...settings, dryRun: true });
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(1);
});
it("resynchronizes a settled seek once without completing playback", async () => {
    sync.update(data(), settings);
    await tick();
    sync.update(data({ time_pos: 500, percent_pos: 90 }), settings);
    await tick();
    sync.update(data({ time_pos: 500, percent_pos: 90 }), settings);
    await tick();
    sync.update(data({ time_pos: 500, percent_pos: 90 }), settings);
    await tick();
    expect(send.mock.calls.map(([e]) => e.action)).toEqual(["start", "start"]);
});
it("never finalizes the same file as metadata IDs are added or temporarily lost", async () => {
    sync.update(
        data({ media_kind: undefined, mal_id: 100, episode: 10, imdb_id: "tt12345", percent_pos: 85 }),
        settings,
    );
    await tick();
    sync.update(
        data({
            media_kind: undefined,
            anime_ids: { mal: "100", anilist: "200" },
            episode: 10,
            imdb_id: "tt12345",
            percent_pos: 86,
        }),
        settings,
    );
    await tick();
    sync.update(
        data({ media_kind: undefined, mal_id: null, episode: 10, imdb_id: "tt12345", percent_pos: 87 }),
        settings,
    );
    await tick();
    expect(send.mock.calls.map(([e]) => e.action)).toEqual(["start"]);
    sync.stop();
    await tick();
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
        action: "stop",
        progress: 87,
        payload: { anime: { ids: { mal: "100" } } },
    });
});
it("keeps its captured threshold through a settings reload", async () => {
    sync.update(data({ percent_pos: 85 }), settings);
    await tick();
    sync.configure({ ...settings, threshold: 90 });
    sync.update(data({ percent_pos: 86 }), { ...settings, threshold: 90 });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    sync.stop();
    await tick();
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ action: "stop", threshold: 80 });
});
it("invalidates in-flight retries when dry-run is activated", async () => {
    let reject!: (error: Error) => void;
    send.mockImplementationOnce(
        () =>
            new Promise<void>((_resolve, r) => {
                reject = r;
            }),
    );
    sync.update(data(), settings);
    await tick();
    sync.update(data(), { ...settings, dryRun: true });
    reject(new SimklApiError("transient", 20000));
    await tick();
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(1);
});
