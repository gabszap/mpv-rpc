/**
 * Jikan API Provider - Fetches anime metadata from MyAnimeList
 */

import axios from "axios";
import { config } from "../config";
import { logApiCall } from "./types";
import type { AnimeProvider, AnimeInfo, AnimeSearchResult } from "./types";

// Rate limiting
let lastRequestTime = 0;

// Circuit Breaker
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    threshold: 5,
    cooldown: 30000,
    isOpen(): boolean {
        if (this.failures < this.threshold) return false;
        const elapsed = Date.now() - this.lastFailure;
        if (elapsed >= this.cooldown) {
            this.reset();
            return false;
        }
        return true;
    },
    recordFailure(): void {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) {
            console.log(`[Jikan] Circuit breaker OPEN - waiting ${this.cooldown / 1000}s`);
        }
    },
    recordSuccess(): void {
        if (this.failures > 0) {
            this.failures = 0;
        }
    },
    reset(): void {
        this.failures = 0;
    },
    getRemainingCooldown(): number {
        return Math.max(0, this.cooldown - (Date.now() - this.lastFailure));
    }
};

/**
 * Make a request to Jikan API with rate limiting
 */
async function jikanRequest(endpoint: string, params?: Record<string, any>, retryCount = 0): Promise<any> {
    if (circuitBreaker.isOpen()) {
        logApiCall("Jikan", endpoint, params, "CIRCUIT_OPEN", "blocked");
        throw new Error(`Circuit breaker open`);
    }

    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < config.jikan.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, config.jikan.minRequestInterval - elapsed));
    }
    lastRequestTime = Date.now();

    try {
        const response = await axios.get(`${config.jikan.baseUrl}${endpoint}`, {
            params,
            timeout: 15000,
        });
        circuitBreaker.recordSuccess();
        logApiCall("Jikan", endpoint, params, `${response.status} OK`, "");
        return response.data;
    } catch (e: any) {
        if (e.response?.status === 429) {
            logApiCall("Jikan", endpoint, params, "429 RATE_LIMITED", "retrying in 1s");
            console.log("[Jikan] Rate limited, waiting 1s...");
            circuitBreaker.recordFailure();
            await new Promise(resolve => setTimeout(resolve, 1000));
            return jikanRequest(endpoint, params, retryCount);
        }

        if ((e.code === "ECONNABORTED" || e.code === "ETIMEDOUT") && retryCount < 3) {
            logApiCall("Jikan", endpoint, params, "TIMEOUT", `retrying... (attempt ${retryCount + 2}/4)`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))); // Exponential backoff
            return jikanRequest(endpoint, params, retryCount + 1);
        }

        logApiCall("Jikan", endpoint, params, "ERROR", e.message || "unknown");
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
    const partPatterns = [/\bpart\s*\d+/i, /\bcour\s*\d+/i];
    return partPatterns.some(p => p.test(title));
}

export class JikanProvider implements AnimeProvider {
    readonly name = "jikan";

    async searchAnime(title: string): Promise<AnimeSearchResult | null> {
        try {
            const response = await jikanRequest("/anime", {
                q: title,
                limit: 10,
                sfw: true,
                order_by: "members",
                sort: "desc",
            });

            if (!response.data || response.data.length === 0) {
                logApiCall("Jikan", "/anime", { q: title }, "DETAIL", "0 results");
                return null;
            }

            const results = response.data;
            const titleLower = title.toLowerCase();

            // Prefer exact matches
            for (const anime of results) {
                const romaji = (anime.title || "").toLowerCase();
                const english = (anime.title_english || "").toLowerCase();

                if (romaji === titleLower || english === titleLower) {
                    return this.mapSearchResult(anime);
                }
                if (romaji.startsWith(titleLower) || english.startsWith(titleLower)) {
                    return this.mapSearchResult(anime);
                }
            }

            // Filter spin-offs
            const spinoffPatterns = /chibi|theatre|theater|special|tebie|caidan|petit|mini/i;
            const mainResults = results.filter((a: any) => !spinoffPatterns.test(a.title || ""));
            const candidates = mainResults.length > 0 ? mainResults : results;

            const tvResult = candidates.find((a: any) => a.type === "TV" || a.type === "ONA");
            const selected = tvResult || candidates[0];
            logApiCall("Jikan", "/anime", { q: title }, "DETAIL", `"${selected.title}" (MAL:${selected.mal_id})`);
            return this.mapSearchResult(selected);
        } catch (e) {
            console.error("[Jikan] Search error:", e);
            return null;
        }
    }

    async getAnimeById(id: number): Promise<AnimeInfo | null> {
        try {
            const response = await jikanRequest(`/anime/${id}`);
            const anime = response.data;
            if (!anime) return null;

            logApiCall("Jikan", `/anime/${id}`, {}, "DETAIL", `"${anime.title_english || anime.title}" (${anime.type})`);

            return {
                id: anime.mal_id,
                title_english: anime.title_english,
                title_romaji: anime.title,
                cover_url: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
            };
        } catch {
            return null;
        }
    }

    async getEpisodeTitle(animeId: number, episode: number): Promise<string | null> {
        try {
            const response = await jikanRequest(`/anime/${animeId}/episodes/${episode}`);
            if (response.data) {
                const title = response.data.title || response.data.title_romanji || null;
                if (title) {
                    logApiCall("Jikan", `/anime/${animeId}/episodes/${episode}`, {}, "DETAIL", `"${title}"`);
                }
                return title;
            }
            logApiCall("Jikan", `/anime/${animeId}/episodes/${episode}`, {}, "DETAIL", "no episode data");
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
        let lastValidId = baseId;

        while (currentSeason < targetSeason) {
            if (visited.has(currentId)) break;
            visited.add(currentId);

            const relations = await this.getRelations(currentId);
            const sequel = this.findSequel(relations);

            if (!sequel) break;

            const sequelAnime = await this.getAnimeById(sequel.mal_id);
            if (!sequelAnime) break;

            currentId = sequelAnime.id;
            lastValidId = currentId;

            const seasonInTitle = extractSeasonNumber(sequelAnime.title_romaji) ||
                extractSeasonNumber(sequelAnime.title_english || "");
            if (seasonInTitle === targetSeason) {
                return sequelAnime;
            }

            // Check if this is a new season or just a "Part"
            const isPart = isPartOfSameSeason(sequelAnime.title_romaji) ||
                isPartOfSameSeason(sequelAnime.title_english || "");
            if (!isPart) {
                currentSeason++;
            }
        }

        return this.getAnimeById(lastValidId);
    }

    private async getRelations(malId: number): Promise<any[]> {
        try {
            const response = await jikanRequest(`/anime/${malId}/relations`);
            return response.data || [];
        } catch {
            return [];
        }
    }

    private findSequel(relations: any[]): { mal_id: number; type: string } | null {
        for (const relation of relations) {
            if (relation.relation === "Sequel") {
                // Prefer TV sequels
                const tvEntry = relation.entry?.find((e: any) => e.type === "TV");
                if (tvEntry) return tvEntry;

                // Fallback to any anime
                const anyEntry = relation.entry?.find((e: any) =>
                    e.type === "Movie" || e.type === "OVA" || e.type === "anime"
                );
                if (anyEntry) return anyEntry;
            }
        }
        return null;
    }

    private mapSearchResult(anime: any): AnimeSearchResult {
        return {
            id: anime.mal_id,
            title: anime.title,
            title_english: anime.title_english,
            type: anime.type,
            coverImage: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
        };
    }
}
