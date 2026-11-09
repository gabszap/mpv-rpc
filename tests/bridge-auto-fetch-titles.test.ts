import * as fs from "node:fs";
import type { Server } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-queue-titles-"));
const originalConfigDir = process.env.STREMIO_MPV_CONFIG_DIR;
const originalPipe = process.env.MPV_IPC_PATH;
const ipcPath =
    process.platform === "win32" ? `\\\\.\\pipe\\mpv-queue-titles-${process.pid}` : path.join(dir, "mpv.sock");
const realFetch = globalThis.fetch;
let server: Server;
let ipcServer: net.Server;
let baseUrl: string;
let resetDedupe: () => void;
let episodeTitle: string | null;
let rejectAppend = false;
let seriesName: string;
let queuedPlaylists: Array<{ file: string; content: string }> = [];

beforeAll(async () => {
    process.env.STREMIO_MPV_CONFIG_DIR = dir;
    process.env.MPV_IPC_PATH = ipcPath;
    ipcServer = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) continue;
                const request = JSON.parse(line);
                const [command, file] = request.command;
                if (command === "loadlist") {
                    queuedPlaylists.push({ file, content: fs.readFileSync(file, "utf8") });
                    // MPV can emit events before replying to the append command.
                    socket.write(`${JSON.stringify({ event: "playlist-changed" })}\n`);
                }
                socket.write(
                    `${JSON.stringify({ request_id: request.request_id, error: command === "loadlist" && rejectAppend ? "error" : "success", data: command === "get_property" ? [] : null })}\n`,
                );
            }
        });
    });
    await new Promise<void>((resolve) => ipcServer.listen(ipcPath, resolve));
    const imported = await import("../stremio-mpv-bridge/server.js");
    const { app, _autoFetchDedupeForTests } = imported.default ?? imported;
    resetDedupe = _autoFetchDedupeForTests.resetAutoFetchDedupeForTests;
    server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing bridge test address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await realFetch(`${baseUrl}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            providers: [{ id: "test", name: "Test", url: "https://provider.test", enabled: true }],
            autoFetch: { enabled: true },
        }),
    });
    expect(response.status).toBe(200);
});

beforeEach(() => {
    resetDedupe();
    queuedPlaylists = [];
    rejectAppend = false;
    seriesName = "Doctor Who";
    episodeTitle = "Meia-noite";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/meta/series/")) {
            return Response.json({ meta: { videos: [{ id: "tt0436992:4:10", title: episodeTitle }] } });
        }
        if (url.includes("/stream/series/")) {
            return Response.json({
                streams: [
                    { url: "https://video.test/stream?token=preserve-me", title: "Release.S04E10.1080p.WEB-DL.mkv" },
                ],
            });
        }
        return Response.json({});
    });
});

afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
    if (originalConfigDir === undefined) delete process.env.STREMIO_MPV_CONFIG_DIR;
    else process.env.STREMIO_MPV_CONFIG_DIR = originalConfigDir;
    if (originalPipe === undefined) delete process.env.MPV_IPC_PATH;
    else process.env.MPV_IPC_PATH = originalPipe;
    fs.rmSync(dir, { recursive: true, force: true });
});

async function autoFetch(expectedAdded = 1): Promise<void> {
    const response = await realFetch(`${baseUrl}/auto-fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            imdbId: "tt0436992",
            name: seriesName,
            type: "series",
            season: 4,
            episode: 9,
            extraEpisodes: 1,
        }),
    });
    expect(await response.json()).toMatchObject({ success: true, added: expectedAdded });
    expect(queuedPlaylists).toHaveLength(1);
}

it("appends a named playlist entry before the episode is played, preserving its URL", async () => {
    await autoFetch();
    expect(queuedPlaylists).toHaveLength(1);
    expect(queuedPlaylists[0].content).toContain(
        "#EXTINF:-1,Doctor Who S04E10 - Meia-noite\nhttps://video.test/stream?token=preserve-me",
    );
    expect(fs.existsSync(queuedPlaylists[0].file)).toBe(false);
});

it("uses series and episode numbers when the provider has no episode title", async () => {
    episodeTitle = null;
    await autoFetch();
    expect(queuedPlaylists[0].content).toContain("#EXTINF:-1,Doctor Who S04E10\n");
});

it("also names anime entries and prevents multiline titles from injecting playlist entries", async () => {
    seriesName = "Dr. Stone";
    episodeTitle = "A New World\n#EXTINF:-1,unexpected";
    await autoFetch();
    expect(queuedPlaylists[0].content).toContain("#EXTINF:-1,Dr. Stone S04E10 - A New World - #EXTINF:-1,unexpected\n");
    expect(queuedPlaylists[0].content.split("\n").filter((line) => line.startsWith("#EXTINF:"))).toHaveLength(1);
});

it("cleans up temporary playlists when MPV rejects the append", async () => {
    rejectAppend = true;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
        await autoFetch(0);
        expect(queuedPlaylists).toHaveLength(1);
        expect(fs.existsSync(queuedPlaylists[0].file)).toBe(false);
    } finally {
        errorLog.mockRestore();
    }
});
