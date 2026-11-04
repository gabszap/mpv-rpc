import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const shared = require("../stremio-mpv-bridge/shared/stream-selection.js") as {
    getQualityAliases: (quality: string) => string[];
    extractReleaseGroup: (text: string) => string;
    findBestStream: (
        streams: Array<Record<string, unknown>>,
        config?: Record<string, unknown>,
        season?: number | null,
        episode?: number | null,
    ) => { url: string; title: string } | null;
};

const stream = (title: string, url: string): Record<string, unknown> => ({
    title,
    url,
    behaviorHints: { filename: title },
});

describe("shared stream selection", () => {
    it.each([
        ["4K", ["4k", "2160p"]],
        ["2160p", ["4k", "2160p"]],
        ["2K", ["2k", "1440p"]],
        ["FHD", ["fhd", "1080p"]],
        ["1080p", ["fhd", "1080p"]],
        ["HD", ["hd", "720p"]],
        ["480p", ["480p"]],
    ])("resolves equivalent quality alias for %s", (input, expected) => {
        expect(shared.getQualityAliases(input)).toEqual(expected);
    });

    it("treats 4K and 2160p preferences as the same quality", () => {
        const streams = [
            stream("Show S01E01 1080p", "https://a/1.mkv"),
            stream("Show S01E01 2160p", "https://a/2.mkv"),
        ];
        expect(shared.findBestStream(streams, { preferredQuality: "4k" })?.url).toBe("https://a/2.mkv");
        expect(shared.findBestStream(streams, { preferredQuality: "2160p" })?.url).toBe("https://a/2.mkv");
    });

    it("uses the injected playability predicate instead of the default", () => {
        const streams = [stream("Show 1080p", "https://blocked/1.mkv"), stream("Show 1080p", "https://ok/2.mkv")];
        const best = shared.findBestStream(streams, {
            isPlayable: (s: { url?: string }) => !s.url?.includes("blocked"),
        });
        expect(best?.url).toBe("https://ok/2.mkv");
    });

    it("by default only accepts http(s) urls or torrent info hashes", () => {
        expect(shared.findBestStream([{ title: "x", url: "ftp://nope" }])).toBeNull();
        expect(shared.findBestStream([{ title: "x", infoHash: "a".repeat(40) }])?.url).toContain(
            "magnet:?xt=urn:btih:",
        );
    });

    it("reports a preferred match through the optional logger", () => {
        const log = vi.fn();
        const streams = [stream("[SubsPlease] Show - 05 (1080p)", "https://a/1.mkv")];
        shared.findBestStream(streams, { preferredGroup: "SubsPlease", log }, 1, 5);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("Found preferred stream"));
    });

    it("extracts the release group from bracketed names", () => {
        expect(shared.extractReleaseGroup("[SubsPlease] Show - 05 (1080p)").toLowerCase()).toContain("subsplease");
    });
});

describe("single source of truth for stream selection", () => {
    const definition = /function getQualityAliases\s*\(/g;

    it("is defined only in shared/stream-selection.js", async () => {
        const server = await readFile(new URL("../stremio-mpv-bridge/server.js", import.meta.url), "utf8");
        const adapter = await readFile(
            new URL("../stremio-mpv-bridge/userscript/src/stream-selection.js", import.meta.url),
            "utf8",
        );
        const sharedSource = await readFile(
            new URL("../stremio-mpv-bridge/shared/stream-selection.js", import.meta.url),
            "utf8",
        );
        expect(server.match(definition)).toBeNull();
        expect(adapter.match(definition)).toBeNull();
        expect(sharedSource.match(definition)).toHaveLength(1);
    });

    it("ships exactly one copy in the built userscript", async () => {
        const built = await readFile(new URL("../stremio-mpv-bridge/stremio-mpv.user.js", import.meta.url), "utf8");
        expect(built.match(definition)).toHaveLength(1);
    });
});
