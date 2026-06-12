import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

async function setTvdbLanguage(language: string): Promise<void> {
    const { config } = await import("../src/config");
    config.tvdb.language = language;
}

function readApiLog(testCwd: string): string {
    return fs.readFileSync(path.join(testCwd, ".anime_cache", "api_log.txt"), "utf-8");
}

describe("TVDB language normalization", () => {
    it("normalizes common 2-letter language codes to TVDB language codes", async () => {
        const { normalizeTvdbLanguageCode } = await import("../src/providers/tvdb");

        expect(normalizeTvdbLanguageCode("en")).toBe("eng");
        expect(normalizeTvdbLanguageCode("pt")).toBe("por");
        expect(normalizeTvdbLanguageCode("pt-BR")).toBe("por");
        expect(normalizeTvdbLanguageCode("pt_br")).toBe("por");
        expect(normalizeTvdbLanguageCode("ptbr")).toBe("por");
        expect(normalizeTvdbLanguageCode("ja")).toBe("jpn");
        expect(normalizeTvdbLanguageCode("es")).toBe("spa");
        expect(normalizeTvdbLanguageCode("fra")).toBe("fra");
        expect(normalizeTvdbLanguageCode("zh")).toBe("zho");
        expect(normalizeTvdbLanguageCode("cn")).toBe("zho");
        expect(normalizeTvdbLanguageCode("ru")).toBe("rus");
        expect(normalizeTvdbLanguageCode("ko")).toBe("kor");
        expect(normalizeTvdbLanguageCode("kr")).toBe("kor");
    });

    it("preserves valid 3-letter TVDB language codes", async () => {
        const { normalizeTvdbLanguageCode } = await import("../src/providers/tvdb");

        expect(normalizeTvdbLanguageCode("zho")).toBe("zho");
        expect(normalizeTvdbLanguageCode("rus")).toBe("rus");
        expect(normalizeTvdbLanguageCode("kor")).toBe("kor");
    });

    it("logs raw to normalized language changes once", async () => {
        vi.resetModules();
        await setTvdbLanguage("zh");

        const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-tvdb-language-"));
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(testCwd);

        try {
            const { TvdbProvider } = await import("../src/providers/tvdb");
            const provider = new TvdbProvider();

            expect(provider.getEpisodeCacheKeyScope()).toBe("zho");
            expect(provider.getEpisodeCacheKeyScope()).toBe("zho");

            const apiLog = readApiLog(testCwd);
            const languageLogEntries = apiLog.match(/normalized "zh" -> "zho"/g) ?? [];
            expect(languageLogEntries).toHaveLength(1);
        } finally {
            cwdSpy.mockRestore();
            fs.rmSync(testCwd, { recursive: true, force: true });
            await setTvdbLanguage("eng");
        }
    });
});

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

            if (
                url.endsWith("/series/42/episodes/official") &&
                params.page === 0 &&
                params.season === 3 &&
                params.episodeNumber === 2
            ) {
                return {
                    data: {
                        data: {
                            episodes: [],
                        },
                    },
                };
            }

            if (
                url.endsWith("/series/42/episodes/official") &&
                params.page === 0 &&
                params.season === 3 &&
                !("episodeNumber" in params)
            ) {
                return {
                    data: {
                        data: {
                            episodes: [],
                        },
                    },
                };
            }

            if (
                url.endsWith("/series/42/episodes/default") &&
                params.page === 0 &&
                params.season === 3 &&
                params.episodeNumber === 2
            ) {
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
                            episodes: [{ id: "3002", seasonNumber: "3", number: "2", name: "Future Whereabouts" }],
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
            axiosGetMock.mock.calls.some(
                ([url, options]) =>
                    String(url).includes("/series/42/episodes/official") &&
                    (options?.params as Record<string, unknown> | undefined)?.season === 1,
            ),
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
                            episodes: [{ id: "3002", seasonNumber: "3", number: "2", name: "Explicit Season Match" }],
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

    it("normalizes Portuguese language before requesting localized episode title", async () => {
        await setTvdbLanguage("pt");

        const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-tvdb-provider-"));
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(testCwd);

        try {
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
                                episodes: [{ id: "3002", seasonNumber: "3", number: "2", name: "Default Title" }],
                            },
                        },
                    };
                }

                if (url.endsWith("/episodes/3002/translations/por")) {
                    expect(params).toEqual({ episodeId: 3002, lang: "por" });
                    return {
                        data: {
                            data: {
                                name: "Título em Português",
                            },
                        },
                    };
                }

                throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
            });

            const { TvdbProvider } = await import("../src/providers/tvdb");
            const provider = new TvdbProvider();

            const title = await provider.getEpisodeTitle(42, 2, 3);
            const apiLog = readApiLog(testCwd);

            expect(title).toBe("Título em Português");
            expect(apiLog).toContain('params: {"episodeId":3002,"lang":"por"}');
            expect(apiLog).toContain('localized title found for episodeId=3002, lang=por: "Título em Português"');
        } finally {
            cwdSpy.mockRestore();
            fs.rmSync(testCwd, { recursive: true, force: true });
        }
    });

    it("tries alternate Portuguese-Brazil episode translation code when por is unavailable", async () => {
        await setTvdbLanguage("pt");

        const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-tvdb-provider-"));
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(testCwd);

        try {
            axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
                const params = options?.params ?? {};

                if (url.endsWith("/series/377543/episodes/official")) {
                    expect(params).toEqual({
                        page: 0,
                        season: 3,
                        episodeNumber: 1,
                    });

                    return {
                        data: {
                            data: {
                                episodes: [
                                    {
                                        id: 11441213,
                                        seasonNumber: 3,
                                        number: 1,
                                        name: "執行",
                                        nameTranslations: ["jpn", "eng", "pt-BR"],
                                    },
                                ],
                            },
                        },
                    };
                }

                if (url.endsWith("/episodes/11441213/translations/por")) {
                    const error = new Error("Request failed with status code 404") as Error & {
                        response?: { status: number };
                    };
                    error.response = { status: 404 };
                    throw error;
                }

                if (url.endsWith("/episodes/11441213/translations/pt")) {
                    expect(params).toEqual({ episodeId: 11441213, lang: "pt" });
                    const error = new Error("Request failed with status code 404") as Error & {
                        response?: { status: number };
                    };
                    error.response = { status: 404 };
                    throw error;
                }

                if (url.endsWith("/episodes/11441213/translations/pt-BR")) {
                    expect(params).toEqual({ episodeId: 11441213, lang: "pt-BR" });
                    return {
                        data: {
                            data: {
                                name: "Execução",
                            },
                        },
                    };
                }

                throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
            });

            const { TvdbProvider } = await import("../src/providers/tvdb");
            const provider = new TvdbProvider();

            const title = await provider.getEpisodeTitle(377543, 1, 3);
            const apiLog = readApiLog(testCwd);

            expect(title).toBe("Execução");
            expect(apiLog).toContain('params: {"id":377543,"season":3,"ep":1}');
            expect(apiLog).toContain("seasonType=official exact-match");
            expect(apiLog).toContain('langCandidates:["por","pt","pt-BR"]');
            expect(apiLog).toContain('params: {"episodeId":11441213,"lang":"por"}');
            expect(apiLog).toContain("candidate unavailable for episodeId=11441213, lang=por");
            expect(apiLog).toContain('params: {"episodeId":11441213,"lang":"pt"}');
            expect(apiLog).toContain("candidate unavailable for episodeId=11441213, lang=pt");
            expect(apiLog).toContain('params: {"episodeId":11441213,"lang":"pt-BR"}');
            expect(apiLog).toContain(
                'localized title found for episodeId=11441213, lang=pt-BR, canonical=por: "Execução"',
            );
            expect(apiLog).toContain('seasonType=official "Execução"');
            expect(apiLog).not.toContain("ERROR | TVDB:getEpisodeTranslation");
        } finally {
            cwdSpy.mockRestore();
            fs.rmSync(testCwd, { recursive: true, force: true });
        }
    });

    it("falls back to default episode title when localized translation has no title", async () => {
        await setTvdbLanguage("pt");

        const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-tvdb-provider-"));
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(testCwd);

        try {
            axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
                const params = options?.params ?? {};

                if (url.endsWith("/series/42/episodes/official")) {
                    return {
                        data: {
                            data: {
                                episodes: [{ id: 3002, seasonNumber: 3, number: 2, name: "Default Title" }],
                            },
                        },
                    };
                }

                if (url.endsWith("/episodes/3002/translations/por")) {
                    return {
                        data: {
                            data: {},
                        },
                    };
                }

                if (
                    url.endsWith("/episodes/3002/translations/pt-BR") ||
                    url.endsWith("/episodes/3002/translations/pt")
                ) {
                    const error = new Error("Request failed with status code 404") as Error & {
                        response?: { status: number };
                    };
                    error.response = { status: 404 };
                    throw error;
                }

                throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
            });

            const { TvdbProvider } = await import("../src/providers/tvdb");
            const provider = new TvdbProvider();

            const title = await provider.getEpisodeTitle(42, 2, 3);
            const apiLog = readApiLog(testCwd);

            expect(title).toBe("Default Title");
            expect(apiLog).toContain('params: {"episodeId":3002,"lang":"por"}');
            expect(apiLog).toContain("candidate missing for episodeId=3002, lang=por: no name");
            expect(apiLog).toContain(
                'no localized title found for episodeId=3002, langCandidates:["por","pt","pt-BR"]; fallback default "Default Title"',
            );
            expect(apiLog).not.toContain("ERROR | TVDB:getEpisodeTranslation");
        } finally {
            cwdSpy.mockRestore();
            fs.rmSync(testCwd, { recursive: true, force: true });
        }
    });
});

