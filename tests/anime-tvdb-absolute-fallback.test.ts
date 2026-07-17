import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const primarySearchAnimeMock = vi.fn();
const primaryGetAnimeByIdMock = vi.fn();
const primaryGetEpisodeTitleMock = vi.fn();
const primaryGetSequelInfoMock = vi.fn();

const fallbackJikanGetEpisodeTitleMock = vi.fn();
const fallbackKitsuSearchAnimeMock = vi.fn();

const fallbackTvdbSearchAnimeMock = vi.fn();
const fallbackTvdbGetAnimeByIdMock = vi.fn();
const fallbackTvdbGetEpisodeTitleMock = vi.fn();

vi.mock("../src/core/config", () => ({
    config: {
        metadataProvider: "anilist",
        tvdb: {
            apiKey: "test-tvdb-key",
        },
        debug: false,
    },
}));

vi.mock("../src/providers/anilist", () => ({
    AniListProvider: class {
        readonly name = "anilist";
        searchAnime = primarySearchAnimeMock;
        getAnimeById = primaryGetAnimeByIdMock;
        getEpisodeTitle = primaryGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
        getSequelInfo = primaryGetSequelInfoMock;
    },
}));

vi.mock("../src/providers/jikan", () => ({
    JikanProvider: class {
        readonly name = "jikan";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = fallbackJikanGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

vi.mock("../src/providers/kitsu", () => ({
    KitsuProvider: class {
        readonly name = "kitsu";
        searchAnime = fallbackKitsuSearchAnimeMock;
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

vi.mock("../src/providers/tvdb", () => ({
    TvdbProvider: class {
        readonly name = "tvdb";
        searchAnime = fallbackTvdbSearchAnimeMock;
        getAnimeById = fallbackTvdbGetAnimeByIdMock;
        getEpisodeTitle = fallbackTvdbGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

describe("Anime TVDB source-position fallback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("passes source season-local episode context to TVDB fallback after MAL/default overflow remaps the effective episode", async () => {
        const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-anime-tvdb-fallback-"));
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(testCwd);

        primarySearchAnimeMock.mockResolvedValue({
            id: 48549,
            title: "Dr. Stone: Science Future",
            title_english: "Dr. STONE: Science Future",
            type: "TV",
            coverImage: null,
        });
        primaryGetAnimeByIdMock.mockImplementation(async (id: number) => {
            if (id === 48549) {
                return {
                    id: 48549,
                    mal_id: 48549,
                    title_romaji: "Dr. Stone: Science Future",
                    title_english: "Dr. STONE: Science Future",
                    cover_url: null,
                    total_episodes: 12,
                };
            }

            if (id === 60000) {
                return {
                    id: 60000,
                    mal_id: 60000,
                    title_romaji: "Dr. Stone: Science Future Part 2",
                    title_english: "Dr. STONE: Science Future Part 2",
                    cover_url: null,
                    total_episodes: 12,
                };
            }

            if (id === 62568) {
                return {
                    id: 62568,
                    mal_id: 62568,
                    title_romaji: "Dr. Stone: Science Future Part 3",
                    title_english: "Dr. STONE: Science Future Part 3",
                    cover_url: null,
                    total_episodes: 13,
                };
            }

            return null;
        });
        primaryGetSequelInfoMock.mockImplementation(async (id: number) => {
            if (id === 48549) {
                return {
                    id: 60000,
                    mal_id: 60000,
                    title_romaji: "Dr. Stone: Science Future Part 2",
                    title_english: "Dr. STONE: Science Future Part 2",
                    total_episodes: 12,
                    is_split_cour: true,
                };
            }

            if (id === 60000) {
                return {
                    id: 62568,
                    mal_id: 62568,
                    title_romaji: "Dr. Stone: Science Future Part 3",
                    title_english: "Dr. STONE: Science Future Part 3",
                    total_episodes: 13,
                    is_split_cour: true,
                };
            }

            return null;
        });
        primaryGetEpisodeTitleMock.mockResolvedValue(null);
        fallbackJikanGetEpisodeTitleMock.mockResolvedValue(null);
        fallbackKitsuSearchAnimeMock.mockResolvedValue(null);
        fallbackTvdbSearchAnimeMock.mockResolvedValue({
            id: 355774,
            title: "Dr. STONE",
            title_english: "Dr. STONE",
            type: "TV",
            coverImage: null,
            seasonValidation: { expectedSeason: 4, method: "provider-season" },
        });
        fallbackTvdbGetAnimeByIdMock.mockResolvedValue({
            id: 355774,
            title_romaji: "Dr. STONE",
            title_english: "Dr. STONE",
            cover_url: null,
        });
        fallbackTvdbGetEpisodeTitleMock.mockResolvedValue("Mapped Source Episode Title");

        try {
            const { getEpisodeTitle } = await import("../src/core/anime");

            await expect(getEpisodeTitle("Dr Stone", 4, 35)).resolves.toBe("Mapped Source Episode Title");
            expect(fallbackTvdbGetEpisodeTitleMock).toHaveBeenCalledWith(
                355774,
                11,
                4,
                expect.objectContaining({
                    sourceEpisode: 35,
                    sourceSeason: 4,
                    effectiveEpisode: 11,
                }),
            );
        } finally {
            cwdSpy.mockRestore();
            fs.rmSync(testCwd, { recursive: true, force: true });
        }
    });
});
