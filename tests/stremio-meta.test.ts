import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios");
vi.mock("../src/stremio-sync/sync", () => ({
    appendSyncLog: vi.fn(),
}));

const mockedAxios = vi.mocked(axios);

describe("fetchVideoIds", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear the cache between tests
        vi.resetModules();
    });

    it("returns video IDs on success", async () => {
        const { fetchVideoIds } = await import("../src/stremio-sync/meta");
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: {
                meta: {
                    videos: [
                        { id: "tt1:1:1", title: "Ep 1", season: 1, episode: 1 },
                        { id: "tt1:1:2", title: "Ep 2", season: 1, episode: 2 },
                    ],
                },
            },
        });

        const result = await fetchVideoIds("tt1");
        expect(result).toEqual(["tt1:1:1", "tt1:1:2"]);
    });

    it("returns null for non-tt imdbId", async () => {
        const { fetchVideoIds } = await import("../src/stremio-sync/meta");
        const result = await fetchVideoIds("mal:123");
        expect(result).toBeNull();
    });

    it("returns null on HTTP error", async () => {
        const { fetchVideoIds } = await import("../src/stremio-sync/meta");
        mockedAxios.get.mockResolvedValue({ status: 500, data: null });
        const result = await fetchVideoIds("tt1");
        expect(result).toBeNull();
    });

    it("returns null when no videos found", async () => {
        const { fetchVideoIds } = await import("../src/stremio-sync/meta");
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: { meta: { videos: [] } },
        });
        const result = await fetchVideoIds("tt1");
        expect(result).toBeNull();
    });

    it("caches results", async () => {
        const { fetchVideoIds } = await import("../src/stremio-sync/meta");
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: {
                meta: {
                    videos: [{ id: "tt1:1:1", title: "Ep 1", season: 1, episode: 1 }],
                },
            },
        });

        await fetchVideoIds("tt1");
        await fetchVideoIds("tt1");
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it("refetches after cache TTL expires", async () => {
        const { fetchVideoIds } = await import("../src/stremio-sync/meta");

        vi.useFakeTimers();

        mockedAxios.get.mockResolvedValueOnce({
            status: 200,
            data: { meta: { videos: [{ id: "tt1:1:1", season: 1, episode: 1 }] } },
        });
        await fetchVideoIds("tt1");
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);

        // Advance time past TTL (24h + 1s)
        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);

        mockedAxios.get.mockResolvedValueOnce({
            status: 200,
            data: { meta: { videos: [{ id: "tt1:1:1", season: 1, episode: 1 }] } },
        });
        await fetchVideoIds("tt1");
        expect(mockedAxios.get).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
    });
});
