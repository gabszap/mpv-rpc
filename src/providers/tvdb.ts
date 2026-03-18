/**
 * TheTVDB API V4 Provider - Fetches series/anime metadata
 * API Docs: https://thetvdb.github.io/v4-api/
 *
 * Supports localized titles via language parameter.
 */

import axios from "axios";
import { logApiCall } from "./types";
import type { AnimeProvider, AnimeInfo, AnimeSearchResult } from "./types";
import { config } from "../config";

const TVDB_BASE = "https://api4.thetvdb.com/v4";

// Authentication
let bearerToken: string | null = null;
let tokenExpiry = 0;
const TOKEN_TTL = 28 * 24 * 60 * 60 * 1000; // 28 days

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 500;

// Circuit Breaker
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    threshold: 5,
    cooldown: 30000,
    isOpen(): boolean {
        if (this.failures < this.threshold) return false;
        if (Date.now() - this.lastFailure >= this.cooldown) {
            this.failures = 0;
            return false;
        }
        return true;
    },
    recordFailure(): void {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) {
            console.log(`[TVDB] Circuit breaker OPEN - waiting ${this.cooldown / 1000}s`);
        }
    },
    recordSuccess(): void {
        this.failures = 0;
    },
};

/**
 * Authenticate with TVDB API and get bearer token
 */
async function authenticate(): Promise<string> {
    if (bearerToken && Date.now() < tokenExpiry) {
        return bearerToken;
    }

    const apiKey = config.tvdb.apiKey;
    if (!apiKey) {
        throw new Error("TVDB API key not configured. Set TVDB_API_KEY in .env");
    }

    try {
        const response = await axios.post(`${TVDB_BASE}/login`, {
            apikey: apiKey,
        }, {
            headers: { "Content-Type": "application/json" },
            timeout: 10000,
        });

        bearerToken = response.data?.data?.token;
        if (!bearerToken) {
            throw new Error("No token in TVDB login response");
        }

        tokenExpiry = Date.now() + TOKEN_TTL;
        logApiCall("TVDB", "login", {}, "200 OK", "authenticated");
        console.log("[TVDB] Authenticated successfully");
        return bearerToken;
    } catch (e: any) {
        logApiCall("TVDB", "login", {}, "ERROR", e.message || "auth failed");
        throw new Error(`TVDB authentication failed: ${e.message}`);
    }
}

/**
 * Make an authenticated request to TVDB API
 */
async function tvdbRequest(endpoint: string, params?: Record<string, any>, operation = "query"): Promise<any> {
    if (circuitBreaker.isOpen()) {
        logApiCall("TVDB", operation, params || {}, "CIRCUIT_OPEN", "blocked");
        throw new Error("Circuit breaker open");
    }

    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();

    try {
        const token = await authenticate();

        const response = await axios.get(`${TVDB_BASE}${endpoint}`, {
            params,
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            timeout: 10000,
        });

        circuitBreaker.recordSuccess();
        logApiCall("TVDB", operation, params || {}, "200 OK", "");
        return response.data;
    } catch (e: any) {
        if (e.response?.status === 401) {
            // Token expired, force re-auth
            bearerToken = null;
            tokenExpiry = 0;
            logApiCall("TVDB", operation, params || {}, "401 EXPIRED", "retrying");
            return tvdbRequest(endpoint, params, operation);
        }

        if (e.response?.status === 429) {
            logApiCall("TVDB", operation, params || {}, "429 RATE_LIMITED", "retrying in 2s");
            console.log("[TVDB] Rate limited, waiting 2s...");
            circuitBreaker.recordFailure();
            await new Promise(resolve => setTimeout(resolve, 2000));
            return tvdbRequest(endpoint, params, operation);
        }

        logApiCall("TVDB", operation, params || {}, "ERROR", e.message || "unknown");
        circuitBreaker.recordFailure();
        throw e;
    }
}

/**
 * Get the configured TVDB language code
 * Uses TVDB_LANG from config (e.g. "eng", "por", "jpn", "spa")
 * See: https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes for available language codes
 */
function getTvdbLanguage(): string {
    return config.tvdb.language || "eng";
}

export class TvdbProvider implements AnimeProvider {
    readonly name = "tvdb";

    async searchAnime(title: string): Promise<AnimeSearchResult | null> {
        try {
            const response = await tvdbRequest("/search", {
                query: title,
                type: "series",
                limit: 5,
            }, "search");

            const results = response?.data;
            if (!results || results.length === 0) {
                logApiCall("TVDB", "search", { query: title }, "DETAIL", "0 results");
                return null;
            }

            // Find best match - prefer exact or closest title match
            const result = results[0];
            const tvdbId = parseInt(result.tvdb_id || result.id, 10);

            logApiCall("TVDB", "search", { query: title }, "DETAIL",
                `"${result.name}" (ID:${tvdbId})`);

            return {
                id: tvdbId,
                title: result.name || title,
                title_english: result.name || null,
                type: result.type || "series",
                coverImage: result.image_url || result.thumbnail || null,
            };
        } catch (e) {
            console.error("[TVDB] Search error:", e);
            return null;
        }
    }

