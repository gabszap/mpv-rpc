import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAnimeInfoWithProviderMock, getEpisodeTitleMock, resolveOverflowEpisodeMock } = vi.hoisted(() => ({
    getAnimeInfoWithProviderMock: vi.fn(),
    getEpisodeTitleMock: vi.fn(),
    resolveOverflowEpisodeMock: vi.fn(),
}));

vi.mock("../src/core/anime", () => ({
    getAnimeInfoWithProvider: getAnimeInfoWithProviderMock,
    getEpisodeTitle: getEpisodeTitleMock,
    resolveOverflowEpisode: resolveOverflowEpisodeMock,
}));

import { config } from "../src/core/config";
import type { ParsedFilename } from "../src/core/parser";
import { resolveAnimeMetadata } from "../src/integrations/mpv";

const originalTitleLanguage = config.settings.preferredTitleLanguage;

function setTitleLanguage(value: "english" | "romaji" | "none"): void {
    (config.settings as Record<string, unknown>).preferredTitleLanguage = value;
}

function parsed(overrides: Partial<ParsedFilename> = {}): ParsedFilename {
    return {
        full_title: "Frieren - S01E05",
        series_title: "Frieren",
        season: 1,
        episode: 5,
        episode_title: null,
        media_type: "anime",
        ...overrides,
    };
}

function animeResult(overrides: Record<string, unknown> = {}): { animeInfo: unknown; sourceProvider: string } {
    return {
        animeInfo: {
            id: 1,
            mal_id: 100,
            title_english: "Frieren: Beyond Journey's End",
            title_romaji: "Sousou no Frieren",
            cover_url: "series-cover",
            season_cover_url: "season-cover",
            total_episodes: 28,
            ...overrides,
        },
        sourceProvider: "jikan",
    };
}

function run(
    overrides: Partial<Parameters<typeof resolveAnimeMetadata>[0]> = {},
): ReturnType<typeof resolveAnimeMetadata> {
    return resolveAnimeMetadata({
        parsed: parsed(),
        seriesTitle: "Frieren",
        originalTitle: "Frieren",
        renameOverrideName: null,
        ...overrides,
    });
}

beforeEach(() => {
    getAnimeInfoWithProviderMock.mockReset();
    getEpisodeTitleMock.mockReset();
    resolveOverflowEpisodeMock.mockReset();
    getEpisodeTitleMock.mockResolvedValue(null);
    setTitleLanguage("romaji");
});

afterEach(() => {
    setTitleLanguage(originalTitleLanguage);
    vi.restoreAllMocks();
});

