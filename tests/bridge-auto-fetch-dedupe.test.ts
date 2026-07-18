import * as fs from "node:fs";
import type { Server } from "node:http";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalBridgeConfigDir = process.env.STREMIO_MPV_CONFIG_DIR;
const bridgeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-auto-fetch-test-"));
process.env.STREMIO_MPV_CONFIG_DIR = bridgeConfigDir;
process.env.NODE_ENV = "test";

const bridgeModule = await import("../stremio-mpv-bridge/server.js");
const { app, _autoFetchDedupeForTests } = bridgeModule.default ?? bridgeModule;

function clearBridgeConfigDir(): void {
    for (const entry of fs.readdirSync(bridgeConfigDir)) {
        fs.rmSync(path.join(bridgeConfigDir, entry), { recursive: true, force: true });
    }
}

function listenBridgeApp(): Promise<Server> {
    return new Promise((resolve) => {
        const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

function postJson(server: Server, endpoint: string, payload: unknown): Promise<{ statusCode: number; body: unknown }> {
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Bridge test server did not expose a TCP address");
    }

    const requestBody = JSON.stringify(payload);
    const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: (address as AddressInfo).port,
        path: endpoint,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestBody),
        },
    };

    return new Promise((resolve, reject) => {
        const request = http.request(options, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
                const rawBody = Buffer.concat(chunks).toString("utf-8");
                const parsedBody = rawBody ? JSON.parse(rawBody) : null;
                resolve({ statusCode: response.statusCode ?? 0, body: parsedBody });
            });
        });

        request.on("error", reject);
        request.write(requestBody);
        request.end();
    });
}

