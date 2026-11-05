import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/config", () => ({
    config: { tmdb: { apiKey: "test-key", language: "en-US" } },
}));

import { config } from "../src/core/config";
import {
    clearMediaCacheForTests,
    isMediaProviderConfigured,
    type ResolveMediaInput,
    reloadMediaProvider,
    resolveMedia,
    setMediaProviderForTests,
} from "../src/core/media";
import { type MediaInfo, type MediaProvider, MediaProviderError } from "../src/providers/media-types";

const SERIES_POSTER = "https://image.tmdb.org/t/p/w500/series.jpg";
const SEASON_POSTER = "https://image.tmdb.org/t/p/w500/season.jpg";

function makeInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
    return {
        kind: "series",
        tmdbId: 1396,
        imdbId: null,
        title: "Breaking Bad",
        originalTitle: "Breaking Bad",
        year: 2008,
        posterUrl: SERIES_POSTER,
        animeLikely: false,
        ...overrides,
    };
}

function makeProvider(overrides: Partial<MediaProvider> = {}): MediaProvider & {
    findByImdbId: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    getSeasonPosterUrl: ReturnType<typeof vi.fn>;
    getEpisodeTitle: ReturnType<typeof vi.fn>;
} {
    return {
        name: "fake",
        findByImdbId: vi.fn(async () => makeInfo()),
        search: vi.fn(async () => makeInfo()),
        getSeasonPosterUrl: vi.fn(async () => SEASON_POSTER),
        getEpisodeTitle: vi.fn(async () => "Pilot"),
        ...overrides,
    } as never;
}

function input(overrides: Partial<ResolveMediaInput> = {}): ResolveMediaInput {
    return {
        title: "Breaking Bad",
        kindHint: null,
        season: 1,
        episode: 1,
        year: null,
        imdbId: null,
        ...overrides,
    };
}

beforeEach(() => {
    config.tmdb.apiKey = "test-key";
    config.tmdb.language = "en-US";
    clearMediaCacheForTests();
    reloadMediaProvider();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setMediaProviderForTests(null);
});

describe("resolveMedia lookups", () => {
    it("uses findByImdbId when an imdbId is given and skips title validation", async () => {
        const provider = makeProvider({
            findByImdbId: vi.fn(async () => makeInfo({ title: "Totally Different", year: 1990 })),
        });
        setMediaProviderForTests(provider);

        const result = await resolveMedia(input({ imdbId: "tt0903747", year: 2008, title: "Whatever" }));

        expect(result?.info.title).toBe("Totally Different");
        expect(provider.findByImdbId).toHaveBeenCalledWith("tt0903747", undefined);
        expect(provider.search).not.toHaveBeenCalled();
    });

    it("passes the kind hint to findByImdbId", async () => {
        const provider = makeProvider();
        setMediaProviderForTests(provider);

        await resolveMedia(input({ imdbId: "tt1", kindHint: "movie", season: null, episode: null }));

        expect(provider.findByImdbId).toHaveBeenCalledWith("tt1", "movie");
    });

    it("searches a series when season or episode is present, a movie otherwise, and honors kindHint", async () => {
        const provider = makeProvider({
            search: vi.fn(async (_t: string, kind) => makeInfo({ kind, title: "Breaking Bad" })),
        });
        setMediaProviderForTests(provider);

        await resolveMedia(input({ season: null, episode: 3 }));
        await resolveMedia(input({ season: null, episode: null }));
        await resolveMedia(input({ season: 1, episode: 1, kindHint: "movie", year: 2008 }));

        expect(provider.search.mock.calls.map((call) => call[1])).toEqual(["series", "movie", "movie"]);
    });

    it("assumes season 1 when a series has an episode but no season", async () => {
        const provider = makeProvider();
        setMediaProviderForTests(provider);

        await resolveMedia(input({ season: null, episode: 5 }));

        expect(provider.getEpisodeTitle).toHaveBeenCalledWith(1396, 1, 5);
        expect(provider.getSeasonPosterUrl).toHaveBeenCalledWith(1396, 1);
    });

    it("uses the season poster, falling back to the series poster", async () => {
        const provider = makeProvider();
        setMediaProviderForTests(provider);
        expect((await resolveMedia(input()))?.coverUrl).toBe(SEASON_POSTER);

        clearMediaCacheForTests();
        provider.getSeasonPosterUrl.mockResolvedValue(null);
        expect((await resolveMedia(input()))?.coverUrl).toBe(SERIES_POSTER);
    });

    it("returns the movie poster and no episode title for a movie", async () => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ kind: "movie", title: "Inception", year: 2010 })),
        });
        setMediaProviderForTests(provider);

        const result = await resolveMedia(input({ title: "Inception", season: null, episode: null, year: 2010 }));

        expect(result).toMatchObject({ coverUrl: SERIES_POSTER, episodeTitle: null });
        expect(provider.getSeasonPosterUrl).not.toHaveBeenCalled();
        expect(provider.getEpisodeTitle).not.toHaveBeenCalled();
    });

    it("keeps the result with a null episodeTitle when the provider has no episode name", async () => {
        const provider = makeProvider({ getEpisodeTitle: vi.fn(async () => null) });
        setMediaProviderForTests(provider);

        const result = await resolveMedia(input());

        expect(result?.episodeTitle).toBeNull();
        expect(result?.info.title).toBe("Breaking Bad");
    });
});

