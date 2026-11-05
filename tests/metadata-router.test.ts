import { afterEach, describe, expect, it, vi } from "vitest";
import { planMetadataRoute, type ResolvedMetadata, routeMetadata } from "../src/core/metadata-router";

function metadata(overrides: Partial<ResolvedMetadata> = {}): ResolvedMetadata {
    return {
        coverImage: null,
        seriesTitle: "Title",
        episodeTitle: null,
        malId: null,
        totalEpisodes: null,
        adjustedEpisode: null,
        metadataSourceProvider: null,
        ...overrides,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("planMetadataRoute", () => {
    it.each([
        [
            { parsedMediaType: "unknown", stremioType: "movie" },
            { first: "media", fallback: "anime" },
        ],
        [
            { parsedMediaType: "anime", stremioType: undefined },
            { first: "anime", fallback: null },
        ],
        [
            { parsedMediaType: "series", stremioType: undefined },
            { first: "media", fallback: "anime" },
        ],
        [
            { parsedMediaType: "unknown", stremioType: undefined },
            { first: "media", fallback: "anime" },
        ],
        [
            { parsedMediaType: "anime", stremioType: "movie" },
            { first: "media", fallback: "anime" },
        ],
        [
            { parsedMediaType: "anime", stremioType: "series" },
            { first: "anime", fallback: null },
        ],
    ] as const)("plans %j as %j", (input, expected) => {
        expect(planMetadataRoute(input)).toEqual(expected);
    });
});

describe("routeMetadata", () => {
    it("uses the first pipeline result and does not call the fallback", async () => {
        const media = vi.fn(async () => metadata({ seriesTitle: "From media" }));
        const anime = vi.fn(async () => metadata({ seriesTitle: "From anime" }));

        const routed = await routeMetadata({ parsedMediaType: "series", stremioType: undefined }, { anime, media });

        expect(routed.pipeline).toBe("media");
        expect(routed.result?.seriesTitle).toBe("From media");
        expect(anime).not.toHaveBeenCalled();
    });

    it("falls back when the first returns null", async () => {
        const media = vi.fn(async () => null);
        const anime = vi.fn(async () => metadata({ seriesTitle: "From anime" }));

        const routed = await routeMetadata({ parsedMediaType: "unknown", stremioType: "movie" }, { anime, media });

        expect(routed.pipeline).toBe("anime");
        expect(routed.result?.seriesTitle).toBe("From anime");
    });

    it("falls back when the media pipeline throws, without propagating", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const media = vi.fn(async () => {
            throw new Error("boom");
        });
        const anime = vi.fn(async () => metadata({ seriesTitle: "From anime" }));

        const routed = await routeMetadata({ parsedMediaType: "unknown", stremioType: undefined }, { anime, media });

        expect(routed.pipeline).toBe("anime");
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("returns null and pipeline null when both miss", async () => {
        const routed = await routeMetadata(
            { parsedMediaType: "unknown", stremioType: undefined },
            { anime: async () => null, media: async () => null },
        );

        expect(routed).toEqual({ result: null, pipeline: null });
    });

    it("does not call media for anime", async () => {
        const media = vi.fn(async () => metadata());
        const anime = vi.fn(async () => metadata({ seriesTitle: "From anime" }));

        const routed = await routeMetadata({ parsedMediaType: "anime", stremioType: undefined }, { anime, media });

        expect(routed.pipeline).toBe("anime");
        expect(media).not.toHaveBeenCalled();
    });

    it("lets an anime pipeline error propagate", async () => {
        const anime = vi.fn(async () => {
            throw new Error("anime down");
        });

        await expect(
            routeMetadata({ parsedMediaType: "anime", stremioType: undefined }, { anime, media: async () => null }),
        ).rejects.toThrow("anime down");
    });
});
