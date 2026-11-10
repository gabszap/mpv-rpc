import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("node:net", () => ({
    createConnection: () => {
        const socket = new EventEmitter() as EventEmitter & { write: (message: string) => void; destroy: () => void };
        socket.write = (message) => {
            const request = JSON.parse(message);
            void Promise.resolve().then(() =>
                socket.emit(
                    "data",
                    Buffer.from(
                        `${JSON.stringify({ request_id: request.request_id, data: state.values[request.command[1]] })}\n`,
                    ),
                ),
            );
        };
        socket.destroy = () => socket.emit("close");
        void Promise.resolve().then(() => socket.emit("connect"));
        return socket;
    },
}));
vi.mock("../src/core/parser", () => ({
    parseFilename: async () => ({
        series_title: "Movie",
        episode: null,
        season: null,
        media_type: "unknown",
        full_title: "Movie",
        episode_title: null,
    }),
}));
vi.mock("../src/core/metadata-router", () => ({ routeMetadata: async () => ({ result: null, pipeline: null }) }));
vi.mock("../src/console", () => ({ checkSeriesNameOverride: () => null }));
vi.mock("../src/stremio-sync/context", () => ({ readStremioPlaybackContext: () => null }));
afterEach(async () => {
    (await import("../src/integrations/mpv")).disconnect();
    vi.useRealTimers();
});
async function snapshot(fields: Record<string, unknown>) {
    vi.resetModules();
    vi.useFakeTimers();
    state.values = {
        "filename/no-ext": "movie",
        "media-title": "movie",
        path: "movie.mkv",
        pause: true,
        "percent-pos": 85,
        "time-pos": 850,
        duration: 1000,
        "playlist-pos": 0,
        "playlist-count": 1,
        ...fields,
    };
    return (await import("../src/integrations/mpv")).getMpvData();
}
it.each([
    "path",
    "pause",
    "playlist-pos",
    "playlist-count",
])("does not turn an unavailable %s into a playback transition", async (field) => {
    expect(await snapshot({ [field]: undefined })).toBeNull();
});
it("does not treat unavailable filename as a confirmed end", async () => {
    expect(await snapshot({ "filename/no-ext": undefined })).toBeNull();
});
it("still reports a confirmed idle player", async () => {
    expect(await snapshot({ "filename/no-ext": undefined, "idle-active": true, "playlist-count": 0 })).toMatchObject({
        filename: "N/A",
    });
});
