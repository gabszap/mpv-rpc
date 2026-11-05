import { describe, expect, it, vi } from "vitest";
import {
    buildStreamUrl,
    fetchStreamList,
    mapWithConcurrency,
    STREAM_FETCH_CONCURRENCY,
    STREAM_FETCH_TIMEOUT_MS,
} from "../stremio-mpv-bridge/userscript/src/stream-fetch.js";

type FetchResult = { kind: "response"; status: number; body: string } | { kind: "timeout" } | { kind: "error" };

const okBody = (streams: unknown[]): FetchResult => ({
    kind: "response",
    status: 200,
    body: JSON.stringify({ streams }),
});

describe("buildStreamUrl", () => {
    it("builds a series/season/episode url for imdb ids", () => {
        expect(buildStreamUrl("https://addon.test", "tt14976292", 4, 10)).toBe(
            "https://addon.test/stream/series/tt14976292:4:10.json",
        );
    });

    it("uses only the episode for kitsu ids", () => {
        expect(buildStreamUrl("https://addon.test", "kitsu:123", 1, 7)).toBe(
            "https://addon.test/stream/series/kitsu:123:7.json",
        );
    });
});

describe("fetchStreamList", () => {
    const options = { retryDelayMs: 0 };

    it("waits long enough for a provider that answers in about 10 to 11 seconds", () => {
        // The AIOStreams addon was measured at 10.0 to 11.0 s per request; the old 10 s limit
        // aborted a large share of those requests. The limit must leave clear headroom.
        expect(STREAM_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(25000);
    });

    it("passes the timeout to the request", async () => {
        const request = vi.fn(async () => okBody([{ title: "a" }]));

        await fetchStreamList("https://addon.test/x.json", request, options);

        expect(request).toHaveBeenCalledWith("https://addon.test/x.json", STREAM_FETCH_TIMEOUT_MS);
    });

    it("returns the streams of a successful response", async () => {
        const request = vi.fn(async () => okBody([{ title: "a" }, { title: "b" }]));

        const streams = await fetchStreamList("https://addon.test/x.json", request, options);

        expect(streams).toEqual([{ title: "a" }, { title: "b" }]);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("retries after a timeout and returns the streams of the second attempt", async () => {
        const request = vi
            .fn<() => Promise<FetchResult>>()
            .mockResolvedValueOnce({ kind: "timeout" })
            .mockResolvedValueOnce(okBody([{ title: "ok" }]));
        const onRetry = vi.fn();

        const streams = await fetchStreamList("https://addon.test/x.json", request, { ...options, onRetry });

        expect(streams).toEqual([{ title: "ok" }]);
        expect(request).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenCalledWith(2, 3);
    });

    it("gives up after three attempts and returns an empty list", async () => {
        const request = vi.fn(async () => ({ kind: "timeout" }) as FetchResult);

        const streams = await fetchStreamList("https://addon.test/x.json", request, options);

        expect(streams).toEqual([]);
        expect(request).toHaveBeenCalledTimes(3);
    });

    it("retries on a non-200 status and on a network error", async () => {
        const request = vi
            .fn<() => Promise<FetchResult>>()
            .mockResolvedValueOnce({ kind: "response", status: 503, body: "" })
            .mockResolvedValueOnce({ kind: "error" })
            .mockResolvedValueOnce(okBody([{ title: "third" }]));

        const streams = await fetchStreamList("https://addon.test/x.json", request, options);

        expect(streams).toEqual([{ title: "third" }]);
        expect(request).toHaveBeenCalledTimes(3);
    });

    it("does not retry a 200 response that is not valid JSON", async () => {
        const request = vi.fn(async () => ({ kind: "response", status: 200, body: "<html>" }) as FetchResult);

        const streams = await fetchStreamList("https://addon.test/x.json", request, options);

        expect(streams).toEqual([]);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("returns an empty list when the response has no streams field", async () => {
        const request = vi.fn(async () => ({ kind: "response", status: 200, body: "{}" }) as FetchResult);

        expect(await fetchStreamList("https://addon.test/x.json", request, options)).toEqual([]);
    });

    it("reports a slow provider once while a request is still pending", async () => {
        const onSlow = vi.fn();
        const request = vi.fn(
            () => new Promise<FetchResult>((resolve) => setTimeout(() => resolve(okBody([{ title: "late" }])), 80)),
        );

        const streams = await fetchStreamList("https://addon.test/x.json", request, {
            ...options,
            slowAfterMs: 20,
            onSlow,
        });

        expect(streams).toEqual([{ title: "late" }]);
        expect(onSlow).toHaveBeenCalledTimes(1);
    });

    it("does not report a slow provider when the answer is fast", async () => {
        const onSlow = vi.fn();
        const request = vi.fn(async () => okBody([]));

        await fetchStreamList("https://addon.test/x.json", request, { ...options, slowAfterMs: 50, onSlow });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(onSlow).not.toHaveBeenCalled();
    });
});

describe("mapWithConcurrency", () => {
    it("keeps the input order in the results", async () => {
        const results = await mapWithConcurrency([30, 10, 20], 3, async (ms: number) => {
            await new Promise((resolve) => setTimeout(resolve, ms));
            return ms;
        });

        expect(results).toEqual([30, 10, 20]);
    });

    it("never runs more than the limit at the same time", async () => {
        let running = 0;
        let peak = 0;

        await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 2, async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 10));
            running -= 1;
        });

        expect(peak).toBe(2);
    });

    it("uses a small default concurrency for the playlist fetch", () => {
        expect(STREAM_FETCH_CONCURRENCY).toBeGreaterThanOrEqual(2);
        expect(STREAM_FETCH_CONCURRENCY).toBeLessThanOrEqual(4);
    });

    it("handles an empty list", async () => {
        expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
    });
});