describe("resolveMedia without a key", () => {
    it("returns null, does not call the provider and does not warn on every call", async () => {
        config.tmdb.apiKey = "";
        const provider = makeProvider();
        setMediaProviderForTests(provider);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(isMediaProviderConfigured()).toBe(false);
        expect(await resolveMedia(input())).toBeNull();
        expect(await resolveMedia(input())).toBeNull();

        expect(provider.search).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});

describe("resolveMedia cache", () => {
    it("caches a hit for 24 h and a miss for 10 min", async () => {
        vi.useFakeTimers();
        const provider = makeProvider();
        setMediaProviderForTests(provider);

        await resolveMedia(input());
        await resolveMedia(input());
        expect(provider.search).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(23 * 60 * 60 * 1000);
        await resolveMedia(input());
        expect(provider.search).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2 * 60 * 60 * 1000);
        await resolveMedia(input());
        expect(provider.search).toHaveBeenCalledTimes(2);

        clearMediaCacheForTests();
        const missing = makeProvider({ search: vi.fn(async () => null) });
        setMediaProviderForTests(missing);
        await resolveMedia(input({ title: "Nothing Here" }));
        await resolveMedia(input({ title: "Nothing Here" }));
        expect(missing.search).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(9 * 60 * 1000);
        await resolveMedia(input({ title: "Nothing Here" }));
        expect(missing.search).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2 * 60 * 1000);
        await resolveMedia(input({ title: "Nothing Here" }));
        expect(missing.search).toHaveBeenCalledTimes(2);
    });

    it("shares one pending lookup between concurrent calls", async () => {
        const provider = makeProvider();
        setMediaProviderForTests(provider);

        const [a, b] = await Promise.all([resolveMedia(input()), resolveMedia(input())]);

        expect(provider.search).toHaveBeenCalledTimes(1);
        expect(a?.info.tmdbId).toBe(b?.info.tmdbId);
    });

    it("keys the cache by language", async () => {
        const provider = makeProvider();
        setMediaProviderForTests(provider);

        await resolveMedia(input());
        config.tmdb.language = "pt-BR";
        await resolveMedia(input());

        expect(provider.search).toHaveBeenCalledTimes(2);
    });
});

