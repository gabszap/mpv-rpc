import { beforeEach, describe, expect, it, vi } from "vitest";

const primarySearchAnimeMock = vi.fn();
const primaryGetEpisodeTitleMock = vi.fn();
const primaryFindSeasonAnimeMock = vi.fn();

const fallbackJikanSearchAnimeMock = vi.fn();
const fallbackJikanGetEpisodeTitleMock = vi.fn();

const fallbackKitsuSearchAnimeMock = vi.fn();

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
        getAnimeById = vi.fn();
        getEpisodeTitle = fallbackJikanGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
    },
}));

vi.mock("../src/providers/kitsu", () => ({
    KitsuProvider: class {
        readonly name = "kitsu";
        searchAnime = fallbackKitsuSearchAnimeMock;
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
        fallbackJikanGetEpisodeTitleMock.mockResolvedValue("A New World");

        const { getEpisodeTitle } = await import("../src/anime");
        const title = await getEpisodeTitle(parsedTitle, 2, 3);

        expect(title).toBe("A New World");
        expect(fallbackJikanSearchAnimeMock).toHaveBeenCalledWith(parsedTitle);
        expect(fallbackJikanSearchAnimeMock).not.toHaveBeenCalledWith("Dr Stone");
        expect(fallbackKitsuSearchAnimeMock).not.toHaveBeenCalled();
    });

    it("builds fallback candidates with parsed title first and season variant", async () => {
        const { buildFallbackSearchCandidates } = await import("../src/anime");

        const candidates = buildFallbackSearchCandidates(
            "  Rascal Does Not Dream of Bunny Girl Senpai University Arc  ",
            2,
            {
                title_romaji: "Seishun Buta Yarou",
                title_english: "Rascal Does Not Dream of Bunny Girl Senpai",
            }
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
            })
        );
        expect(primaryGetEpisodeTitleMock).toHaveBeenNthCalledWith(
            2,
            101,
            2,
            2,
            expect.objectContaining({
                searchTitle: "Dr Stone",
                allowSeasonInference: false,
            })
        );
    });
});
