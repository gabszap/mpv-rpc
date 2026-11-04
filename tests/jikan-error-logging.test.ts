import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosGetMock = vi.fn();
const logApiCallMock = vi.fn();
const formatProviderErrorDetailsMock = vi.fn();

vi.mock("axios", () => ({
    default: {
        get: axiosGetMock,
    },
}));

vi.mock("../src/core/config", () => ({
    config: {
        debug: true,
        jikan: {
            baseUrl: "https://jikan.lucashdo.com/v1",
            minRequestInterval: 0,
        },
    },
}));

vi.mock("../src/providers/types", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/providers/types")>();
    return {
        ...actual,
        logApiCall: logApiCallMock,
        formatProviderErrorDetails: formatProviderErrorDetailsMock,
    };
});

describe("JikanProvider error logging and jikan-edge contract", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        formatProviderErrorDetailsMock.mockReturnValue("formatted-detail");
    });

    it("logs concise search errors and keeps detailed payload in api log path", async () => {
        const providerError = {
            message: "Request failed with status code 503",
            response: {
                status: 503,
                data: {
                    status: "maintenance",
                    note: "service unavailable",
                },
            },
        };

        axiosGetMock.mockRejectedValueOnce(providerError);
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const { JikanProvider } = await import("../src/providers/jikan");
        const provider = new JikanProvider();
        const result = await provider.searchAnime("Attack on Titan");

        expect(result).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            "[Jikan] Search error: status 503: Request failed with status code 503",
        );
        expect(consoleErrorSpy.mock.calls[0]).toHaveLength(1);

        expect(logApiCallMock).toHaveBeenCalledWith(
            "Jikan",
            "/anime",
            {
                q: "Attack on Titan",
            },
            "ERROR",
            "Request failed with status code 503",
        );
        expect(formatProviderErrorDetailsMock).toHaveBeenCalledWith("Jikan", "/anime", providerError);
        expect(logApiCallMock).toHaveBeenCalledWith(
            "Jikan",
            "/anime",
            {
                q: "Attack on Titan",
            },
            "ERROR_DETAIL",
            "formatted-detail",
        );
    });

    it("formats jikan-edge structured error envelope with code and message", async () => {
        const providerError = {
            message: "Request failed with status code 400",
            response: {
                status: 400,
                data: {
                    error: {
                        code: "UNSUPPORTED_PARAMETER",
                        message: "Parameter 'sfw' is not supported on this route",
                        requestId: "req-123",
                    },
                },
            },
        };

        axiosGetMock.mockRejectedValueOnce(providerError);
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const { JikanProvider } = await import("../src/providers/jikan");
        const provider = new JikanProvider();
        const result = await provider.searchAnime("Attack on Titan");

        expect(result).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            "[Jikan] Search error: status 400 (UNSUPPORTED_PARAMETER): Parameter 'sfw' is not supported on this route",
        );
    });

    it("falls back to episode list when individual episode lookup fails", async () => {
        axiosGetMock
            .mockRejectedValueOnce({
                message: "Request failed with status code 500",
                response: { status: 500 },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    data: [
                        { number: 5, title: "Previous Episode" },
                        { number: 6, title: "Science Future" },
                    ],
                    meta: {
                        cached: true,
                        stale: false,
                        refreshFailed: false,
                        fetchedAt: "2026-10-21T00:00:00.000Z",
                        pagination: {
                            page: 1,
                            limit: 100,
                            count: 2,
                            total: null,
                            hasNextPage: false,
                        },
                    },
                },
            });

        const { JikanProvider } = await import("../src/providers/jikan");
        const provider = new JikanProvider();

        await expect(provider.getEpisodeTitle(62568, 6)).resolves.toBe("Science Future");
        expect(axiosGetMock).toHaveBeenCalledTimes(2);
        expect(axiosGetMock.mock.calls[0]?.[0]).toContain("/anime/62568/episodes/6");
        expect(axiosGetMock.mock.calls[1]?.[0]).toContain("/anime/62568/episodes");
    });

    it("parses jikan-edge camelCase anime details, images, and flat relations", async () => {
        axiosGetMock
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    data: [
                        {
                            relation: "Sequel",
                            malId: 25777,
                            type: "anime",
                            title: "Shingeki no Kyojin Season 2",
                        },
                    ],
                    meta: { cached: true, stale: true, refreshFailed: true, fetchedAt: "2026-10-21T00:00:00.000Z" },
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    data: {
                        malId: 25777,
                        title: "Shingeki no Kyojin Season 2",
                        titleEnglish: "Attack on Titan Season 2",
                        type: "TV",
                        episodes: 12,
                        imageUrl: "https://cdn.myanimelist.net/images/anime/4/84177.jpg",
                        images: {
                            small: "https://cdn.myanimelist.net/images/anime/4/84177t.jpg",
                            medium: "https://cdn.myanimelist.net/images/anime/4/84177.jpg",
                            large: "https://cdn.myanimelist.net/images/anime/4/84177l.jpg",
                        },
                    },
                    meta: { cached: true, stale: false, refreshFailed: false, fetchedAt: "2026-10-21T00:00:00.000Z" },
                },
            });

        const { JikanProvider } = await import("../src/providers/jikan");
        const provider = new JikanProvider();

        const sequel = await provider.findSeasonAnime(16498, 2);
        expect(sequel).toEqual({
            id: 25777,
            mal_id: 25777,
            title_english: "Attack on Titan Season 2",
            title_romaji: "Shingeki no Kyojin Season 2",
            cover_url: "https://cdn.myanimelist.net/images/anime/4/84177l.jpg",
            total_episodes: 12,
            seasonValidation: {
                expectedSeason: 2,
                method: "explicit-title",
            },
        });
    });

    it("resolves JoJo Season 6 (Steel Ball Run) across Part X: subtitles and split-cour sequels", async () => {
        const jojoChain: Record<number, { title: string; titleEnglish: string; type: string; sequelId?: number }> = {
            14719: {
                title: "JoJo no Kimyou na Bouken (TV)",
                titleEnglish: "JoJo's Bizarre Adventure",
                type: "TV",
                sequelId: 20899,
            },
            20899: {
                title: "JoJo no Kimyou na Bouken Part 3: Stardust Crusaders",
                titleEnglish: "JoJo's Bizarre Adventure: Stardust Crusaders",
                type: "TV",
                sequelId: 26055,
            },
            26055: {
                title: "JoJo no Kimyou na Bouken Part 3: Stardust Crusaders 2nd Season",
                titleEnglish: "JoJo's Bizarre Adventure: Stardust Crusaders - Battle in Egypt",
                type: "TV",
                sequelId: 31933,
            },
            31933: {
                title: "JoJo no Kimyou na Bouken Part 4: Diamond wa Kudakenai",
                titleEnglish: "JoJo's Bizarre Adventure: Diamond Is Unbreakable",
                type: "TV",
                sequelId: 37991,
            },
            37991: {
                title: "JoJo no Kimyou na Bouken Part 5: Ougon no Kaze",
                titleEnglish: "JoJo's Bizarre Adventure: Golden Wind",
                type: "TV",
                sequelId: 48661,
            },
            48661: {
                title: "JoJo no Kimyou na Bouken Part 6: Stone Ocean",
                titleEnglish: "JoJo's Bizarre Adventure: Stone Ocean",
                type: "ONA",
                sequelId: 51367,
            },
            51367: {
                title: "JoJo no Kimyou na Bouken Part 6: Stone Ocean Part 2",
                titleEnglish: "JoJo's Bizarre Adventure: Stone Ocean Part 2",
                type: "ONA",
                sequelId: 53273,
            },
            53273: {
                title: "JoJo no Kimyou na Bouken Part 6: Stone Ocean Part 3",
                titleEnglish: "JoJo's Bizarre Adventure: Stone Ocean Part 3",
                type: "ONA",
                sequelId: 61469,
            },
            61469: {
                title: "Steel Ball Run: JoJo no Kimyou na Bouken",
                titleEnglish: "Steel Ball Run: JoJo's Bizarre Adventure",
                type: "ONA",
            },
        };

        axiosGetMock.mockImplementation(async (url: string) => {
            const relMatch = url.match(/\/anime\/(\d+)\/relations$/);
            if (relMatch) {
                const id = Number(relMatch[1]);
                const entry = jojoChain[id];
                return {
                    status: 200,
                    data: {
                        data: entry?.sequelId
                            ? [
                                  {
                                      relation: "Sequel",
                                      malId: entry.sequelId,
                                      type: "anime",
                                      title: jojoChain[entry.sequelId].title,
                                  },
                              ]
                            : [],
                    },
                };
            }

            const animeMatch = url.match(/\/anime\/(\d+)$/);
            if (animeMatch) {
                const id = Number(animeMatch[1]);
                const entry = jojoChain[id];
                return {
                    status: 200,
                    data: {
                        data: {
                            malId: id,
                            title: entry.title,
                            titleEnglish: entry.titleEnglish,
                            type: entry.type,
                            episodes: null,
                        },
                    },
                };
            }

            throw new Error(`Unexpected URL: ${url}`);
        });

        const { JikanProvider } = await import("../src/providers/jikan");
        const provider = new JikanProvider();

        const s6 = await provider.findSeasonAnime(14719, 6);
        expect(s6?.id).toBe(61469);
        expect(s6?.title_english).toBe("Steel Ball Run: JoJo's Bizarre Adventure");
    });
});
