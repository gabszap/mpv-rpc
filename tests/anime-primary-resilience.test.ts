import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const primaryJikanSearchAnimeMock = vi.fn();
const primaryJikanGetEpisodeTitleMock = vi.fn();

const fallbackKitsuSearchAnimeMock = vi.fn();
const fallbackKitsuGetAnimeByIdMock = vi.fn();
const fallbackKitsuGetEpisodeTitleMock = vi.fn();

vi.mock("../src/config", () => ({
    config: {
        metadataProvider: "jikan",
        tvdb: {
            apiKey: "",
        },
        debug: false,
    },
}));

vi.mock("../src/providers/jikan", () => ({
    JikanProvider: class {
        readonly name = "jikan";
        searchAnime = primaryJikanSearchAnimeMock;
        getAnimeById = vi.fn();
        getEpisodeTitle = primaryJikanGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
    },
}));

vi.mock("../src/providers/kitsu", () => ({
    KitsuProvider: class {
        readonly name = "kitsu";
        searchAnime = fallbackKitsuSearchAnimeMock;
        getAnimeById = fallbackKitsuGetAnimeByIdMock;
        getEpisodeTitle = fallbackKitsuGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
    },
}));

vi.mock("../src/providers/anilist", () => ({
    AniListProvider: class {
        readonly name = "anilist";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
    },
}));

vi.mock("../src/providers/tvdb", () => ({
    TvdbProvider: class {
        readonly name = "tvdb";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
    },
}));

describe("Anime provider resilience", () => {
    let testCwd: string;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        primaryJikanSearchAnimeMock.mockReset();
        primaryJikanGetEpisodeTitleMock.mockReset();
        fallbackKitsuSearchAnimeMock.mockReset();
        fallbackKitsuGetAnimeByIdMock.mockReset();
        fallbackKitsuGetEpisodeTitleMock.mockReset();

        testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-anime-cache-"));
        vi.spyOn(process, "cwd").mockReturnValue(testCwd);
    });

    afterEach(() => {
        fs.rmSync(testCwd, { recursive: true, force: true });
    });

    it("falls back to next provider when Jikan fails with 503/timeout", async () => {
        primaryJikanSearchAnimeMock.mockRejectedValueOnce({
            message: "Request failed with status code 503",
            response: {
                status: 503,
            },
        });

        fallbackKitsuSearchAnimeMock
            .mockResolvedValueOnce({
                id: 202,
                title: "Attack on Titan",
                title_english: "Attack on Titan",
                type: "TV",
                coverImage: null,
            })
            .mockResolvedValueOnce({
                id: 202,
                title: "Attack on Titan",
                title_english: "Attack on Titan",
                type: "TV",
                coverImage: null,
            });

        fallbackKitsuGetAnimeByIdMock.mockResolvedValue({
            id: 202,
            title_romaji: "Shingeki no Kyojin",
            title_english: "Attack on Titan",
            cover_url: null,
        });

        primaryJikanGetEpisodeTitleMock.mockRejectedValueOnce({
            message: "timeout of 15000ms exceeded",
            code: "ECONNABORTED",
        });

        fallbackKitsuGetEpisodeTitleMock.mockResolvedValueOnce("To You, in 2000 Years");

        const { getEpisodeTitle } = await import("../src/anime");
        const title = await getEpisodeTitle("Attack on Titan", 1, 1);

        expect(title).toBe("To You, in 2000 Years");
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledTimes(1);
        expect(primaryJikanGetEpisodeTitleMock).toHaveBeenCalledWith(
            202,
            1,
            1,
            expect.objectContaining({
                searchTitle: "Attack on Titan",
                allowSeasonInference: true,
            })
        );
        expect(fallbackKitsuSearchAnimeMock).toHaveBeenCalledTimes(2);
        expect(fallbackKitsuGetEpisodeTitleMock).toHaveBeenCalledWith(
            202,
            1,
            1,
            expect.objectContaining({
                searchTitle: "Attack on Titan",
                allowSeasonInference: true,
            })
        );
    });

    it("does not negative-cache null when a provider errors during anime resolution", async () => {
        const providerError = {
            message: "Request failed with status code 503",
            response: {
                status: 503,
            },
        };

        primaryJikanSearchAnimeMock.mockRejectedValue(providerError);
        fallbackKitsuSearchAnimeMock.mockResolvedValue(null);

        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const { getAnimeInfo } = await import("../src/anime");

        try {
            await expect(getAnimeInfo("Attack on Titan", 1)).resolves.toBeNull();
            await expect(getAnimeInfo("Attack on Titan", 1)).resolves.toBeNull();
        } finally {
            consoleErrorSpy.mockRestore();
        }

        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledTimes(2);
        expect(fallbackKitsuSearchAnimeMock).toHaveBeenCalledTimes(2);
    });

    it("keeps negative caching for true not-found results without provider errors", async () => {
        primaryJikanSearchAnimeMock.mockResolvedValue(null);
        fallbackKitsuSearchAnimeMock.mockResolvedValue(null);

        const { getAnimeInfo } = await import("../src/anime");

        await expect(getAnimeInfo("Attack on Titan", 1)).resolves.toBeNull();
        await expect(getAnimeInfo("Attack on Titan", 1)).resolves.toBeNull();

        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledTimes(1);
        expect(fallbackKitsuSearchAnimeMock).toHaveBeenCalledTimes(1);

        const cachePath = path.join(testCwd, ".anime_cache", "anime_cache.json");
        const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, {
            data: unknown;
            sourceProvider?: string;
        }>;

        const cacheEntry = cacheData["jikan:attack on titan:1"];
        expect(cacheEntry?.data).toBeNull();
        expect(cacheEntry?.sourceProvider).toBe("kitsu");
    });
});