    async getAnimeById(id: number): Promise<AnimeInfo | null> {
        try {
            const response = await tvdbRequest(`/series/${id}/extended`, {
                seriesId: id,
                short: true,
            }, "getById");

            const series = response?.data;
            if (!series) return null;

            // series.name = original title (Japanese for anime)
            let titleRomaji = series.name || "";
            let titleEnglish: string | null = null;

            // Always try to get the English title
            if (series.nameTranslations?.includes("eng")) {
                try {
                    const engResponse = await tvdbRequest(
                        `/series/${id}/translations/eng`,
                        { seriesId: id, lang: "eng" },
                        "getTranslation"
                    );
                    if (engResponse?.data?.name) {
                        titleEnglish = engResponse.data.name;
                    }
                } catch {
                    // Fall back to series.name
                }
            }

            // If TVDB_LANG is not English, also fetch localized name for display
            const lang = getTvdbLanguage();
            if (lang !== "eng" && series.nameTranslations?.includes(lang)) {
                try {
                    const transResponse = await tvdbRequest(
                        `/series/${id}/translations/${lang}`,
                        { seriesId: id, lang },
                        "getTranslation"
                    );
                    const translation = transResponse?.data;
                    if (translation?.name) {
                        // Use the localized title as the display title
                        titleEnglish = translation.name;
                    }
                } catch {
                    // Use English title if localized fails
                }
            }

            // Fallback: if no English title found, use series.name
            if (!titleEnglish) {
                titleEnglish = series.name || null;
            }

            // Get artwork - find poster type
            let coverUrl: string | null = series.image || null;
            if (series.artworks && series.artworks.length > 0) {
                // Type 2 = poster in TVDB
                const poster = series.artworks.find((a: any) => a.type === 2);
                if (poster?.image) {
                    coverUrl = poster.image;
                }
            }

            logApiCall("TVDB", "getById", { id }, "DETAIL",
                `"${titleEnglish || titleRomaji}" (${series.status?.name || "unknown"})`);

            return {
                id: id,
                title_english: titleEnglish,
                title_romaji: titleRomaji,
                cover_url: coverUrl,
                total_episodes: undefined, // TVDB doesn't have this in base record
            };
        } catch {
            return null;
        }
    }

    async getEpisodeTitle(seriesId: number, episode: number, season?: number): Promise<string | null> {
        try {
            const seasonNum = season ?? 1;

            const response = await tvdbRequest(
                `/series/${seriesId}/episodes/default`,
                {
                    season: seasonNum,
                    episodeNumber: episode,
                },
                "getEpisode"
            );

            const episodes = response?.data?.episodes;
            if (!episodes || episodes.length === 0) {
                logApiCall("TVDB", "getEpisode",
                    { id: seriesId, season: seasonNum, ep: episode },
                    "DETAIL", "no episodes");
                return null;
            }

            // Find the exact episode
            const ep = episodes.find((e: any) =>
                e.seasonNumber === seasonNum && e.number === episode
            );

            if (!ep) {
                logApiCall("TVDB", "getEpisode",
                    { id: seriesId, season: seasonNum, ep: episode },
                    "DETAIL", "episode not found in results");
                return null;
            }

            let epTitle = ep.name || null;

            // Try to get localized episode title
            const lang = getTvdbLanguage();
            if (epTitle && lang !== "eng" && ep.id) {
                try {
                    const transResponse = await tvdbRequest(
                        `/episodes/${ep.id}/translations/${lang}`,
                        { episodeId: ep.id, lang },
                        "getEpisodeTranslation"
                    );
                    const translation = transResponse?.data;
                    if (translation?.name) {
                        epTitle = translation.name;
                    }
                } catch {
                    // Use default name
                }
            }

            if (epTitle) {
                logApiCall("TVDB", "getEpisode",
                    { id: seriesId, season: seasonNum, ep: episode },
                    "DETAIL", `"${epTitle}"`);
            }

            return epTitle;
        } catch {
            return null;
        }
    }

    async findSeasonAnime(baseId: number, targetSeason: number): Promise<AnimeInfo | null> {
        // TVDB groups all seasons under one series, so we just return the base series
        // The season info is used when fetching episodes
        return this.getAnimeById(baseId);
    }
}
