import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { axiosGetMock } = vi.hoisted(() => ({ axiosGetMock: vi.fn() }));

vi.mock("axios", () => ({
    default: { get: axiosGetMock },
}));

import { MediaProviderError } from "../src/providers/media-types";
import { TmdbProvider } from "../src/providers/tmdb";

function fixture(name: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tmdb", `${name}.json`), "utf-8"));
}

function ok(name: string): { status: number; data: unknown } {
    return { status: 200, data: fixture(name) };
}

function httpError(status: number): { response: { status: number }; message: string } {
    return { response: { status }, message: `status ${status}` };
}

function makeProvider(apiKey = "plain-key", language = "en-US"): TmdbProvider {
    return new TmdbProvider({ getApiKey: () => apiKey, getLanguage: () => language, retryDelayMs: 0 });
}

beforeEach(() => {
    axiosGetMock.mockReset();
});

describe("TmdbProvider.findByImdbId", () => {
    it("maps a movie result", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("find-movie"));

        const info = await makeProvider().findByImdbId("tt1375666");

        expect(info).toEqual({
            kind: "movie",
            tmdbId: 27205,
            imdbId: "tt1375666",
            title: "Inception",
            originalTitle: "Inception",
            year: 2010,
            posterUrl: "https://image.tmdb.org/t/p/w500/ljsZTbVsrQSqZgWeep2B1QiDKuh.jpg",
        });
        const [url, requestConfig] = axiosGetMock.mock.calls[0];
        expect(url).toBe("https://api.themoviedb.org/3/find/tt1375666");
        expect(requestConfig.params).toMatchObject({ external_source: "imdb_id" });
    });

    it("maps a tv result", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("find-tv"));

        const info = await makeProvider().findByImdbId("tt0903747");

        expect(info).toMatchObject({ kind: "series", tmdbId: 1396, title: "Breaking Bad", year: 2008 });
    });

    it("prefers the kind hint when both lists have results", async () => {
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: {
                movie_results: [{ id: 1, title: "M", release_date: "2000-01-01", poster_path: null }],
                tv_results: [{ id: 2, name: "S", first_air_date: "2001-01-01", poster_path: null }],
            },
        });

        const info = await makeProvider().findByImdbId("tt1", "series");

        expect(info).toMatchObject({ kind: "series", tmdbId: 2 });
    });

    it("returns null when nothing matches", async () => {
        axiosGetMock.mockResolvedValueOnce({ status: 200, data: { movie_results: [], tv_results: [] } });

        expect(await makeProvider().findByImdbId("tt0")).toBeNull();
    });
});

describe("TmdbProvider.search", () => {
    it("returns the first movie with the year from release_date", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("search-movie"));

        const info = await makeProvider().search("Inception", "movie", 2010);

        expect(info).toMatchObject({ kind: "movie", tmdbId: 27205, title: "Inception", year: 2010, imdbId: null });
        const [url, requestConfig] = axiosGetMock.mock.calls[0];
        expect(url).toBe("https://api.themoviedb.org/3/search/movie");
        expect(requestConfig.params).toMatchObject({ query: "Inception", year: 2010 });
    });

    it("returns the first series with the year from first_air_date", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("search-tv"));

        const info = await makeProvider().search("Breaking Bad", "series", 2008);

        expect(info).toMatchObject({ kind: "series", tmdbId: 1396, title: "Breaking Bad", year: 2008 });
        const [url, requestConfig] = axiosGetMock.mock.calls[0];
        expect(url).toBe("https://api.themoviedb.org/3/search/tv");
        expect(requestConfig.params).toMatchObject({ query: "Breaking Bad", first_air_date_year: 2008 });
    });

    it("omits the year parameter when no year is given", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("search-tv"));

        await makeProvider().search("Breaking Bad", "series");

        expect(axiosGetMock.mock.calls[0][1].params).not.toHaveProperty("first_air_date_year");
    });

    it("returns null for an empty result list", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("search-empty"));

        expect(await makeProvider().search("Nothing", "movie")).toBeNull();
    });

    it("returns null for a 404", async () => {
        axiosGetMock.mockRejectedValueOnce(httpError(404));

        expect(await makeProvider().search("Nothing", "movie")).toBeNull();
    });

    it("sets posterUrl to null when poster_path is missing", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("search-movie-no-poster"));

        const info = await makeProvider().search("No Poster", "movie");

        expect(info?.posterUrl).toBeNull();
    });
});