describe("bridge auto-fetch episode dedupe", () => {
    afterEach(() => {
        _autoFetchDedupeForTests.resetAutoFetchDedupeForTests();
        clearBridgeConfigDir();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    afterAll(() => {
        fs.rmSync(bridgeConfigDir, { recursive: true, force: true });
        if (originalBridgeConfigDir === undefined) {
            delete process.env.STREMIO_MPV_CONFIG_DIR;
            return;
        }

        process.env.STREMIO_MPV_CONFIG_DIR = originalBridgeConfigDir;
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

    it("builds deduped release meta identifiers from Stremio library context", () => {
        expect(
            _autoFetchDedupeForTests.buildReleaseMetaCandidateIds("tt9679542", {
                seriesId: "mal:48549",
                libraryItemId: "kitsu:12345",
                imdbId: "tt9679542",
            }),
        ).toEqual(["mal:48549", "kitsu:12345", "tt9679542"]);
    });

    it("caches completed not-found lookups so repeated requests skip stream provider calls", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/")) {
                return Response.json({
                    meta: {
                        videos: [{ id: "tt9679542:4:35" }, { id: "tt9679542:4:36" }],
                    },
                });
            }

            return Response.json({ streams: [] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "AIOStreams" }],
        };

        const first = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            34,
            2,
            [],
        );
        const streamCallsAfterFirstRequest = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));

        const second = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            34,
            2,
            [],
        );
        const streamCallsAfterSecondRequest = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));

        expect(first).toMatchObject({ items: [], newlyNotFound: 2, skippedNotFound: 0 });
        expect(second).toMatchObject({ items: [], newlyNotFound: 0, skippedNotFound: 2 });
        expect(streamCallsAfterFirstRequest).toHaveLength(2);
        expect(streamCallsAfterSecondRequest).toHaveLength(2);
    });

    it("expires not-found entries so newly released episodes can be retried later", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-09T22:00:00.000Z"));
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/")) {
                return Response.json({ meta: { videos: [{ id: "tt9679542:4:35" }] } });
            }

            return Response.json({ streams: [] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "AIOStreams" }],
        };

        await _autoFetchDedupeForTests.collectNextEpisodes(config, "tt9679542", "Dr. Stone", 4, 34, 1, []);
        vi.setSystemTime(new Date(Date.now() + _autoFetchDedupeForTests.AUTO_FETCH_NOT_FOUND_TTL_MS + 1));
        await _autoFetchDedupeForTests.collectNextEpisodes(config, "tt9679542", "Dr. Stone", 4, 34, 1, []);

        const streamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));
        expect(streamCalls).toHaveLength(2);
    });

    it("does not cache incomplete stream lookups as not found", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/")) {
                return Response.json({ meta: { videos: [{ id: "tt9679542:4:35" }] } });
            }

            return new Response(JSON.stringify({ error: "gateway timeout" }), { status: 504 });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "AIOStreams" }],
        };
        const key = _autoFetchDedupeForTests.buildAutoFetchEpisodeKey("tt9679542", "Dr. Stone", 4, 35);

        const result = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            34,
            1,
            [],
        );

        expect(result).toMatchObject({ items: [], newlyNotFound: 0, skippedNotFound: 0 });
        expect(_autoFetchDedupeForTests.getAutoFetchEpisodeStatus(key)).toBeNull();
    });

    it("skips future targets when active addon meta says they are unreleased", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/")) {
                return Response.json({
                    meta: {
                        videos: [
                            { id: "tt9679542:4:35", released: "2026-06-05T15:00:00.000Z" },
                            { id: "tt9679542:4:36", released: "2026-06-19T15:00:00.000Z" },
                            { id: "tt9679542:4:37", releaseDate: "2026-06-26T15:00:00.000Z" },
                        ],
                    },
                });
            }

            return Response.json({ streams: [{ url: "https://streams.example.test/future.mkv" }] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "AIOStreams" }],
        };

        const result = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            35,
            2,
            [],
        );

        const streamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));
        expect(result).toMatchObject({ items: [], skippedUnreleased: 2, newlyNotFound: 0 });
        expect(streamCalls).toHaveLength(0);
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("target not released, skipping auto-fetch"));
    });

    it("skips future targets when addon meta is keyed by Stremio library identifiers", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/mal:48549.json")) {
                return Response.json({
                    meta: {
                        videos: [{ id: "mal:48549:4:36", released: "2026-06-19T15:00:00.000Z" }],
                    },
                });
            }

            if (url.includes("/meta/series/")) {
                return Response.json({ meta: { videos: [] } });
            }

            return Response.json({ streams: [{ url: "https://streams.example.test/future.mkv" }] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "Library Meta Addon" }],
        };

        const result = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            35,
            1,
            [],
            { seriesId: "mal:48549", libraryItemId: "mal:48549" },
        );

        const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/meta/series/"));
        const streamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));
        expect(result).toMatchObject({ items: [], skippedUnreleased: 1, newlyNotFound: 0 });
        expect(String(metaCalls[0][0])).toContain("/meta/series/mal:48549.json");
        expect(streamCalls).toHaveLength(0);
    });

    it("fetches released targets while skipping future targets from mixed addon meta", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/")) {
                return Response.json({
                    meta: {
                        videos: [
                            { id: "tt9679542:4:36", released: "2026-06-11T15:00:00.000Z" },
                            { id: "tt9679542:4:37", released: "2026-06-19T15:00:00.000Z" },
                        ],
                    },
                });
            }

            if (url.includes("tt9679542:4:36")) {
                return Response.json({ streams: [{ url: "https://streams.example.test/dr-stone-s04e36.mkv" }] });
            }

            return Response.json({ streams: [{ url: "https://streams.example.test/dr-stone-s04e37.mkv" }] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "Any Meta Addon" }],
        };

        const result = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            35,
            2,
            [],
        );

        const streamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));
        expect(result).toMatchObject({ skippedUnreleased: 1, newlyNotFound: 0 });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({ season: 4, episode: 36 });
        expect(streamCalls).toHaveLength(1);
        expect(String(streamCalls[0][0])).toContain("tt9679542:4:36");
    });

    it("keeps stream lookup fallback when addon meta does not confirm release state", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/")) {
                return Response.json({ meta: { videos: [{ id: "tt9679542:4:36" }] } });
            }

            return Response.json({ streams: [] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "Generic Addon" }],
        };

        const result = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            35,
            1,
            [],
        );

        const streamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));
        expect(result).toMatchObject({ skippedUnreleased: 0, newlyNotFound: 1 });
        expect(streamCalls).toHaveLength(1);
    });

    it("continues release checks when first candidate is unknown and second confirms unreleased", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/mal:48549.json")) {
                return Response.json({ meta: { videos: [{ id: "mal:48549:4:36" }] } });
            }

            if (url.includes("/meta/series/kitsu:12345.json")) {
                return Response.json({
                    meta: { videos: [{ id: "kitsu:12345:4:36", released: "2026-06-19T15:00:00.000Z" }] },
                });
            }

            return Response.json({ meta: { videos: [] } });
        });
        vi.stubGlobal("fetch", fetchMock);

        const status = await _autoFetchDedupeForTests.checkEpisodeReleaseStatus(
            [{ enabled: true, url: "https://provider.example", name: "Library Meta Addon" }],
            "tt9679542",
            { season: 4, episode: 36 },
            Date.now(),
            { seriesId: "mal:48549", libraryItemId: "kitsu:12345" },
        );

        const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/meta/series/"));
        expect(status).toMatchObject({ status: "unreleased", source: "Library Meta Addon meta kitsu:12345" });
        expect(metaCalls).toHaveLength(2);
    });

    it("continues release checks when first candidate is unknown and second confirms released", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/mal:48549.json")) {
                return Response.json({ meta: { videos: [{ id: "mal:48549:4:36" }] } });
            }

            if (url.includes("/meta/series/kitsu:12345.json")) {
                return Response.json({
                    meta: { videos: [{ id: "kitsu:12345:4:36", released: "2026-06-05T15:00:00.000Z" }] },
                });
            }

            return Response.json({ meta: { videos: [] } });
        });
        vi.stubGlobal("fetch", fetchMock);

        const status = await _autoFetchDedupeForTests.checkEpisodeReleaseStatus(
            [{ enabled: true, url: "https://provider.example", name: "Library Meta Addon" }],
            "tt9679542",
            { season: 4, episode: 36 },
            Date.now(),
            { seriesId: "mal:48549", libraryItemId: "kitsu:12345" },
        );

        const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/meta/series/"));
        expect(status).toMatchObject({ status: "released", source: "Library Meta Addon meta kitsu:12345" });
        expect(metaCalls).toHaveLength(2);
    });

    it("keeps stream lookup fallback after all release candidates are unknown", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/mal:48549.json")) {
                return Response.json({ meta: { videos: [{ id: "mal:48549:4:36" }] } });
            }

            if (url.includes("/meta/series/kitsu:12345.json")) {
                return Response.json({ meta: { videos: [{ id: "kitsu:12345:4:36" }] } });
            }

            if (url.includes("/meta/series/tt9679542.json")) {
                return Response.json({ meta: { videos: [{ id: "tt9679542:4:36" }] } });
            }

            return Response.json({ streams: [] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "Library Meta Addon" }],
        };

        const result = await _autoFetchDedupeForTests.collectNextEpisodes(
            config,
            "tt9679542",
            "Dr. Stone",
            4,
            35,
            1,
            [],
            { seriesId: "mal:48549", libraryItemId: "kitsu:12345" },
        );

        const streamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream/"));
        expect(result).toMatchObject({ skippedUnreleased: 0, newlyNotFound: 1 });
        expect(streamCalls).toHaveLength(1);
    });

    it("caches addon meta release checks for roughly ten minutes", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/meta/series/")) {
                return Response.json({
                    meta: {
                        videos: [{ id: "tt9679542:4:36", released: "2026-06-19T15:00:00.000Z" }],
                    },
                });
            }

            return Response.json({ streams: [] });
        });
        vi.stubGlobal("fetch", fetchMock);

        const config = {
            providers: [{ enabled: true, url: "https://provider.example", name: "Generic Addon" }],
        };

        await _autoFetchDedupeForTests.collectNextEpisodes(config, "tt9679542", "Dr. Stone", 4, 35, 1, []);
        await _autoFetchDedupeForTests.collectNextEpisodes(config, "tt9679542", "Dr. Stone", 4, 35, 1, []);

        const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/meta/series/"));
        expect(metaCalls).toHaveLength(1);
        expect(_autoFetchDedupeForTests.RELEASE_CHECK_TTL_MS).toBe(10 * 60 * 1000);
    });

    it("uses saved normalized providers for partial /auto-fetch playback context requests", async () => {
        const server = await listenBridgeApp();
        try {
            const configResponse = await postJson(server, "/config", {
                providers: [{ id: "torrentio", name: "Torrentio", url: "https://provider.example", enabled: true }],
                autoFetch: { enabled: true },
                extraEpisodes: 1,
                iconMode: "default",
                playlistMode: "batch",
                mpvShortcut: "v",
                preferredGroup: "",
                preferredQuality: "",
                mpvArgsStr: "",
                debug: false,
            });
            expect(configResponse.statusCode).toBe(200);

            const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.includes("/meta/series/")) {
                    return Response.json({ meta: { videos: [{ id: "tt1234567:1:2" }] } });
                }

                if (url.includes("/stream/")) {
                    return Response.json({ streams: [] });
                }

                return Response.json({});
            });
            vi.stubGlobal("fetch", fetchMock);

            const autoFetchResponse = await postJson(server, "/auto-fetch", {
                imdbId: "tt1234567",
                name: "Test Show",
                season: 1,
                episode: 1,
                type: "series",
                extraEpisodes: 1,
                providers: [],
            });

            expect(autoFetchResponse.statusCode).toBe(200);
            expect(autoFetchResponse.body).toMatchObject({ success: true, status: "no_released_episodes" });
            expect(
                fetchMock.mock.calls.some(([url]) => String(url).includes("https://provider.example/meta/series/")),
            ).toBe(true);
            expect(fetchMock.mock.calls.some(([url]) => String(url).includes("https://provider.example/stream/"))).toBe(
                true,
            );
        } finally {
            await closeServer(server);
        }
    });

    it("keeps invalid provider config rejected by /config", async () => {
        const server = await listenBridgeApp();
        try {
            const response = await postJson(server, "/config", {
                providers: [{ id: "broken", name: "Broken", url: 123, enabled: true }],
            });

            expect(response.statusCode).toBe(400);
            expect(response.body).toMatchObject({
                error: "Invalid provider at index 0: provider.url must be a string",
            });
        } finally {
            await closeServer(server);
        }
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

    it("prunes auto-fetched playback contexts after six hours without changing not-found TTL", () => {
        const sixHoursMs = 6 * 60 * 60 * 1000;
        const now = Date.parse("2026-06-10T12:00:00.000Z");

        const contexts = _autoFetchDedupeForTests.pruneAutoFetchedPlaybackContexts(
            {
                fresh: { savedAt: new Date(now - sixHoursMs + 1).toISOString() },
                expired: { savedAt: new Date(now - sixHoursMs - 1).toISOString() },
            },
            now,
        );

        expect(_autoFetchDedupeForTests.AUTO_FETCH_CONTEXT_TTL_MS).toBe(sixHoursMs);
        expect(_autoFetchDedupeForTests.AUTO_FETCH_NOT_FOUND_TTL_MS).toBe(45 * 60 * 1000);
        expect(contexts).toEqual({
            fresh: { savedAt: new Date(now - sixHoursMs + 1).toISOString() },
        });
    });

    it("stores bounded auto-fetched playback contexts for appended episodes", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-10T10:05:00.000Z"));
        const sourceContext = {
            libraryItemId: "mal:57658",
            seriesId: "mal:57658",
            imdbId: "tt12343534",
            videoId: "tt12343534:3:8",
            name: "Jujutsu Kaisen",
            type: "series",
            season: 3,
            episode: 8,
            episodesInSeason: null,
        };
        const items = [
            {
                url: "https://streams.example.test/jjk-s03e08.mkv",
                title: "Jujutsu Kaisen S03E08",
                season: 3,
                episode: 8,
            },
            {
                url: "https://streams.example.test/jjk-s03e09.mkv",
                title: "Jujutsu Kaisen S03E09",
                season: 3,
                episode: 9,
            },
            {
                url: "https://streams.example.test/jjk-s03e10.mkv",
                title: "Jujutsu Kaisen S03E10",
                season: 3,
                episode: 10,
            },
        ];

        const updated = _autoFetchDedupeForTests.upsertAutoFetchedPlaybackContexts({}, sourceContext, items);
        const contexts = updated.autoFetchedPlaybackContexts;
        const episode8Keys = _autoFetchDedupeForTests.buildAutoFetchedPlaybackMatchKeys(items[0].url, items[0].title);
        const episode9Keys = _autoFetchDedupeForTests.buildAutoFetchedPlaybackMatchKeys(items[1].url, items[1].title);
        const episode10Keys = _autoFetchDedupeForTests.buildAutoFetchedPlaybackMatchKeys(items[2].url, items[2].title);

        expect(contexts[episode8Keys[0]]).toMatchObject({
            libraryItemId: "mal:57658",
            seriesId: "mal:57658",
            imdbId: "tt12343534",
            videoId: "tt12343534:3:8",
            name: "Jujutsu Kaisen",
            type: "series",
            season: 3,
            episode: 8,
        });
        expect(contexts[episode9Keys[0]]).toMatchObject({ videoId: "tt12343534:3:9", season: 3, episode: 9 });
        expect(contexts[episode10Keys[0]]).toMatchObject({ videoId: "tt12343534:3:10", season: 3, episode: 10 });
        expect(JSON.stringify(contexts)).not.toContain(items[0].url);
        expect(JSON.stringify(contexts)).not.toContain(items[1].url);
        expect(JSON.stringify(contexts)).not.toContain(items[2].url);

        const manyItems = Array.from({ length: 60 }, (_, index) => ({
            url: `https://streams.example.test/jjk-s03e${String(index + 10).padStart(2, "0")}.mkv`,
            title: `Jujutsu Kaisen S03E${String(index + 10).padStart(2, "0")}`,
            season: 3,
            episode: index + 10,
        }));
        const bounded = _autoFetchDedupeForTests.upsertAutoFetchedPlaybackContexts(updated, sourceContext, manyItems);
        expect(Object.keys(bounded.autoFetchedPlaybackContexts)).toHaveLength(
            _autoFetchDedupeForTests.AUTO_FETCH_CONTEXT_MAX_ENTRIES,
        );
    });

    it("resolves preferred quality using equivalent aliases", () => {
        const streams = [
            { url: "https://streams.example.test/1080p.mkv", title: "Show S01E01 1080p" },
            { url: "https://streams.example.test/2160p.mkv", title: "Show S01E01 2160p" },
        ];

        // Searching 4k should pick 2160p
        const stream4k = _autoFetchDedupeForTests.findBestStream(streams, { preferredQuality: "4k" });
        expect(stream4k.url).toBe("https://streams.example.test/2160p.mkv");

        // Searching 2160p should pick 2160p
        const stream2160p = _autoFetchDedupeForTests.findBestStream(streams, { preferredQuality: "2160p" });
        expect(stream2160p.url).toBe("https://streams.example.test/2160p.mkv");

        const streams4kName = [
            { url: "https://streams.example.test/1080p.mkv", title: "Show S01E01 1080p" },
            { url: "https://streams.example.test/4k.mkv", title: "Show S01E01 4K HDR" },
        ];

        // Searching 2160p should pick 4K
        const stream4kNameResolved = _autoFetchDedupeForTests.findBestStream(streams4kName, {
            preferredQuality: "2160p",
        });
        expect(stream4kNameResolved.url).toBe("https://streams.example.test/4k.mkv");

        // Searching 4k should pick 4K
        const stream4kNameResolved2 = _autoFetchDedupeForTests.findBestStream(streams4kName, {
            preferredQuality: "4k",
        });
        expect(stream4kNameResolved2.url).toBe("https://streams.example.test/4k.mkv");

        const streams2k = [
            { url: "https://streams.example.test/1080p.mkv", title: "Show S01E01 1080p" },
            { url: "https://streams.example.test/2k.mkv", title: "Show S01E01 2K QHD" },
        ];

        // Searching 1440p should pick 2K
        const stream2kResolved = _autoFetchDedupeForTests.findBestStream(streams2k, { preferredQuality: "1440p" });
        expect(stream2kResolved.url).toBe("https://streams.example.test/2k.mkv");
    });
});
