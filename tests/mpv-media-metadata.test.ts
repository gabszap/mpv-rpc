import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveMediaMock, readStremioPlaybackContextMock } = vi.hoisted(() => ({
    resolveMediaMock: vi.fn(),
    readStremioPlaybackContextMock: vi.fn(),
}));

vi.mock("../src/core/media", () => ({
    resolveMedia: resolveMediaMock,
}));

vi.mock("../src/stremio-sync/context", () => ({
    readStremioPlaybackContext: readStremioPlaybackContextMock,
}));

import { config } from "../src/core/config";
import { routeMetadata } from "../src/core/metadata-router";
import type { ParsedFilename } from "../src/core/parser";
import { readStremioPlaybackIdentity, resolveMediaMetadata } from "../src/integrations/mpv";

const originalTitleLanguage = config.settings.preferredTitleLanguage;

function setTitleLanguage(value: "english" | "romaji" | "none"): void {
    (config.settings as Record<string, unknown>).preferredTitleLanguage = value;
}

function parsed(overrides: Partial<ParsedFilename> = {}): ParsedFilename {
    return {
        full_title: "Breaking Bad - S01E01",
        series_title: "Breaking Bad",
        season: 1,
        episode: 1,
        episode_title: null,
        media_type: "series",
        ...overrides,
    };
}

function seriesResult(overrides: Record<string, unknown> = {}): unknown {
    return {
        info: {
            kind: "series",
            tmdbId: 1396,
            imdbId: null,
            title: "Breaking Bad (TMDb)",
            originalTitle: "Breaking Bad",
            year: 2008,
            posterUrl: "series-poster",
        },
        coverUrl: "season-poster",
        episodeTitle: "Pilot",
        ...overrides,
    };
}

function run(
    overrides: Partial<Parameters<typeof resolveMediaMetadata>[0]> = {},
): ReturnType<typeof resolveMediaMetadata> {
    return resolveMediaMetadata({
        parsed: parsed(),
        seriesTitle: "Breaking Bad",
        renameOverrideName: null,
        stremioType: undefined,
        stremioImdbId: undefined,
        ...overrides,
    });
}

beforeEach(() => {
    resolveMediaMock.mockReset();
    readStremioPlaybackContextMock.mockReset();
    setTitleLanguage("romaji");
});

afterEach(() => {
    setTitleLanguage(originalTitleLanguage);
    vi.restoreAllMocks();
});

describe("resolveMediaMetadata", () => {
    it("maps a series result", async () => {
        resolveMediaMock.mockResolvedValue(seriesResult());

        const result = await run();

        expect(resolveMediaMock).toHaveBeenCalledWith({
            title: "Breaking Bad",
            kindHint: null,
            season: 1,
            episode: 1,
            year: null,
            imdbId: null,
        });
        expect(result).toEqual({
            coverImage: "season-poster",
            seriesTitle: "Breaking Bad (TMDb)",
            episodeTitle: "Pilot",
            malId: null,
            totalEpisodes: null,
            adjustedEpisode: null,
            metadataSourceProvider: "tmdb",
            mediaKind: "series",
            year: 2008,
        });
    });

    it("maps a movie result with its year", async () => {
        resolveMediaMock.mockResolvedValue({
            info: {
                kind: "movie",
                tmdbId: 27205,
                imdbId: null,
                title: "Inception",
                originalTitle: "Inception",
                year: 2010,
                posterUrl: "movie-poster",
            },
            coverUrl: "movie-poster",
            episodeTitle: null,
        });

        const result = await run({
            parsed: parsed({ series_title: "Inception", season: null, episode: null, year: 2010 }),
            seriesTitle: "Inception",
        });

        expect(resolveMediaMock).toHaveBeenCalledWith(expect.objectContaining({ year: 2010, season: null }));
        expect(result).toMatchObject({
            coverImage: "movie-poster",
            seriesTitle: "Inception",
            mediaKind: "movie",
            year: 2010,
            episodeTitle: null,
        });
    });

    it("passes the Stremio type and IMDb id to the resolver", async () => {
        resolveMediaMock.mockResolvedValue(null);

        await run({ stremioType: "movie", stremioImdbId: "tt1375666" });

        expect(resolveMediaMock).toHaveBeenCalledWith(
            expect.objectContaining({ kindHint: "movie", imdbId: "tt1375666" }),
        );
    });

    it("TITLE_LANG none keeps the filename title but keeps cover and episode title", async () => {
        setTitleLanguage("none");
        resolveMediaMock.mockResolvedValue(seriesResult());

        const result = await run();

        expect(result).toMatchObject({
            seriesTitle: "Breaking Bad",
            coverImage: "season-poster",
            episodeTitle: "Pilot",
        });
    });

    it("a rename override uses the TMDb title even with none", async () => {
        setTitleLanguage("none");
        resolveMediaMock.mockResolvedValue(seriesResult());

        const result = await run({ seriesTitle: "Breakin Bad", renameOverrideName: "Breakin Bad" });

        expect(resolveMediaMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Breakin Bad" }));
        expect(result?.seriesTitle).toBe("Breaking Bad (TMDb)");
    });

    it("returns null when resolveMedia returns null", async () => {
        resolveMediaMock.mockResolvedValue(null);

        expect(await run()).toBeNull();
    });

    it("does not call the resolver for an empty or N/A title", async () => {
        expect(await run({ seriesTitle: "" })).toBeNull();
        expect(await run({ seriesTitle: "N/A" })).toBeNull();
        expect(resolveMediaMock).not.toHaveBeenCalled();
    });

    it("keeps the parsed episode title when TMDb has none", async () => {
        resolveMediaMock.mockResolvedValue(seriesResult({ episodeTitle: null }));

        const result = await run({ parsed: parsed({ episode_title: "From the filename" }) });

        expect(result?.episodeTitle).toBe("From the filename");
    });

    it("mal_id stays null and the router accepts a TMDb result", async () => {
        resolveMediaMock.mockResolvedValue(seriesResult());
        const anime = vi.fn(async () => null);

        const routed = await routeMetadata(
            { parsedMediaType: "unknown", stremioType: undefined },
            { anime, media: () => run() },
        );

        expect(routed.pipeline).toBe("media");
        expect(routed.result).toMatchObject({ malId: null, totalEpisodes: null, adjustedEpisode: null });
        expect(anime).not.toHaveBeenCalled();
    });
});

describe("readStremioPlaybackIdentity", () => {
    function context(overrides: Record<string, unknown> = {}): unknown {
        return {
            libraryItemId: "tt1375666",
            imdbId: "tt1375666",
            videoId: null,
            name: "Inception",
            type: "movie",
            season: null,
            episode: null,
            episodesInSeason: null,
            ...overrides,
        };
    }

    it("returns the type and IMDb id for a context that matches the parsed title", () => {
        readStremioPlaybackContextMock.mockReturnValue(context());

        const identity = readStremioPlaybackIdentity({ series_title: "Inception", season: null, episode: null });

        expect(identity).toMatchObject({ type: "movie", imdbId: "tt1375666" });
    });

    it("a stale Stremio context for another title does not route as a movie", () => {
        readStremioPlaybackContextMock.mockReturnValue(context({ name: "Some Other Movie" }));

        const identity = readStremioPlaybackIdentity({ series_title: "Breaking Bad", season: 1, episode: 1 });

        expect(identity).toEqual({});
    });
});
