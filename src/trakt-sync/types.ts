/**
 * Trakt.tv API Types
 * Type definitions for Trakt API responses and internal structures
 */

/** Trakt user object from /users/me */
export interface TraktUser {
    username: string;
    name: string;
    ids: { slug: string };
}

/** OAuth2 token response from Trakt */
export interface TraktTokens {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
    created_at: number;
    expires_at: number;
}

/** IDs object returned in Trakt media responses */
export interface TraktIds {
    trakt: number;
    slug: string;
    imdb?: string;
    tmdb?: number;
    tvdb?: number;
    tvrage?: string;
}

/** Trakt show object */
export interface TraktShow {
    title: string;
    year: number;
    ids: TraktIds;
}

/** Trakt episode object */
export interface TraktEpisode {
    season: number;
    number: number;
    title: string;
    ids: TraktIds;
}

/** Trakt media object (used in search results) */
export interface TraktMedia {
    type: "show" | "movie" | "episode";
    score?: number;
    show?: TraktShow;
    episode?: TraktEpisode;
}

/** Search result from Trakt API */
export interface TraktSearchResult {
    type: string;
    score: number;
    show: TraktShow;
}

/** History item from Trakt sync/history */
export interface TraktHistoryItem {
    id: number;
    watched_at: string;
    action: string;
    type: string;
    show: TraktShow;
    episode: TraktEpisode;
}

/** Season/episode mapping from Trakt */
export interface TraktSeasonEpisode {
    number: number;
    episodes: TraktEpisode[];
}