describe("resolveMedia failures", () => {
    it("returns null on a transient failure and does not cache it", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const provider = makeProvider();
        provider.search.mockRejectedValueOnce(new MediaProviderError("transient", "timeout"));
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input())).toBeNull();
        vi.advanceTimersByTime(61 * 1000);
        const second = await resolveMedia(input());

        expect(second?.info.title).toBe("Breaking Bad");
        expect(provider.search).toHaveBeenCalledTimes(2);
    });

    it("keeps the result when the episode lookup fails transiently, without caching the failure", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const provider = makeProvider();
        provider.getEpisodeTitle.mockRejectedValueOnce(new MediaProviderError("transient", "boom"));
        setMediaProviderForTests(provider);

        const first = await resolveMedia(input());
        const second = await resolveMedia(input());

        expect(first).toMatchObject({ episodeTitle: null, coverUrl: SEASON_POSTER });
        expect(second?.episodeTitle).toBe("Pilot");
    });

    it("disables the provider after an auth error until reloadMediaProvider()", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const provider = makeProvider();
        provider.search.mockRejectedValueOnce(new MediaProviderError("auth", "401"));
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input())).toBeNull();
        expect(isMediaProviderConfigured()).toBe(false);
        expect(await resolveMedia(input())).toBeNull();
        expect(provider.search).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);

        reloadMediaProvider();

        expect(isMediaProviderConfigured()).toBe(true);
        expect((await resolveMedia(input()))?.info.title).toBe("Breaking Bad");
    });
});

describe("resolveMedia outage cooldown", () => {
    it("does not call the provider or warn again during the cooldown after a transient failure", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const provider = makeProvider();
        provider.search.mockRejectedValue(new MediaProviderError("transient", "offline"));
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input())).toBeNull();
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(1000);
            expect(await resolveMedia(input({ title: `Other ${i}` }))).toBeNull();
        }

        expect(provider.search).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(60 * 1000);
        await resolveMedia(input());
        expect(provider.search).toHaveBeenCalledTimes(2);
    });
});

describe("resolveMedia match validation", () => {
    it.each([
        ["Dr", "Dr. Strangelove or: How I Learned to Stop Worrying"],
        ["It", "It Follows"],
        ["Up", "Up Close and Personal"],
        ["Dune", "Dune: Part Two"],
    ])("rejects a one word title %s that only starts a longer title", async (fileTitle, tmdbTitle) => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ kind: "movie", title: tmdbTitle, originalTitle: tmdbTitle })),
        });
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input({ title: fileTitle, season: null, episode: null }))).toBeNull();
    });

    it("accepts a one word title that equals the result title", async () => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ kind: "movie", title: "Dune", year: 2021 })),
        });
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input({ title: "Dune", season: null, episode: null }))).not.toBeNull();
    });

    it("accepts a one word title for a longer result when the file year matches", async () => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ kind: "movie", title: "Dune: Part Two", year: 2024 })),
        });
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input({ title: "Dune", season: null, episode: null, year: 2024 }))).not.toBeNull();
    });

    it("rejects a result whose title does not match", async () => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ title: "Itaewon Class", originalTitle: "Itaewon Class" })),
        });
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input({ title: "It", season: null, episode: null }))).toBeNull();
    });

    it("accepts a match through the original title", async () => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ title: "La Casa de Papel", originalTitle: "Money Heist" })),
        });
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input({ title: "Money Heist" }))).not.toBeNull();
    });

    it("rejects a result whose year differs by more than one", async () => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ kind: "movie", title: "Dune", year: 1984 })),
        });
        setMediaProviderForTests(provider);

        expect(await resolveMedia(input({ title: "Dune", season: null, episode: null, year: 2021 }))).toBeNull();
    });

    it("accepts a year off by one and a result with no year", async () => {
        const provider = makeProvider({
            search: vi.fn(async () => makeInfo({ kind: "movie", title: "Dune", year: 2020 })),
        });
        setMediaProviderForTests(provider);
        expect(await resolveMedia(input({ title: "Dune", season: null, episode: null, year: 2021 }))).not.toBeNull();

        clearMediaCacheForTests();
        provider.search.mockResolvedValue(makeInfo({ kind: "movie", title: "Dune", year: null }));
        expect(await resolveMedia(input({ title: "Dune", season: null, episode: null, year: 2021 }))).not.toBeNull();
    });
});
