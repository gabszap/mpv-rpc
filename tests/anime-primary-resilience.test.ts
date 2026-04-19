import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const primaryJikanSearchAnimeMock = vi.fn();
const primaryJikanFindSeasonAnimeMock = vi.fn();
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
        findSeasonAnime = primaryJikanFindSeasonAnimeMock;
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
        primaryJikanFindSeasonAnimeMock.mockReset();
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

        const cacheEntry = cacheData["jikan:attack on titan:1:any"];
        expect(cacheEntry?.data).toBeNull();
        expect(cacheEntry?.sourceProvider).toBe("kitsu");
    });

    it("caches anime info per episode context for same title and season", async () => {
        let seasonQueryCount = 0;

        primaryJikanSearchAnimeMock.mockImplementation(async (query: string) => {
            if (!query.toLowerCase().includes("season 3")) {
                return null;
            }

            seasonQueryCount++;
            if (seasonQueryCount === 1) {
                return {
                    id: 50612,
                    title: "Dr. Stone: Ryusui",
                    title_english: "Dr. Stone: Ryusui",
                    type: "Special",
                    coverImage: null,
                };
            }

            return {
                id: 58187,
                title: "Dr. Stone: New World",
                title_english: "Dr. STONE NEW WORLD",
                type: "TV",
                coverImage: null,
            };
        });

        const { getAnimeInfo } = await import("../src/anime");

        const episodeOneInfo = await getAnimeInfo("Dr Stone", 3, 1);
        const episodeTwelveInfo = await getAnimeInfo("Dr Stone", 3, 12);

        expect(episodeOneInfo?.id).toBe(50612);
        expect(episodeTwelveInfo?.id).toBe(58187);
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledWith("Dr Stone season 3");
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledTimes(4);

        const cachePath = path.join(testCwd, ".anime_cache", "anime_cache.json");
        const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, {
            data: {
                id?: number;
            } | null;
        }>;

        expect(cacheData["jikan:dr stone:3:1"]?.data?.id).toBe(50612);
        expect(cacheData["jikan:dr stone:3:12"]?.data?.id).toBe(58187);
    });

    it("invalidates stale special cache for S03E12 and resolves compatible season", async () => {
        const staleCacheDir = path.join(testCwd, ".anime_cache");
        fs.mkdirSync(staleCacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(staleCacheDir, "anime_cache.json"),
            JSON.stringify({
                "jikan:dr stone:3": {
                    data: {
                        id: 50612,
                        mal_id: 50612,
                        title_english: "Dr. Stone: Ryusui",
                        title_romaji: "Dr. Stone: Ryusui",
                        cover_url: null,
                        total_episodes: 1,
                    },
                    timestamp: Date.now(),
                    sourceProvider: "jikan",
                },
            })
        );

        primaryJikanSearchAnimeMock.mockImplementation(async (query: string) => {
            if (query.toLowerCase().includes("season 3")) {
                return {
                    id: 58187,
                    title: "Dr. Stone: New World",
                    title_english: "Dr. STONE NEW WORLD",
                    type: "TV",
                    coverImage: null,
                };
            }

            return {
                id: 50612,
                title: "Dr. Stone: Ryusui",
                title_english: "Dr. Stone: Ryusui",
                type: "Special",
                coverImage: null,
            };
        });

        primaryJikanFindSeasonAnimeMock.mockImplementation(async (baseId: number) => {
            if (baseId === 58187) {
                return {
                    id: 58187,
                    mal_id: 58187,
                    title_romaji: "Dr. Stone: New World",
                    title_english: "Dr. STONE NEW WORLD",
                    cover_url: null,
                    total_episodes: 22,
                };
            }

            return {
                id: 50612,
                mal_id: 50612,
                title_romaji: "Dr. Stone: Ryusui",
                title_english: "Dr. Stone: Ryusui",
                cover_url: null,
                total_episodes: 1,
            };
        });

        primaryJikanGetEpisodeTitleMock.mockResolvedValue(null);

        fallbackKitsuSearchAnimeMock.mockResolvedValue({
            id: 920,
            title: "Dr. Stone: New World",
            title_english: "Dr. STONE NEW WORLD",
            type: "TV",
            coverImage: null,
        });
        fallbackKitsuGetAnimeByIdMock.mockResolvedValue({
            id: 920,
            title_romaji: "Dr. Stone: New World",
            title_english: "Dr. STONE NEW WORLD",
            cover_url: null,
            total_episodes: 22,
        });
        fallbackKitsuGetEpisodeTitleMock.mockResolvedValue("Science Is Elegant");

        const { getEpisodeTitle } = await import("../src/anime");
        const title = await getEpisodeTitle("Dr Stone", 3, 12);

        expect(title).toBe("Science Is Elegant");
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalled();
        expect(primaryJikanGetEpisodeTitleMock).toHaveBeenCalledWith(
            58187,
            12,
            3,
            expect.objectContaining({
                searchTitle: "Dr Stone",
                allowSeasonInference: false,
            })
        );
        expect(primaryJikanGetEpisodeTitleMock).not.toHaveBeenCalledWith(
            50612,
            12,
            3,
            expect.anything()
        );
        expect(fallbackKitsuSearchAnimeMock).not.toHaveBeenCalledWith("Dr Stone season 3 season 3");
    });

    it("keeps split-cour season-family candidates ahead of sequel-family drift for explicit S03E12", async () => {
        primaryJikanSearchAnimeMock.mockImplementation(async (query: string) => {
            if (query.toLowerCase().includes("season 3")) {
                return {
                    id: 70001,
                    title: "Dr. Stone: Science Future Season 3",
                    title_english: "Dr. STONE SCIENCE FUTURE Season 3",
                    type: "TV",
                    coverImage: null,
                };
            }

            return {
                id: 70002,
                title: "Dr. Stone: New World",
                title_english: "Dr. STONE NEW WORLD",
                type: "TV",
                coverImage: null,
            };
        });

        primaryJikanFindSeasonAnimeMock.mockImplementation(async (baseId: number) => {
            if (baseId === 70001) {
                return {
                    id: 70001,
                    mal_id: 70001,
                    title_romaji: "Dr. Stone: Science Future Season 3",
                    title_english: "Dr. STONE SCIENCE FUTURE Season 3",
                    cover_url: null,
                    total_episodes: 24,
                };
            }

            return {
                id: 70002,
                mal_id: 70002,
                title_romaji: "Dr. Stone: New World",
                title_english: "Dr. STONE NEW WORLD Part 2",
                cover_url: null,
                total_episodes: 22,
            };
        });

        const { getAnimeInfo } = await import("../src/anime");
        const info = await getAnimeInfo("Dr Stone", 3, 12);

        expect(info?.id).toBe(70002);
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledWith("Dr Stone season 3");
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledWith("Dr Stone");
    });

    it("falls back when season-query result drifts to unrelated split-cour family", async () => {
        primaryJikanSearchAnimeMock.mockImplementation(async (query: string) => {
            if (query.toLowerCase().includes("season 3")) {
                return {
                    id: 62568,
                    title: "Dr. Stone: Science Future Part 3",
                    title_english: "Dr. Stone: Science Future Part 3",
                    type: "TV",
                    coverImage: null,
                };
            }

            return {
                id: 38691,
                title: "Dr. Stone",
                title_english: "Dr. Stone",
                type: "TV",
                coverImage: null,
            };
        });

        primaryJikanFindSeasonAnimeMock.mockImplementation(async (baseId: number) => {
            if (baseId === 62568) {
                return {
                    id: 62568,
                    mal_id: 62568,
                    title_romaji: "Dr. Stone: Science Future Part 3",
                    title_english: "Dr. Stone: Science Future Part 3",
                    cover_url: null,
                    total_episodes: 13,
                };
            }

            return {
                id: 50612,
                mal_id: 50612,
                title_romaji: "Dr. Stone: Ryuusui",
                title_english: "Dr. Stone: Ryusui",
                cover_url: null,
                total_episodes: 1,
            };
        });

        fallbackKitsuSearchAnimeMock.mockResolvedValue({
            id: 44289,
            title: "Dr.STONE: NEW WORLD Part 2",
            title_english: "Dr. Stone: New World Part 2",
            type: "TV",
            coverImage: null,
        });

        fallbackKitsuGetAnimeByIdMock.mockResolvedValue({
            id: 44289,
            title_romaji: "Dr.STONE: NEW WORLD Part 2",
            title_english: "Dr. Stone: New World Part 2",
            cover_url: null,
            total_episodes: 22,
        });

        const { getAnimeInfo } = await import("../src/anime");
        const info = await getAnimeInfo("Dr Stone", 3, 12);

        expect(info?.id).toBe(44289);
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledWith("Dr Stone season 3");
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledWith("Dr Stone");
        expect(fallbackKitsuSearchAnimeMock).toHaveBeenCalled();
    });

    it("does not treat part ordinals as split-cour markers during S03E12 ranking", async () => {
        primaryJikanSearchAnimeMock.mockImplementation(async (query: string) => {
            if (query.toLowerCase().includes("season 3")) {
                return {
                    id: 81001,
                    title: "Example Show Season 3",
                    title_english: "Example Show Season 3",
                    type: "TV",
                    coverImage: null,
                };
            }

            return {
                id: 81002,
                title: "Example Show Part 2nd Anniversary",
                title_english: "Example Show Part 2nd Anniversary",
                type: "TV",
                coverImage: null,
            };
        });

        primaryJikanFindSeasonAnimeMock.mockImplementation(async (baseId: number) => {
            if (baseId === 81001) {
                return {
                    id: 81001,
                    mal_id: 81001,
                    title_romaji: "Example Show Season 3",
                    title_english: "Example Show Season 3",
                    cover_url: null,
                    total_episodes: 24,
                };
            }

            return {
                id: 81002,
                mal_id: 81002,
                title_romaji: "Example Show Part 2nd Anniversary",
                title_english: "Example Show Part 2nd Anniversary",
                cover_url: null,
                total_episodes: 24,
            };
        });

        const { getAnimeInfo } = await import("../src/anime");
        const info = await getAnimeInfo("Example Show", 3, 12);

        expect(info?.id).toBe(81001);
    });

    it("does not penalize candidates with empty season-family keys when applying split-cour heuristics", async () => {
        primaryJikanSearchAnimeMock.mockImplementation(async (query: string) => {
            if (query.toLowerCase().includes("season 3")) {
                return {
                    id: 82001,
                    title: "Season 3",
                    title_english: "Season 3",
                    type: "TV",
                    coverImage: null,
                };
            }

            return {
                id: 82002,
                title: "Long Running Show Part 2",
                title_english: "Long Running Show Part 2",
                type: "TV",
                coverImage: null,
            };
        });

        primaryJikanFindSeasonAnimeMock.mockImplementation(async (baseId: number) => {
            if (baseId === 82001) {
                return {
                    id: 82001,
                    mal_id: 82001,
                    title_romaji: "Season 3",
                    title_english: "Season 3",
                    cover_url: null,
                    total_episodes: 24,
                };
            }

            return {
                id: 82002,
                mal_id: 82002,
                title_romaji: "Long Running Show Part 2",
                title_english: "Long Running Show Part 2",
                cover_url: null,
            };
        });

        const { getAnimeInfo } = await import("../src/anime");
        const info = await getAnimeInfo("Long Running Show", 3, 12);

        expect(info?.id).toBe(82001);
    });

    it("returns null without episode fallback when only incompatible entries exist", async () => {
        primaryJikanSearchAnimeMock.mockResolvedValue({
            id: 50612,
            title: "Dr. Stone: Ryusui",
            title_english: "Dr. Stone: Ryusui",
            type: "Special",
            coverImage: null,
        });

        primaryJikanFindSeasonAnimeMock.mockResolvedValue({
            id: 50612,
            mal_id: 50612,
            title_romaji: "Dr. Stone: Ryusui",
            title_english: "Dr. Stone: Ryusui",
            cover_url: null,
            total_episodes: 1,
        });

        fallbackKitsuSearchAnimeMock.mockResolvedValue({
            id: 777,
            title: "Dr. Stone: Ryusui",
            title_english: "Dr. Stone: Ryusui",
            type: "Special",
            coverImage: null,
        });
        fallbackKitsuGetAnimeByIdMock.mockResolvedValue({
            id: 777,
            title_romaji: "Dr. Stone: Ryusui",
            title_english: "Dr. Stone: Ryusui",
            cover_url: null,
            total_episodes: 1,
        });

        const { getEpisodeTitle } = await import("../src/anime");
        const title = await getEpisodeTitle("Dr Stone", 3, 12);

        expect(title).toBeNull();
        expect(primaryJikanGetEpisodeTitleMock).not.toHaveBeenCalled();
        expect(fallbackKitsuGetEpisodeTitleMock).not.toHaveBeenCalled();
    });
});