describe("TvdbProvider season artwork", () => {
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

    it("selects the current season poster in the preferred language", async () => {
        await setTvdbLanguage("pt");

        axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params ?? {};

            if (url.endsWith("/series/42/extended")) {
                expect(params).toEqual({ seriesId: 42, short: true });
                return {
                    data: {
                        data: {
                            name: "Oshi no Ko",
                            image: "https://example.test/series.jpg",
                            nameTranslations: [],
                            seasons: [
                                { id: 301, number: 1, type: { type: "official" } },
                                { id: 303, number: 3, type: { type: "official" } },
                            ],
                            artworks: [
                                {
                                    type: 2,
                                    image: "https://example.test/series-poster.jpg",
                                    score: 20,
                                },
                            ],
                            status: { name: "Continuing" },
                        },
                    },
                };
            }

            if (url.endsWith("/series/42/artworks")) {
                expect(params).toEqual({ type: 7 });
                return {
                    data: {
                        data: {
                            artworks: [
                                {
                                    type: 7,
                                    seasonId: 303,
                                    language: "eng",
                                    image: "https://example.test/season-3-eng.jpg",
                                    score: 100,
                                },
                                {
                                    type: 7,
                                    seasonId: 303,
                                    language: "por",
                                    image: "https://example.test/season-3-por.jpg",
                                    score: 10,
                                },
                                {
                                    type: 7,
                                    seasonId: 301,
                                    language: "por",
                                    image: "https://example.test/season-1-por.jpg",
                                    score: 200,
                                },
                            ],
                        },
                    },
                };
            }

            throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
        });

        const { TvdbProvider } = await import("../src/providers/tvdb");
        const provider = new TvdbProvider();

        const animeInfo = await provider.getAnimeById(42, 3);

        expect(animeInfo?.cover_url).toBe("https://example.test/series-poster.jpg");
        expect(animeInfo?.season_cover_url).toBe("https://example.test/season-3-por.jpg");
    });

    it("falls back to series poster when the season poster is missing", async () => {
        axiosGetMock.mockImplementation(async (url: string) => {
            if (url.endsWith("/series/42/extended")) {
                return {
                    data: {
                        data: {
                            name: "Oshi no Ko",
                            image: "https://example.test/series.jpg",
                            nameTranslations: [],
                            seasons: [{ id: 303, number: 3, type: { type: "official" } }],
                            artworks: [{ type: 2, image: "https://example.test/series-poster.jpg" }],
                            status: { name: "Continuing" },
                        },
                    },
                };
            }

            if (url.endsWith("/series/42/artworks")) {
                return {
                    data: {
                        data: {
                            artworks: [],
                        },
                    },
                };
            }

            throw new Error(`Unexpected URL: ${url}`);
        });

        const { TvdbProvider } = await import("../src/providers/tvdb");
        const provider = new TvdbProvider();

        const animeInfo = await provider.getAnimeById(42, 3);

        expect(animeInfo?.cover_url).toBe("https://example.test/series-poster.jpg");
        expect(animeInfo?.season_cover_url).toBeNull();
    });
});

