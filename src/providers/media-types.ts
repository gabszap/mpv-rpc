export type MediaKind = "movie" | "series";

export interface MediaInfo {
    kind: MediaKind;
    tmdbId: number;
    imdbId: string | null;
    title: string;
    originalTitle: string | null;
    year: number | null;
    posterUrl: string | null;
    /** True for Japanese animation (genre Animation, Japanese origin); such files belong to the anime pipeline. */
    animeLikely: boolean;
}

/**
 * Metadata source for movies and non-anime series. Anime uses `AnimeProvider`; the two
 * contracts are kept apart on purpose.
 */
export interface MediaProvider {
    readonly name: string;
    findByImdbId(imdbId: string, kindHint?: MediaKind): Promise<MediaInfo | null>;
    search(title: string, kind: MediaKind, year?: number | null): Promise<MediaInfo | null>;
    getSeasonPosterUrl(seriesId: number, season: number): Promise<string | null>;
    getEpisodeTitle(seriesId: number, season: number, episode: number): Promise<string | null>;
}

export type MediaProviderErrorReason = "auth" | "transient";

/**
 * Thrown for failures that are not "not found": a rejected credential ("auth") or a
 * temporary problem such as a timeout, 5xx, 429 or network error ("transient").
 */
export class MediaProviderError extends Error {
    readonly reason: MediaProviderErrorReason;

    constructor(reason: MediaProviderErrorReason, message: string) {
        super(message);
        this.name = "MediaProviderError";
        this.reason = reason;
    }
}
