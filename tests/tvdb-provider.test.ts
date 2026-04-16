import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosGetMock = vi.fn();
const axiosPostMock = vi.fn();

vi.mock("axios", () => ({
    default: {
        get: axiosGetMock,
        post: axiosPostMock,
    },
}));

vi.mock("../src/config", () => ({
    config: {
        metadataProvider: "tvdb",
        tvdb: {
            apiKey: "test-tvdb-key",
            language: "eng",
        },
        debug: false,
    },
}));

describe("TvdbProvider.getEpisodeTitle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        axiosPostMock.mockResolvedValue({
            data: {
                data: {
                    token: "test-token",
                },
            },
        });
    });

    it("prefers official ordering and exact season+episode match", async () => {
        axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
            if (!url.endsWith("/series/42/episodes/official")) {
                throw new Error(`Unexpected URL: ${url}`);
            }

            expect(options?.params).toEqual({
                page: 0,
                season: 3,
                episodeNumber: 2,
            });

            return {
                data: {
                    data: {
                        episodes: [
                            {
                                id: "2002",
                                seasonNumber: "3",
                                number: "2",
                                name: "Official Episode",
                            },
                        ],
                    },
                },
            };
        });

        const { TvdbProvider } = await import("../src/providers/tvdb");
        const provider = new TvdbProvider();

        const title = await provider.getEpisodeTitle(42, 2, 3);

        expect(title).toBe("Official Episode");
        expect(axiosGetMock).toHaveBeenCalledTimes(1);
        expect(axiosGetMock.mock.calls[0]?.[0]).toContain("/series/42/episodes/official");
        expect(axiosGetMock.mock.calls.some(([url]) => String(url).includes("/episodes/default"))).toBe(false);
    });

    it("uses bounded pagination in official ordering before default fallback", async () => {
        axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params ?? {};

            if (url.endsWith("/series/42/episodes/official")) {
                if (params.page === 0 && params.season === 3 && params.episodeNumber === 2) {
                    return {
                        data: {
                            data: {
                                episodes: [{ id: 1, seasonNumber: "1", number: "2", name: "Wrong Season" }],
                            },
                        },
                    };
                }

                if (params.page === 0 && params.season === 3 && !("episodeNumber" in params)) {
                    return {
                        data: {
                            data: {
                                episodes: [{ id: 2, seasonNumber: "3", number: "1", name: "Wrong Episode" }],
                            },
                        },
                    };
                }

                if (params.page === 1 && params.season === 3 && !("episodeNumber" in params)) {
                    return {
                        data: {
                            data: {
                                episodes: [{ id: "3", seasonNumber: "03", number: "02", name: "Official Page Match" }],
                            },
                        },
                    };
                }
            }

            throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
        });

        const { TvdbProvider } = await import("../src/providers/tvdb");
        const provider = new TvdbProvider();

        const title = await provider.getEpisodeTitle(42, 2, 3);

        expect(title).toBe("Official Page Match");
        expect(axiosGetMock.mock.calls.some(([url]) => String(url).includes("/episodes/default"))).toBe(false);
    });

    it("falls back to default ordering when official has no exact match", async () => {
        axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params ?? {};

            if (url.endsWith("/series/42/episodes/official") && params.page === 0 && params.season === 3 && params.episodeNumber === 2) {
                return {
                    data: {
                        data: {
                            episodes: [],
                        },
                    },
                };
            }

            if (url.endsWith("/series/42/episodes/official") && params.page === 0 && params.season === 3 && !("episodeNumber" in params)) {
                return {
                    data: {
                        data: {
                            episodes: [],
                        },
                    },
                };
            }

            if (url.endsWith("/series/42/episodes/default") && params.page === 0 && params.season === 3 && params.episodeNumber === 2) {
                return {
                    data: {
                        data: {
                            episodes: [{ id: 100, seasonNumber: 3, number: 2, name: "Default Fallback Match" }],
                        },
                    },
                };
            }

            throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
        });

        const { TvdbProvider } = await import("../src/providers/tvdb");
        const provider = new TvdbProvider();

        const title = await provider.getEpisodeTitle(42, 2, 3);

        expect(title).toBe("Default Fallback Match");
        expect(axiosGetMock.mock.calls.some(([url]) => String(url).includes("/episodes/default"))).toBe(true);
    });

    it("infers season from title hints when season is missing", async () => {
        axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params ?? {};

            if (url.endsWith("/series/42/extended")) {
                expect(params).toEqual({ meta: "episodes" });
                return {
                    data: {
                        data: {
                            seasons: [
                                { number: 1, name: "Season 1", type: { type: "official" } },
                                { number: 2, name: "Stone Wars", type: { type: "official" } },
                                { number: 3, name: "New World", type: { type: "official" } },
                            ],
                        },
                    },
                };
            }

            if (url.endsWith("/series/42/episodes/official")) {
                expect(params).toEqual({
                    page: 0,
                    season: 3,
                    episodeNumber: 2,
                });

                return {
                    data: {
                        data: {
                            episodes: [
                                { id: "3002", seasonNumber: "3", number: "2", name: "Future Whereabouts" },
                            ],
                        },
                    },
                };
            }

            throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
        });

        const { TvdbProvider } = await import("../src/providers/tvdb");
        const provider = new TvdbProvider();

        const title = await provider.getEpisodeTitle(42, 2, undefined, {
            searchTitle: "Dr Stone New World",
            canonicalTitles: ["Dr. STONE: New World", "Dr. STONE"],
            allowSeasonInference: true,
        });

        expect(title).toBe("Future Whereabouts");
        expect(
            axiosGetMock.mock.calls.some(([url, options]) =>
                String(url).includes("/series/42/episodes/official")
                && (options?.params as Record<string, unknown> | undefined)?.season === 1
            )
        ).toBe(false);
    });

    it("does not infer season when explicit season is provided", async () => {
        axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params ?? {};

            if (url.endsWith("/series/42/episodes/official")) {
                expect(params).toEqual({
                    page: 0,
                    season: 3,
                    episodeNumber: 2,
                });

                return {
                    data: {
                        data: {
                            episodes: [
                                { id: "3002", seasonNumber: "3", number: "2", name: "Explicit Season Match" },
                            ],
                        },
                    },
                };
            }

            throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
        });

        const { TvdbProvider } = await import("../src/providers/tvdb");
        const provider = new TvdbProvider();

        const title = await provider.getEpisodeTitle(42, 2, 3, {
            searchTitle: "Dr Stone New World",
            canonicalTitles: ["Dr. STONE: New World"],
            allowSeasonInference: true,
        });

        expect(title).toBe("Explicit Season Match");
        expect(axiosGetMock.mock.calls.some(([url]) => String(url).includes("/series/42/extended"))).toBe(false);
    });
});
