import axios from "axios";
import { type MediaInfo, type MediaKind, type MediaProvider, MediaProviderError } from "./media-types";
import { logApiCall } from "./types";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const REQUEST_TIMEOUT_MS = 6000;
const ANIMATION_GENRE_ID = 16;
const DEFAULT_RETRY_DELAY_MS = 500;
const BEARER_TOKEN_PREFIX = "eyJ";

export interface TmdbProviderOptions {
    getApiKey: () => string;
    getLanguage: () => string;
    retryDelayMs?: number;
}

interface TmdbItem {
    id?: number;
    title?: string;
    name?: string;
    original_title?: string;
    original_name?: string;
    release_date?: string;
    first_air_date?: string;
    poster_path?: string | null;
    genre_ids?: number[];
    origin_country?: string[];
    original_language?: string;
}

interface TmdbListResponse {
    results?: TmdbItem[];
}

interface TmdbFindResponse {
    movie_results?: TmdbItem[];
    tv_results?: TmdbItem[];
}

interface TmdbFailure {
    code?: string;
    message?: string;
    response?: { status?: number };
}

/** Match common language aliases accepted by the other metadata providers. */
function normalizeLanguage(language: string): string {
    const aliases: Record<string, string> = {
        pt: "pt-BR",
        por: "pt-BR",
        en: "en-US",
        eng: "en-US",
        ja: "ja-JP",
        jpn: "ja-JP",
    };
    const trimmed = language.trim();
    return aliases[trimmed.toLowerCase()] ?? (trimmed || "en-US");
}

function parseYear(date: string | undefined): number | null {
    const match = /^(\d{4})/.exec(date ?? "");
    return match ? Number(match[1]) : null;
}

function posterUrl(posterPath: string | null | undefined): string | null {
    return posterPath ? `${TMDB_IMAGE_BASE}${posterPath}` : null;
}

function looksLikeAnime(item: TmdbItem): boolean {
    const isAnimation = item.genre_ids?.includes(ANIMATION_GENRE_ID) === true;
    const isJapanese = item.origin_country?.includes("JP") === true || item.original_language === "ja";
    return isAnimation && isJapanese;
}

function toMediaInfo(item: TmdbItem, kind: MediaKind, imdbId: string | null): MediaInfo | null {
    const title = (kind === "movie" ? item.title : item.name) ?? "";
    if (typeof item.id !== "number" || title.length === 0) return null;
    const originalTitle = kind === "movie" ? item.original_title : item.original_name;
    return {
        kind,
        tmdbId: item.id,
        imdbId,
        title,
        originalTitle: originalTitle || null,
        year: parseYear(kind === "movie" ? item.release_date : item.first_air_date),
        posterUrl: posterUrl(item.poster_path),
        animeLikely: looksLikeAnime(item),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TmdbProvider implements MediaProvider {
    readonly name = "tmdb";

    private readonly options: TmdbProviderOptions;

    constructor(options: TmdbProviderOptions) {
        this.options = options;
    }

    async findByImdbId(imdbId: string, kindHint?: MediaKind): Promise<MediaInfo | null> {
        const data = await this.request<TmdbFindResponse>(`/find/${encodeURIComponent(imdbId)}`, {
            external_source: "imdb_id",
        });
        if (!data) return null;

        const movie = data.movie_results?.[0];
        const series = data.tv_results?.[0];
        const order: MediaKind[] = kindHint === "series" ? ["series", "movie"] : ["movie", "series"];
        for (const kind of order) {
            const item = kind === "movie" ? movie : series;
            const info = item ? toMediaInfo(item, kind, imdbId) : null;
            if (info) return info;
        }
        return null;
    }

    async search(title: string, kind: MediaKind, year?: number | null): Promise<MediaInfo | null> {
        const params: Record<string, string | number> = { query: title };
        if (year) {
            params[kind === "movie" ? "year" : "first_air_date_year"] = year;
        }
        const data = await this.request<TmdbListResponse>(kind === "movie" ? "/search/movie" : "/search/tv", params);
        const item = data?.results?.[0];
        return item ? toMediaInfo(item, kind, null) : null;
    }

    async getSeasonPosterUrl(seriesId: number, season: number): Promise<string | null> {
        const data = await this.request<TmdbItem>(`/tv/${seriesId}/season/${season}`, {});
        return posterUrl(data?.poster_path);
    }

    async getEpisodeTitle(seriesId: number, season: number, episode: number): Promise<string | null> {
        const data = await this.request<TmdbItem>(`/tv/${seriesId}/season/${season}/episode/${episode}`, {});
        return data?.name ? data.name : null;
    }

    /** GET with credentials, language, timeout and one retry for transient failures. `null` on 404. */
    private async request<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
        const apiKey = this.options.getApiKey();
        const requestParams: Record<string, string | number> = {
            ...params,
            language: normalizeLanguage(this.options.getLanguage()),
        };
        const headers: Record<string, string> = {};
        if (apiKey.startsWith(BEARER_TOKEN_PREFIX)) {
            headers.Authorization = `Bearer ${apiKey}`;
        } else {
            requestParams.api_key = apiKey;
        }

        const maxAttempts = 2;
        let lastMessage = "request failed";
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await axios.get(`${TMDB_BASE}${path}`, {
                    params: requestParams,
                    headers,
                    timeout: REQUEST_TIMEOUT_MS,
                });
                logApiCall(
                    "TMDb",
                    path,
                    { ...params, language: requestParams.language },
                    `${response.status} OK`,
                    `attempt ${attempt}`,
                );
                return response.data as T;
            } catch (error) {
                const failure = error as TmdbFailure;
                const status = failure.response?.status;
                logApiCall(
                    "TMDb",
                    path,
                    { ...params, language: requestParams.language },
                    status ? String(status) : "NETWORK_ERROR",
                    `attempt ${attempt}/${maxAttempts}`,
                );
                if (status === 404) return null;
                if (status === 401) {
                    throw new MediaProviderError("auth", "TMDb rejected the API key (401)");
                }
                lastMessage = status ? `TMDb responded with ${status}` : (failure.message ?? "network error");
                if (attempt < maxAttempts) {
                    await sleep(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
                }
            }
        }
        throw new MediaProviderError("transient", lastMessage);
    }
}
