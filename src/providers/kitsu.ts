/**
 * Kitsu API Provider - Fetches anime metadata from Kitsu.io
 * API Docs: https://kitsu.docs.apiary.io/
 */

import axios from "axios";
import { formatProviderErrorDetails, logApiCall } from "./types";
import type { AnimeProvider, AnimeInfo, AnimeSearchResult, EpisodeLookupContext } from "./types";
import { config } from "../config";

// Extended AnimeInfo with type for internal use
interface KitsuAnimeInfo extends AnimeInfo {
    type?: string;
}

const KITSU_API = "https://kitsu.io/api/edge";

// Rate limiting (Kitsu is generous but we'll be safe)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 300;

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
            console.log(`[Kitsu] Circuit breaker OPEN - waiting ${this.cooldown / 1000}s`);
        }
    },
    recordSuccess(): void {
        this.failures = 0;
    },
};

/**
 * Make a request to Kitsu API
 */
async function kitsuRequest(endpoint: string, params?: Record<string, any>): Promise<any> {
    if (circuitBreaker.isOpen()) {
        logApiCall("Kitsu", endpoint, params, "CIRCUIT_OPEN", "blocked");
        throw new Error("Circuit breaker open");
    }

    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();

    try {
        const response = await axios.get(`${KITSU_API}${endpoint}`, {
            params,
            headers: {
                "Accept": "application/vnd.api+json",
                "Content-Type": "application/vnd.api+json",
            },
            timeout: 10000,
        });

        circuitBreaker.recordSuccess();
        logApiCall("Kitsu", endpoint, params, `${response.status} OK`, "");
        return response.data;
    } catch (e: any) {
        if (e.response?.status === 429) {
            logApiCall("Kitsu", endpoint, params, "429 RATE_LIMITED", "retrying in 2s");
            console.log("[Kitsu] Rate limited, waiting 2s...");
            circuitBreaker.recordFailure();
            await new Promise(resolve => setTimeout(resolve, 2000));
            return kitsuRequest(endpoint, params);
        }

        logApiCall("Kitsu", endpoint, params, "ERROR", e.message || "unknown");
        if (config.debug) {
            logApiCall("Kitsu", endpoint, params, "ERROR_DETAIL", formatProviderErrorDetails("Kitsu", endpoint, e));
        }
        circuitBreaker.recordFailure();
        throw e;
    }
}

function extractSeasonNumber(title: string): number | null {
    const patterns = [
        /(?:season|s)\s*(\d+)/i,
        /(\d+)(?:st|nd|rd|th)\s*season/i,
    ];
    for (const pattern of patterns) {
        const match = title.match(pattern);
        if (match) return parseInt(match[1], 10);
    }
    return null;
}

function isPartOfSameSeason(title: string): boolean {
    return /\bpart\s*\d+/i.test(title) || /\bcour\s*\d+/i.test(title);
}

export class KitsuProvider implements AnimeProvider {
    readonly name = "kitsu";

    async searchAnime(title: string): Promise<AnimeSearchResult | null> {
        try {
            const response = await kitsuRequest("/anime", {
                "filter[text]": title,
                "page[limit]": 10,
            });

            const data = response.data;
            if (!data || data.length === 0) {
                logApiCall("Kitsu", "/anime", { "filter[text]": title }, "DETAIL", "0 results");
                return null;
            }

            // First result is usually most relevant
            const anime = data[0];
            const attrs = anime.attributes;

            logApiCall("Kitsu", "/anime", { "filter[text]": title }, "DETAIL",
                `"${attrs.canonicalTitle}" (ID:${anime.id})`);

            return {
                id: parseInt(anime.id),
                title: attrs.canonicalTitle,
                title_english: attrs.titles?.en || attrs.canonicalTitle,
                type: this.mapSubtype(attrs.subtype),
                coverImage: attrs.posterImage?.large || attrs.posterImage?.original || null,
            };
        } catch (e) {
            console.error("[Kitsu] Search error:", e);
            return null;
        }
    }

    async getAnimeById(id: number): Promise<AnimeInfo | null> {
        try {
            const response = await kitsuRequest(`/anime/${id}`);
            const anime = response.data;
            if (!anime) return null;

            const attrs = anime.attributes;
            logApiCall("Kitsu", `/anime/${id}`, {}, "DETAIL",
                `"${attrs.titles?.en || attrs.canonicalTitle}" (${attrs.subtype})`);

            return {
                id: parseInt(anime.id),
                title_english: attrs.titles?.en || null,
                title_romaji: attrs.titles?.en_jp || attrs.canonicalTitle,
                cover_url: attrs.posterImage?.large || attrs.posterImage?.original || null,
            };
        } catch {
            return null;
        }
    }

