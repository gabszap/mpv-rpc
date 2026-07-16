import { beforeEach, describe, expect, it, vi } from "vitest";

const primarySearchAnimeMock = vi.fn();
const primaryGetEpisodeTitleMock = vi.fn();
const primaryFindSeasonAnimeMock = vi.fn();

const fallbackJikanSearchAnimeMock = vi.fn();
const fallbackJikanGetAnimeByIdMock = vi.fn();
const fallbackJikanGetEpisodeTitleMock = vi.fn();
const fallbackJikanFindSeasonAnimeMock = vi.fn();

const fallbackKitsuSearchAnimeMock = vi.fn();
const fallbackKitsuGetAnimeByIdMock = vi.fn();
const fallbackKitsuGetEpisodeTitleMock = vi.fn();
const fallbackKitsuFindSeasonAnimeMock = vi.fn();

vi.mock("../src/config", () => ({
    config: {
        metadataProvider: "anilist",
        tvdb: {
            apiKey: "",
        },
        debug: false,
    },
}));

vi.mock("../src/providers/anilist", () => ({
    AniListProvider: class {
        readonly name = "anilist";
        searchAnime = primarySearchAnimeMock;
        getAnimeById = vi.fn();
        getEpisodeTitle = primaryGetEpisodeTitleMock;
        findSeasonAnime = primaryFindSeasonAnimeMock;
    },
}));

vi.mock("../src/providers/jikan", () => ({
    JikanProvider: class {
        readonly name = "jikan";
        searchAnime = fallbackJikanSearchAnimeMock;
        getAnimeById = fallbackJikanGetAnimeByIdMock;
        getEpisodeTitle = fallbackJikanGetEpisodeTitleMock;
        findSeasonAnime = fallbackJikanFindSeasonAnimeMock;
    },
}));

