import { afterEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

const bridgeModule = await import("../stremio-mpv-bridge/server.js");
const { _autoFetchDedupeForTests } = bridgeModule.default ?? bridgeModule;

describe("bridge auto-fetch episode dedupe", () => {
    afterEach(() => {
        _autoFetchDedupeForTests.resetAutoFetchDedupeForTests();
    });

    it("reserves overlapping target episodes and releases failed lookups for later retries", () => {
        const key = _autoFetchDedupeForTests.buildAutoFetchEpisodeKey("tt9679542", "Dr. Stone", 4, 34);

        expect(_autoFetchDedupeForTests.reserveAutoFetchEpisodeKey(key)).toBe(true);
        expect(_autoFetchDedupeForTests.getAutoFetchEpisodeStatus(key)).toBe("in-flight");
        expect(_autoFetchDedupeForTests.reserveAutoFetchEpisodeKey(key)).toBe(false);

        _autoFetchDedupeForTests.releaseAutoFetchEpisodeKey(key);

        expect(_autoFetchDedupeForTests.getAutoFetchEpisodeStatus(key)).toBeNull();
        expect(_autoFetchDedupeForTests.reserveAutoFetchEpisodeKey(key)).toBe(true);
    });

    it("keeps completed target episodes idempotent for retried RPC requests", () => {
        const key = _autoFetchDedupeForTests.buildAutoFetchEpisodeKey("tt9679542", "Dr. Stone", 4, 34);

        expect(_autoFetchDedupeForTests.reserveAutoFetchEpisodeKey(key)).toBe(true);
        _autoFetchDedupeForTests.completeAutoFetchEpisodeKey(key);

        expect(_autoFetchDedupeForTests.getAutoFetchEpisodeStatus(key)).toBe("completed");
        expect(_autoFetchDedupeForTests.reserveAutoFetchEpisodeKey(key)).toBe(false);
    });

    it("detects season/episode markers from playlist filenames and titles", () => {
        expect(_autoFetchDedupeForTests.readEpisodeKeyFromPlaylistValue("Dr.STONE.S04E34.mkv")).toBe("S04E34");
        expect(_autoFetchDedupeForTests.readEpisodeKeyFromPlaylistValue("Auto fetched Dr Stone s4e5 stream")).toBe(
            "S04E05",
        );
        expect(_autoFetchDedupeForTests.readEpisodeKeyFromPlaylistValue("Dr Stone episode title only")).toBeNull();
    });

    it("rejects non-playable GitHub placeholder streams for unreleased episodes", () => {
        const stream = _autoFetchDedupeForTests.findBestStream(
            [
                {
                    externalUrl: "https://github.com/some-addon/catalog/blob/main/README.md",
                    title: "S04E35 not released yet - GitHub documentation",
                    name: "AIOStreams",
                },
            ],
            {},
        );

        expect(stream).toBeNull();
    });

    it("keeps direct media, manifests, magnet, and generic stream URLs playable", () => {
        expect(_autoFetchDedupeForTests.isPlayableStremioStream({ url: "magnet:?xt=urn:btih:abc123" })).toBe(true);
        expect(_autoFetchDedupeForTests.isPlayableStremioStream({ infoHash: "abc123" })).toBe(true);
        expect(_autoFetchDedupeForTests.isPlayableStremioStream({ url: "https://cdn.example.test/video.mkv" })).toBe(
            true,
        );
        expect(_autoFetchDedupeForTests.isPlayableStremioStream({ url: "https://cdn.example.test/live.m3u8" })).toBe(
            true,
        );
        expect(
            _autoFetchDedupeForTests.isPlayableStremioStream({ url: "https://stream.example.test/play/abc123" }),
        ).toBe(true);
        expect(
            _autoFetchDedupeForTests.isPlayableStremioStream({
                url: "https://cdn.example.test/video.mkv",
                title: "Fansub release mirrored on GitHub issue #1",
            }),
        ).toBe(true);
    });
});