describe("resolveAnimeMetadata", () => {
    it("anime found sets cover, title, malId and totalEpisodes", async () => {
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());
        getEpisodeTitleMock.mockResolvedValue("The Journey's End");

        const result = await run();

        expect(getAnimeInfoWithProviderMock).toHaveBeenCalledWith("Frieren", 1);
        expect(getEpisodeTitleMock).toHaveBeenCalledWith("Frieren", 1, 5);
        expect(result).toEqual({
            coverImage: "season-cover",
            seriesTitle: "Sousou no Frieren",
            episodeTitle: "The Journey's End",
            malId: 100,
            totalEpisodes: 28,
            adjustedEpisode: null,
            metadataSourceProvider: "jikan",
            animeIds: { mal: "100" },
        });
    });

    it("anime not found keeps defaults and still resolves a missing episode title", async () => {
        getAnimeInfoWithProviderMock.mockResolvedValue(null);
        getEpisodeTitleMock.mockResolvedValue("Found Elsewhere");

        const result = await run();

        expect(result).toEqual({
            coverImage: null,
            seriesTitle: "Frieren",
            episodeTitle: "Found Elsewhere",
            malId: null,
            totalEpisodes: null,
            adjustedEpisode: null,
            metadataSourceProvider: null,
        });
    });

    it("does not look anything up for an empty or N/A title, and keeps the parsed episode title", async () => {
        for (const seriesTitle of ["", "N/A"]) {
            const result = await run({
                seriesTitle,
                parsed: parsed({ series_title: seriesTitle, episode_title: "Parsed" }),
            });
            expect(result.episodeTitle).toBe("Parsed");
            expect(result.seriesTitle).toBe(seriesTitle);
        }

        expect(getAnimeInfoWithProviderMock).not.toHaveBeenCalled();
        expect(getEpisodeTitleMock).not.toHaveBeenCalled();
    });

    it("does not fetch an episode title when the file has no episode", async () => {
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());

        await run({ parsed: parsed({ episode: null }) });

        expect(getEpisodeTitleMock).not.toHaveBeenCalled();
    });

    it("overflow resolved replaces cover, title, malId and adjustedEpisode", async () => {
        setTitleLanguage("english");
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());
        resolveOverflowEpisodeMock.mockResolvedValue({
            animeInfo: {
                id: 2,
                mal_id: 200,
                title_english: "Frieren Part 2",
                title_romaji: "Sousou no Frieren Part 2",
                cover_url: "cour-2-cover",
                total_episodes: 12,
            },
            adjustedEpisode: 2,
        });

        const result = await run({ parsed: parsed({ episode: 30 }) });
        expect(result.animeIds).toEqual({ mal: "200" });

        expect(resolveOverflowEpisodeMock).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            coverImage: "cour-2-cover",
            seriesTitle: "Frieren Part 2",
            malId: 200,
            totalEpisodes: 12,
            adjustedEpisode: 2,
        });
    });

    it("keeps the first result when the overflow cannot be resolved", async () => {
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());
        resolveOverflowEpisodeMock.mockResolvedValue(null);

        const result = await run({ parsed: parsed({ episode: 30 }) });

        expect(result).toMatchObject({ malId: 100, totalEpisodes: 28, adjustedEpisode: null });
        expect(result.seriesTitle).toBe("Sousou no Frieren");
    });

    it("TITLE_LANG none keeps the filename title", async () => {
        setTitleLanguage("none");
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());

        const result = await run();

        expect(result.seriesTitle).toBe("Frieren");
        expect(result).toMatchObject({ coverImage: "season-cover", malId: 100 });
    });

    it("a rename override uses the API title even with none", async () => {
        setTitleLanguage("none");
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());

        const result = await run({ seriesTitle: "Sousou", renameOverrideName: "Sousou" });

        expect(getAnimeInfoWithProviderMock).toHaveBeenCalledWith("Sousou", 1);
        expect(result.seriesTitle).toBe("Frieren: Beyond Journey's End");
        expect(getEpisodeTitleMock).toHaveBeenCalledWith("Sousou", 1, 5);
    });

    it("english and romaji pick the matching title with fallback", async () => {
        setTitleLanguage("english");
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());
        expect((await run()).seriesTitle).toBe("Frieren: Beyond Journey's End");

        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult({ title_english: null }));
        expect((await run()).seriesTitle).toBe("Sousou no Frieren");

        setTitleLanguage("romaji");
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult({ title_romaji: "" }));
        expect((await run()).seriesTitle).toBe("Frieren: Beyond Journey's End");
    });

    it("falls back to the plain cover and omits ids the provider does not give", async () => {
        getAnimeInfoWithProviderMock.mockResolvedValue(
            animeResult({ season_cover_url: null, mal_id: undefined, total_episodes: undefined }),
        );

        const result = await run();

        expect(result).toMatchObject({ coverImage: "series-cover", malId: null, totalEpisodes: null });
    });

    it("a provider error is logged and returns the defaults", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        getAnimeInfoWithProviderMock.mockRejectedValue(new Error("down"));

        const result = await run({ parsed: parsed({ episode_title: "Parsed" }) });

        expect(logged).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            coverImage: null,
            seriesTitle: "Frieren",
            episodeTitle: "Parsed",
            malId: null,
            totalEpisodes: null,
            adjustedEpisode: null,
            metadataSourceProvider: null,
        });
    });

    it("keeps what was resolved before a later step throws", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        getAnimeInfoWithProviderMock.mockResolvedValue(animeResult());
        getEpisodeTitleMock.mockRejectedValue(new Error("episode lookup failed"));

        const result = await run({ parsed: parsed({ episode_title: "Parsed" }) });

        expect(result).toMatchObject({
            coverImage: "season-cover",
            seriesTitle: "Sousou no Frieren",
            episodeTitle: "Parsed",
            malId: 100,
            metadataSourceProvider: "jikan",
        });
    });
});