vi.mock("../src/providers/kitsu", () => ({
    KitsuProvider: class {
        readonly name = "kitsu";
        searchAnime = fallbackKitsuSearchAnimeMock;
        getAnimeById = fallbackKitsuGetAnimeByIdMock;
        getEpisodeTitle = fallbackKitsuGetEpisodeTitleMock;
        findSeasonAnime = fallbackKitsuFindSeasonAnimeMock;
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

describe("Anime fallback search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("prioritizes parsed anime title before provider canonical titles", async () => {
        const parsedTitle = "Dr Stone New World";

        primarySearchAnimeMock.mockResolvedValue({
            id: 101,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        primaryFindSeasonAnimeMock.mockResolvedValue({
            id: 101,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
        });
        primaryGetEpisodeTitleMock.mockResolvedValue(null);

        fallbackJikanSearchAnimeMock.mockImplementation(async (query: string) => {
            if (query === parsedTitle) {
                return {
                    id: 777,
                    title: parsedTitle,
                    title_english: parsedTitle,
                    type: "TV",
                    coverImage: null,
                };
            }
            return null;
        });
        fallbackJikanFindSeasonAnimeMock.mockResolvedValue({
            id: 777,
            title_romaji: parsedTitle,
            title_english: parsedTitle,
            cover_url: null,
            total_episodes: 12,
            seasonValidation: { expectedSeason: 2, method: "relation-chain" },
        });
        fallbackJikanGetEpisodeTitleMock.mockResolvedValue("A New World");

        const { getEpisodeTitle } = await import("../src/anime");
        const title = await getEpisodeTitle(parsedTitle, 2, 3);

        expect(title).toBe("A New World");
        expect(fallbackJikanSearchAnimeMock).toHaveBeenCalledTimes(1);
        expect(fallbackJikanSearchAnimeMock).toHaveBeenNthCalledWith(1, parsedTitle, 2);
        expect(fallbackJikanSearchAnimeMock).not.toHaveBeenCalledWith("Dr Stone");
        expect(fallbackKitsuSearchAnimeMock).not.toHaveBeenCalled();
    });

    it("rejects a Kitsu title-search fallback when the season is guessed even if it has enough episodes", async () => {
        primarySearchAnimeMock.mockResolvedValue({
            id: 101,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        primaryFindSeasonAnimeMock.mockResolvedValue({
            id: 101,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
        });
        primaryGetEpisodeTitleMock.mockResolvedValue(null);
        fallbackJikanSearchAnimeMock.mockResolvedValue(null);
        fallbackKitsuSearchAnimeMock.mockResolvedValue({
            id: 999,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        fallbackKitsuFindSeasonAnimeMock.mockResolvedValue({
            id: 999,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
            total_episodes: 24,
        });
        fallbackKitsuGetEpisodeTitleMock.mockResolvedValue("Wrong Season Title");

        const { getEpisodeTitle } = await import("../src/anime");

        await expect(getEpisodeTitle("Dr Stone", 4, 11)).resolves.toBeNull();
        expect(fallbackKitsuGetEpisodeTitleMock).not.toHaveBeenCalled();
    });

    it("accepts a Kitsu title-search fallback after validating the expected season and episode", async () => {
        primarySearchAnimeMock.mockResolvedValue({
            id: 101,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        primaryFindSeasonAnimeMock.mockResolvedValue({
            id: 101,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
        });
        primaryGetEpisodeTitleMock.mockResolvedValue(null);
        fallbackJikanSearchAnimeMock.mockResolvedValue(null);
        fallbackKitsuSearchAnimeMock.mockResolvedValue({
            id: 900,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        fallbackKitsuFindSeasonAnimeMock.mockResolvedValue({
            id: 944,
            title_romaji: "Dr Stone Science Future Part 3",
            title_english: "Dr. STONE Science Future Part 3",
            cover_url: null,
            total_episodes: 13,
            seasonValidation: { expectedSeason: 4, method: "relation-chain" },
        });
        fallbackKitsuGetEpisodeTitleMock.mockResolvedValue("Giant Step");

        const { getEpisodeTitle } = await import("../src/anime");

        await expect(getEpisodeTitle("Dr Stone", 4, 11)).resolves.toBe("Giant Step");
        expect(fallbackKitsuGetEpisodeTitleMock).toHaveBeenCalledWith(
            944,
            11,
            4,
            expect.objectContaining({ searchTitle: "Dr Stone" }),
        );
    });

    it("accepts a fallback search result already proven to be the requested season", async () => {
        primarySearchAnimeMock.mockResolvedValue({
            id: 101,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        primaryFindSeasonAnimeMock.mockResolvedValue({
            id: 101,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
        });
        primaryGetEpisodeTitleMock.mockResolvedValue(null);
        fallbackJikanSearchAnimeMock.mockResolvedValue({
            id: 17055,
            title: "Dr Stone Science Future",
            title_english: "Dr. STONE Science Future",
            type: "TV",
            coverImage: null,
            seasonValidation: { expectedSeason: 4, method: "explicit-title" },
        });
        fallbackJikanGetAnimeByIdMock.mockResolvedValue({
            id: 17055,
            title_romaji: "Dr Stone Science Future",
            title_english: "Dr. STONE Science Future",
            cover_url: null,
            total_episodes: 12,
        });
        fallbackJikanGetEpisodeTitleMock.mockResolvedValue("Science Future");

        const { getEpisodeTitle } = await import("../src/anime");

        await expect(getEpisodeTitle("Dr Stone", 4, 11)).resolves.toBe("Science Future");
        expect(fallbackJikanFindSeasonAnimeMock).not.toHaveBeenCalled();
        expect(fallbackJikanGetEpisodeTitleMock).toHaveBeenCalledWith(
            17055,
            11,
            4,
            expect.objectContaining({ searchTitle: "Dr Stone" }),
        );
    });

    it("rejects a fallback search result for the wrong season even when it has enough episodes", async () => {
        primarySearchAnimeMock.mockResolvedValue({
            id: 101,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        primaryFindSeasonAnimeMock.mockResolvedValue({
            id: 101,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
        });
        primaryGetEpisodeTitleMock.mockResolvedValue(null);
        fallbackJikanSearchAnimeMock.mockResolvedValue({
            id: 38691,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        fallbackJikanFindSeasonAnimeMock.mockResolvedValue({
            id: 38691,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
            total_episodes: 24,
        });
        fallbackJikanGetEpisodeTitleMock.mockResolvedValue("Stone World");
        fallbackKitsuSearchAnimeMock.mockResolvedValue(null);

        const { getEpisodeTitle } = await import("../src/anime");

        await expect(getEpisodeTitle("Dr Stone", 4, 11)).resolves.toBeNull();
        expect(fallbackJikanFindSeasonAnimeMock).toHaveBeenCalledWith(38691, 4);
        expect(fallbackJikanGetEpisodeTitleMock).not.toHaveBeenCalled();
    });

    it("builds fallback candidates with parsed title first and season variant", async () => {
        const { buildFallbackSearchCandidates } = await import("../src/anime");

        const candidates = buildFallbackSearchCandidates(
            "  Rascal Does Not Dream of Bunny Girl Senpai University Arc  ",
            2,
            {
                title_romaji: "Seishun Buta Yarou",
                title_english: "Rascal Does Not Dream of Bunny Girl Senpai",
            },
        );

        expect(candidates).toEqual([
            "Rascal Does Not Dream of Bunny Girl Senpai University Arc",
            "Rascal Does Not Dream of Bunny Girl Senpai University Arc season 2",
            "Seishun Buta Yarou",
            "Rascal Does Not Dream of Bunny Girl Senpai",
        ]);
    });

    it("caches episode titles per season for same series and episode number", async () => {
        primarySearchAnimeMock.mockResolvedValue({
            id: 101,
            title: "Dr Stone",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
        });
        primaryFindSeasonAnimeMock.mockResolvedValue({
            id: 101,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
        });

        primaryGetEpisodeTitleMock
            .mockResolvedValueOnce("Season 1 Episode 2")
            .mockResolvedValueOnce("Season 2 Episode 2");

        const { getEpisodeTitle } = await import("../src/anime");

        const season1Title = await getEpisodeTitle("Dr Stone", 1, 2);
        const season2Title = await getEpisodeTitle("Dr Stone", 2, 2);

        expect(season1Title).toBe("Season 1 Episode 2");
        expect(season2Title).toBe("Season 2 Episode 2");
        expect(primaryGetEpisodeTitleMock).toHaveBeenCalledTimes(2);
        expect(primaryGetEpisodeTitleMock).toHaveBeenNthCalledWith(
            1,
            101,
            2,
            1,
            expect.objectContaining({
                searchTitle: "Dr Stone",
                allowSeasonInference: true,
            }),
        );
        expect(primaryGetEpisodeTitleMock).toHaveBeenNthCalledWith(
            2,
            101,
            2,
            2,
            expect.objectContaining({
                searchTitle: "Dr Stone",
                allowSeasonInference: false,
            }),
        );
    });
});