    async getEpisodeTitle(
        animeId: number,
        episode: number,
        _season?: number,
        _context?: EpisodeLookupContext
    ): Promise<string | null> {
        try {
            const response = await kitsuRequest(`/anime/${animeId}/episodes`, {
                "filter[number]": episode,
                "page[limit]": 1,
            });

            const episodes = response.data;
            if (episodes && episodes.length > 0) {
                const epAttrs = episodes[0].attributes;
                const title = epAttrs.titles?.en_us || epAttrs.titles?.en_jp || epAttrs.canonicalTitle;
                if (title) {
                    logApiCall("Kitsu", `/anime/${animeId}/episodes`, { ep: episode }, "DETAIL", `"${title}"`);
                    return title;
                }
            }
            logApiCall("Kitsu", `/anime/${animeId}/episodes`, { ep: episode }, "DETAIL", "no episode data");
            return null;
        } catch {
            return null;
        }
    }

    async findSeasonAnime(baseId: number, targetSeason: number): Promise<AnimeInfo | null> {
        if (targetSeason <= 1) {
            return this.getAnimeById(baseId);
        }

        const visited = new Set<number>();
        let currentId = baseId;
        let currentSeason = 1;
        let lastValidAnime: KitsuAnimeInfo | null = null;
        let lastTvAnime: KitsuAnimeInfo | null = null;

        // Get base anime first
        lastValidAnime = await this.getAnimeById(baseId);
        lastTvAnime = lastValidAnime;
        if (!lastValidAnime) return null;

        while (currentSeason < targetSeason) {
            if (visited.has(currentId)) break;
            visited.add(currentId);

            // Get all sequels (not just TV)
            const sequel = await this.getSequel(currentId);
            if (!sequel) break;

            currentId = sequel.id;
            lastValidAnime = sequel;

            // Check if this is a TV/ONA series
            const isTvSeries = sequel.type === "TV" || sequel.type === "ONA";

            if (isTvSeries) {
                lastTvAnime = sequel;

                // Check if title contains target season number
                const seasonInTitle = extractSeasonNumber(sequel.title_romaji) ||
                    extractSeasonNumber(sequel.title_english || "");
                if (seasonInTitle === targetSeason) {
                    logApiCall("Kitsu", "findSeason", { baseId, targetSeason }, "DETAIL",
                        `found: "${sequel.title_romaji}" (ID:${sequel.id})`);
                    return sequel;
                }

                // Skip "Part" entries that are same season
                const isPart = isPartOfSameSeason(sequel.title_romaji) ||
                    isPartOfSameSeason(sequel.title_english || "");
                if (!isPart) {
                    currentSeason++;
                }
            }
            // For movies/specials, just continue navigating without incrementing season
            // This allows us to skip movies in the middle of a franchise
        }

        // Return the last TV series found
        return lastTvAnime || lastValidAnime;
    }

    private async getSequel(animeId: number): Promise<KitsuAnimeInfo | null> {
        try {
            // Use include to get relationships with destination anime in one request
            const response = await kitsuRequest(`/anime/${animeId}/media-relationships`, {
                "filter[role]": "sequel",
                "include": "destination",
                "page[limit]": 5,
            });

            const relationships = response.data;
            const included = response.included || [];

            if (!relationships || relationships.length === 0) {
                return null;
            }

            // Find TV/ONA sequel preferably
            for (const rel of relationships) {
                const destId = rel.relationships?.destination?.data?.id;
                if (!destId) continue;

                // Find the included anime
                const anime = included.find((inc: any) =>
                    inc.type === "anime" && inc.id === destId
                );

                if (anime) {
                    const attrs = anime.attributes;
                    // Prefer TV/ONA
                    if (attrs.subtype === "TV" || attrs.subtype === "ONA") {
                        logApiCall("Kitsu", `/anime/${animeId}/media-relationships`, {}, "DETAIL",
                            `sequel: "${attrs.canonicalTitle}" (ID:${anime.id})`);
                        return {
                            id: parseInt(anime.id),
                            title_english: attrs.titles?.en || null,
                            title_romaji: attrs.titles?.en_jp || attrs.canonicalTitle,
                            cover_url: attrs.posterImage?.large || attrs.posterImage?.original || null,
                            type: attrs.subtype,
                        };
                    }
                }
            }

            // Fallback to first sequel if no TV/ONA found
            const firstRel = relationships[0];
            const destId = firstRel.relationships?.destination?.data?.id;
            const anime = included.find((inc: any) => inc.type === "anime" && inc.id === destId);

            if (anime) {
                const attrs = anime.attributes;
                logApiCall("Kitsu", `/anime/${animeId}/media-relationships`, {}, "DETAIL",
                    `sequel: "${attrs.canonicalTitle}" (ID:${anime.id})`);
                return {
                    id: parseInt(anime.id),
                    title_english: attrs.titles?.en || null,
                    title_romaji: attrs.titles?.en_jp || attrs.canonicalTitle,
                    cover_url: attrs.posterImage?.large || attrs.posterImage?.original || null,
                    type: attrs.subtype,
                };
            }

            return null;
        } catch {
            return null;
        }
    }

    private mapSubtype(subtype: string): string {
        const subtypeMap: Record<string, string> = {
            TV: "TV",
            movie: "Movie",
            special: "Special",
            OVA: "OVA",
            ONA: "ONA",
            music: "Music",
        };
        return subtypeMap[subtype] || subtype || "TV";
    }
}