describe("TmdbProvider seasons and episodes", () => {
    it("returns the season poster", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("tv-season"));

        const poster = await makeProvider().getSeasonPosterUrl(1396, 1);

        expect(poster).toBe("https://image.tmdb.org/t/p/w500/1BP4xYv9ZG4ZVHkL7ocOziBbSYH.jpg");
        expect(axiosGetMock.mock.calls[0][0]).toBe("https://api.themoviedb.org/3/tv/1396/season/1");
    });

    it("returns null when the season has no poster", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("tv-season-no-poster"));

        expect(await makeProvider().getSeasonPosterUrl(1396, 2)).toBeNull();
    });

    it("returns the episode name", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("tv-episode"));

        const name = await makeProvider().getEpisodeTitle(1396, 1, 1);

        expect(name).toBe("Pilot");
        expect(axiosGetMock.mock.calls[0][0]).toBe("https://api.themoviedb.org/3/tv/1396/season/1/episode/1");
    });

    it("returns null for an empty episode name or a 404", async () => {
        axiosGetMock.mockResolvedValueOnce(ok("tv-episode-empty-name"));
        expect(await makeProvider().getEpisodeTitle(1396, 1, 2)).toBeNull();

        axiosGetMock.mockRejectedValueOnce(httpError(404));
        expect(await makeProvider().getEpisodeTitle(1396, 1, 99)).toBeNull();
    });
});

describe("TmdbProvider requests", () => {
    it("sends the language at the time of the call", async () => {
        let language = "en-US";
        const provider = new TmdbProvider({ getApiKey: () => "k", getLanguage: () => language, retryDelayMs: 0 });
        axiosGetMock.mockResolvedValue(ok("search-empty"));

        await provider.search("a", "movie");
        language = "pt-BR";
        await provider.search("a", "movie");

        expect(axiosGetMock.mock.calls[0][1].params.language).toBe("en-US");
        expect(axiosGetMock.mock.calls[1][1].params.language).toBe("pt-BR");
    });

    it("uses Bearer for a token that starts with eyJ and api_key otherwise", async () => {
        axiosGetMock.mockResolvedValue(ok("search-empty"));

        await makeProvider("eyJhbGciOi.payload.sig").search("a", "movie");
        await makeProvider("v3-key").search("a", "movie");

        const [, jwtConfig] = axiosGetMock.mock.calls[0];
        expect(jwtConfig.headers.Authorization).toBe("Bearer eyJhbGciOi.payload.sig");
        expect(jwtConfig.params).not.toHaveProperty("api_key");

        const [, keyConfig] = axiosGetMock.mock.calls[1];
        expect(keyConfig.params.api_key).toBe("v3-key");
        expect(keyConfig.headers?.Authorization).toBeUndefined();
    });

    it("throws MediaProviderError auth on 401", async () => {
        axiosGetMock.mockRejectedValueOnce(httpError(401));

        const error = await makeProvider()
            .search("a", "movie")
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MediaProviderError);
        expect((error as MediaProviderError).reason).toBe("auth");
        expect(axiosGetMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry on 404", async () => {
        axiosGetMock.mockRejectedValueOnce(httpError(404));

        await makeProvider().search("a", "movie");

        expect(axiosGetMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["a 500", httpError(500)],
        ["a 429", httpError(429)],
        ["a timeout", { code: "ECONNABORTED", message: "timeout of 10000ms exceeded" }],
        ["a network error", { code: "ECONNRESET", message: "socket hang up" }],
    ])("retries once on %s and succeeds", async (_label, failure) => {
        axiosGetMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(ok("search-tv"));

        const info = await makeProvider().search("Breaking Bad", "series");

        expect(info?.tmdbId).toBe(1396);
        expect(axiosGetMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["a 500", httpError(500)],
        ["a 429", httpError(429)],
        ["a timeout", { code: "ECONNABORTED", message: "timeout of 10000ms exceeded" }],
    ])("throws MediaProviderError transient after the retry also fails on %s", async (_label, failure) => {
        axiosGetMock.mockRejectedValue(failure);

        const error = await makeProvider()
            .search("a", "movie")
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MediaProviderError);
        expect((error as MediaProviderError).reason).toBe("transient");
        expect(axiosGetMock).toHaveBeenCalledTimes(2);
    });
});
