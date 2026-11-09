import * as fs from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const nativeOs = require("node:os");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-playlist-isolation-"));
let server: Server;
let spawnMock: ReturnType<typeof vi.spyOn>;
const originalConfigDir = process.env.STREMIO_MPV_CONFIG_DIR;

beforeAll(async () => {
    process.env.STREMIO_MPV_CONFIG_DIR = tempDir;
    spawnMock = vi.spyOn(childProcess, "spawn").mockReturnValue({ pid: 123, once: vi.fn(), unref: vi.fn() });
    vi.spyOn(nativeOs, "tmpdir").mockReturnValue(tempDir);
    const imported = await import("../stremio-mpv-bridge/server.js");
    const { app } = imported.default ?? imported;
    server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
});

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    if (originalConfigDir === undefined) delete process.env.STREMIO_MPV_CONFIG_DIR;
    else process.env.STREMIO_MPV_CONFIG_DIR = originalConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

it("opens only the supplied streams despite MPV directory-autoload settings", async () => {
    fs.writeFileSync(path.join(tempDir, "old-mpv.ts"), "TypeScript source, not video");
    fs.writeFileSync(path.join(tempDir, "parser-test-new.ts"), "TypeScript source, not video");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            args: ["--autocreate-playlist=filter"],
            playlist: [
                { url: "https://example.test/episode.mkv", title: "Doctor Who" },
                { url: "https://example.test/legitimate-transport-stream.ts", title: "Next episode" },
            ],
        }),
    });
    expect(response.status).toBe(200);
    const args = spawnMock.mock.calls[0][1] as string[];
    const playlistPath = args.at(-1) as string;
    expect(args.filter((arg) => arg.startsWith("--autocreate-playlist=")).at(-1)).toBe("--autocreate-playlist=no");
    const playlist = fs.readFileSync(playlistPath, "utf8");
    expect(playlist).toContain("https://example.test/episode.mkv");
    expect(playlist).toContain("https://example.test/legitimate-transport-stream.ts");
    expect(playlist).not.toContain("old-mpv.ts");
    expect(playlist).not.toContain("parser-test-new.ts");
});
