/**
 * Jikan API Provider - Fetches anime metadata from MyAnimeList
 */

import axios from "axios";
import { config } from "../config";
import { formatProviderErrorDetails, logApiCall } from "./types";
import type { AnimeProvider, AnimeInfo, AnimeSearchResult, EpisodeLookupContext, SequelInfo } from "./types";

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
        if (config.debug) {
            logApiCall("Jikan", endpoint, params, "ERROR_DETAIL", formatProviderErrorDetails("Jikan", endpoint, e));
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
    const partPatterns = [/\bpart\s*\d+/i, /\bcour\s*\d+/i];
    return partPatterns.some(p => p.test(title));
}

/**
 * Extract season number from Jikan titles array (synonyms, etc.)
 * Handles patterns like "4th Season", "Season 4", etc.
 * Note: "Part X" and "Cour X" are sub-season divisions, not season indicators —
 * they are handled separately by isPartOfSameSeason().
 */
function extractSeasonFromTitles(titles: any[]): number | null {
    if (!titles || !Array.isArray(titles)) return null;

    const seasonPatterns = [
        /(\d+)(?:st|nd|rd|th)\s*season/i,
        /season\s*(\d+)/i,
    ];

    for (const entry of titles) {
        const title = entry?.title || entry;
        if (typeof title !== "string") continue;

        for (const pattern of seasonPatterns) {
            const match = title.match(pattern);
            if (match) return parseInt(match[1], 10);
        }
    }

    return null;
}

/**
 * Normalize a title for comparison purposes
 * Removes/normalizes special characters like /, -, _, . and extra whitespace
 * This is only for matching, the original title is preserved
 */
function normalizeForComparison(title: string): string {
    return title
        .toLowerCase()
        .replace(/[\/\-_.:]+/g, " ")  // Replace special chars with space
        .replace(/\s+/g, " ")          // Collapse multiple spaces
        .trim();
}

/**
 * Calculate a similarity score between search query and anime title
 * Higher score = better match
 */
function calculateTitleScore(query: string, animeTitle: string, englishTitle: string | null): number {
    const normalizedQuery = normalizeForComparison(query);
    const normalizedRomaji = normalizeForComparison(animeTitle);
    const normalizedEnglish = englishTitle ? normalizeForComparison(englishTitle) : "";

    let score = 0;

    // Exact match (highest priority)
    if (normalizedRomaji === normalizedQuery || normalizedEnglish === normalizedQuery) {
        score += 1000;
    }

    // Starts with query (high priority)
    if (normalizedRomaji.startsWith(normalizedQuery) || normalizedEnglish.startsWith(normalizedQuery)) {
        score += 500;
    }

    // Contains all words from query (medium priority)
    const queryWords = normalizedQuery.split(" ").filter(w => w.length > 1);
    const titleWords = `${normalizedRomaji} ${normalizedEnglish}`;
    const matchedWords = queryWords.filter(w => titleWords.includes(w));
    if (matchedWords.length === queryWords.length) {
        score += 300 + (matchedWords.length * 50);
    } else {
        // Partial word match
        score += matchedWords.length * 30;
    }

    // Contains query as substring
    if (normalizedRomaji.includes(normalizedQuery) || normalizedEnglish.includes(normalizedQuery)) {
        score += 200;
    }

    // Penalize if title is much longer than query (likely wrong anime)
    const lengthRatio = normalizedQuery.length / Math.max(normalizedRomaji.length, normalizedEnglish.length || 1);
    if (lengthRatio < 0.3) {
        score -= 100;
    }

    return score;
}

function formatCompactJikanError(error: unknown): string {
    const err = (error ?? {}) as {
        message?: unknown;
        code?: unknown;
        response?: {
            status?: unknown;
        };
    };

    const status = typeof err.response?.status === "number" ? err.response.status : null;
    const code = typeof err.code === "string" ? err.code : null;
    const message = typeof err.message === "string" ? err.message : "unknown error";

    if (status !== null && code) {
        return `status ${status} (${code}): ${message}`;
    }

    if (status !== null) {
        return `status ${status}: ${message}`;
    }

    if (code) {
        return `${code}: ${message}`;
    }

    return message;
}

export class JikanProvider implements AnimeProvider {
    readonly name = "jikan";

    async searchAnime(title: string, expectedSeason?: number): Promise<AnimeSearchResult | null> {
        try {
            const response = await jikanRequest("/anime", {
                q: title,
                limit: 10,
                sfw: true,
            });

            if (!response.data || response.data.length === 0) {
                logApiCall("Jikan", "/anime", { q: title }, "DETAIL", "0 results");
                return null;
            }

            const results = response.data;

            // Filter spin-offs first
            const spinoffPatterns = /chibi|theatre|theater|special|tebie|caidan|petit|mini/i;
            const mainResults = results.filter((a: any) => !spinoffPatterns.test(a.title || ""));
            const candidates = mainResults.length > 0 ? mainResults : results;

            // Score each candidate by title similarity
            const scoredCandidates = candidates.map((anime: any) => {
                let score = calculateTitleScore(title, anime.title || "", anime.title_english);

                // 2FA: Check synonyms for season match when expectedSeason is provided
                if (expectedSeason && expectedSeason > 1) {
                    const synonymSeason = extractSeasonFromTitles(anime.titles || []);
                    if (synonymSeason === expectedSeason) {
                        score += 2000;
                        logApiCall("Jikan", "/anime", { q: title }, "DETAIL", `Synonym match: "${anime.title}" has season ${synonymSeason} in titles`);
                    }
                }

                return { anime, score };
            });

            // Sort by score (descending), then prefer TV/ONA types
            scoredCandidates.sort((a: any, b: any) => {
                if (b.score !== a.score) return b.score - a.score;
                const aIsTV = a.anime.type === "TV" || a.anime.type === "ONA";
                const bIsTV = b.anime.type === "TV" || b.anime.type === "ONA";
                if (bIsTV && !aIsTV) return 1;
                if (aIsTV && !bIsTV) return -1;
                return 0;
            });

            const selected = scoredCandidates[0].anime;
            const selectedScore = scoredCandidates[0].score;
            logApiCall("Jikan", "/anime", { q: title }, "DETAIL", `"${selected.title}" (MAL:${selected.mal_id}) [score:${selectedScore}]`);
            return this.mapSearchResult(selected);
        } catch (e) {
            console.error(`[Jikan] Search error: ${formatCompactJikanError(e)}`);
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
                mal_id: anime.mal_id,
                title_english: anime.title_english,
                title_romaji: anime.title,
                cover_url: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
                total_episodes: anime.episodes || undefined,
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

    async getSequelInfo(animeId: number): Promise<SequelInfo | null> {
        try {
            const relations = await this.getRelations(animeId);
            const sequel = this.findSequel(relations);
            if (!sequel) return null;

            const sequelAnime = await this.getAnimeById(sequel.mal_id);
            if (!sequelAnime) return null;

            const isSplitCour = isPartOfSameSeason(sequelAnime.title_romaji) ||
                isPartOfSameSeason(sequelAnime.title_english || "");

            return {
                id: sequelAnime.id,
                mal_id: sequelAnime.mal_id,
                title_romaji: sequelAnime.title_romaji,
                title_english: sequelAnime.title_english,
                total_episodes: sequelAnime.total_episodes,
                is_split_cour: isSplitCour,
            };
        } catch {
            return null;
        }
    }

    private mapSearchResult(anime: any): AnimeSearchResult {
        return {
            id: anime.mal_id,
            title: anime.title,
            title_english: anime.title_english,
            type: anime.type,
            coverImage: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
            titles: anime.titles || [],
        };
    }
}