describe("MPV cover image selection", () => {
    it("prefers season cover over series cover", async () => {
        const { selectCoverImage } = await import("../src/mpv");

        expect(
            selectCoverImage({
                cover_url: "https://example.test/series.jpg",
                season_cover_url: "https://example.test/season-3.jpg",
            }),
        ).toBe("https://example.test/season-3.jpg");
    });

    it("falls back to existing cover when overflow info has no cover", async () => {
        const { selectCoverImage } = await import("../src/mpv");

        expect(selectCoverImage({ cover_url: null, season_cover_url: null }, "https://example.test/existing.jpg")).toBe(
            "https://example.test/existing.jpg",
        );
    });
});

describe("mapTvdbAiredEpisodeToAbsolute", () => {
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

    it("maps aired/default S03E05 to absolute episode 52 by TVDB episode id", async () => {
        axiosGetMock.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params ?? {};

            if (url.endsWith("/series/42/episodes/absolute") && params.page === 0) {
                return {
                    data: {
                        data: {
                            episodes: [
                                { id: 3005, seasonNumber: 1, number: 52, absoluteNumber: 52 },
                                { id: 3006, seasonNumber: 1, number: 53, absoluteNumber: 53 },
                            ],
                        },
                    },
                };
            }

            if (url.endsWith("/series/42/episodes/official") && params.page === 0) {
                return {
                    data: {
                        data: {
                            episodes: [
                                { id: 3005, seasonNumber: 3, number: 5, absoluteNumber: 52 },
                                { id: 3006, seasonNumber: 3, number: 6, absoluteNumber: 53 },
                            ],
                        },
                    },
                };
            }

            throw new Error(`Unexpected URL/params: ${url} ${JSON.stringify(params)}`);
        });

        const { mapTvdbAiredEpisodeToAbsolute } = await import("../src/providers/tvdb");

        await expect(mapTvdbAiredEpisodeToAbsolute(42, 3, 5)).resolves.toMatchObject({
            absoluteEpisode: 52,
            episode: 5,
            season: 3,
            seasonType: "official",
        });
        await expect(mapTvdbAiredEpisodeToAbsolute(42, 3, 6)).resolves.toMatchObject({
            absoluteEpisode: 53,
            episode: 6,
            season: 3,
            seasonType: "official",
        });
    });

    it("returns null when absolute order is unavailable", async () => {
        axiosGetMock.mockResolvedValue({
            data: {
                data: {
                    episodes: [],
                },
            },
        });

        const { mapTvdbAiredEpisodeToAbsolute } = await import("../src/providers/tvdb");

        await expect(mapTvdbAiredEpisodeToAbsolute(42, 3, 5)).resolves.toBeNull();
    });
});
