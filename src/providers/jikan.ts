/**
 * Jikan API Provider - Fetches anime metadata from MyAnimeList
 */

import axios from "axios";
import { config } from "../core/config";
import type { AnimeInfo, AnimeProvider, AnimeSearchResult, EpisodeLookupContext, SequelInfo } from "./types";
import { formatProviderErrorDetails, logApiCall, markSeasonAnimeValidated } from "./types";

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
    },
};

/**
 * Make a request to Jikan API (jikan-edge) with rate limiting
 */
type JikanEpisodeData = {
    malId?: unknown;
    mal_id?: unknown;
    episode?: unknown;
    number?: unknown;
    title?: unknown;
    titleAlternative?: unknown;
    titleJapanese?: unknown;
    title_romanji?: unknown;
    title_romaji?: unknown;
};

type JikanImages = {
    small?: string | null;
    medium?: string | null;
    large?: string | null;
    jpg?: {
        large_image_url?: string | null;
        image_url?: string | null;
    };
};

type JikanAnimeData = {
    malId?: number;
    mal_id?: number;
    url?: string | null;
    title?: string;
    titleEnglish?: string | null;
    title_english?: string | null;
    titleJapanese?: string | null;
    titleSynonyms?: string[];
    type?: string | null;
    episodes?: number | null;
    imageUrl?: string | null;
    images?: JikanImages;
    titles?: Array<{ type: string; title: string }>;
    relations?: JikanRelationData[];
};

type JikanRelationEntry = {
    malId?: number;
    mal_id?: number;
    type: string;
    title?: string;
};

type JikanRelationData = {
    relation?: string;
    malId?: number;
    mal_id?: number;
    type?: string;
    title?: string;
    entry?: JikanRelationEntry[];
};

type JikanPagination = {
    page: number;
    limit: number;
    count: number;
    total: number | null;
    hasNextPage: boolean;
};

type JikanMeta = {
    cached?: boolean;
    stale?: boolean;
    refreshFailed?: boolean;
    fetchedAt?: string;
    pagination?: JikanPagination;
};

type JikanResponse<T> = {
    data?: T;
    meta?: JikanMeta;
};

function readJikanMalId(entity: { malId?: unknown; mal_id?: unknown }): number | null {
    const candidate = entity.malId ?? entity.mal_id;
    return typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0 ? candidate : null;
}

function readJikanCoverUrl(anime: JikanAnimeData): string | null {
    return (
        anime.images?.large ||
        anime.images?.medium ||
        anime.imageUrl ||
        anime.images?.small ||
        anime.images?.jpg?.large_image_url ||
        anime.images?.jpg?.image_url ||
        null
    );
}

function buildJikanTitles(anime: JikanAnimeData): Array<{ type: string; title: string }> {
    const entries: Array<{ type: string; title: string }> = [];
    const seen = new Set<string>();

    const addTitle = (type: string, value: string | null | undefined) => {
        if (!value || typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed) return;
        const key = `${type}:${trimmed.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ type, title: trimmed });
    };

    if (Array.isArray(anime.titles)) {
        for (const item of anime.titles) {
            if (item && typeof item.type === "string" && typeof item.title === "string") {
                addTitle(item.type, item.title);
            }
        }
    }

    addTitle("Default", anime.title);
    addTitle("English", anime.titleEnglish ?? anime.title_english);
    addTitle("Japanese", anime.titleJapanese);

    if (Array.isArray(anime.titleSynonyms)) {
        for (const synonym of anime.titleSynonyms) {
            addTitle("Synonym", synonym);
        }
    }

    return entries;
}

function readJikanEpisodeNumber(episodeData: JikanEpisodeData): number | null {
    const candidate = episodeData.number ?? episodeData.episode ?? episodeData.mal_id;
    return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : null;
}

function readJikanEpisodeTitle(episodeData: JikanEpisodeData): string | null {
    const candidate =
        episodeData.title ??
        episodeData.titleAlternative ??
        episodeData.titleJapanese ??
        episodeData.title_romanji ??
        episodeData.title_romaji;
    return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function parseRetryAfterMs(headers: Record<string, unknown> | undefined): number {
    if (!headers) return 1000;
    const rawHeader = headers["retry-after"] ?? headers["Retry-After"];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof headerValue === "number" && Number.isFinite(headerValue) && headerValue > 0) {
        return Math.ceil(headerValue * 1000);
    }
    if (typeof headerValue === "string") {
        const seconds = Number(headerValue.trim());
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.ceil(seconds * 1000);
        }
        const retryDateMs = Date.parse(headerValue);
        if (!Number.isNaN(retryDateMs)) {
            const deltaMs = retryDateMs - Date.now();
            if (deltaMs > 0) {
                return deltaMs;
            }
        }
    }
    return 1000;
}

async function jikanRequest<T = unknown>(
    endpoint: string,
    params?: Record<string, unknown>,
    retryCount = 0,
): Promise<JikanResponse<T>> {
    if (circuitBreaker.isOpen()) {
        logApiCall("Jikan", endpoint, params, "CIRCUIT_OPEN", "blocked");
        throw new Error(`Circuit breaker open`);
    }

    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < config.jikan.minRequestInterval) {
        await new Promise((resolve) => setTimeout(resolve, config.jikan.minRequestInterval - elapsed));
    }
    lastRequestTime = Date.now();

    try {
        const response = await axios.get<JikanResponse<T>>(`${config.jikan.baseUrl}${endpoint}`, {
            params,
            timeout: 15000,
        });
        circuitBreaker.recordSuccess();
        logApiCall("Jikan", endpoint, params, `${response.status} OK`, "");
        return response.data;
    } catch (e: unknown) {
        const error = e as {
            code?: unknown;
            message?: unknown;
            response?: {
                status?: unknown;
                headers?: Record<string, unknown>;
                data?: {
                    error?: {
                        code?: unknown;
                        message?: unknown;
                        requestId?: unknown;
                    };
                };
            };
        };
        if (error.response?.status === 429) {
            const retryDelayMs = parseRetryAfterMs(error.response.headers);
            const retrySeconds = Math.max(1, Math.round(retryDelayMs / 1000));
            logApiCall("Jikan", endpoint, params, "429 RATE_LIMITED", `retrying in ${retrySeconds}s`);
            console.log(`[Jikan] Rate limited, waiting ${retrySeconds}s...`);
            circuitBreaker.recordFailure();
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            return jikanRequest(endpoint, params, retryCount);
        }

        if ((error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") && retryCount < 3) {
            logApiCall("Jikan", endpoint, params, "TIMEOUT", `retrying... (attempt ${retryCount + 2}/4)`);
            await new Promise((resolve) => setTimeout(resolve, 1000 * (retryCount + 1))); // Exponential backoff
            return jikanRequest(endpoint, params, retryCount + 1);
        }

        const apiErrorMessage = error.response?.data?.error?.message;
        const errorMessage =
            typeof error.message === "string"
                ? error.message
                : typeof apiErrorMessage === "string"
                  ? apiErrorMessage
                  : "unknown";
        logApiCall("Jikan", endpoint, params, "ERROR", errorMessage);
        if (config.debug) {
            logApiCall("Jikan", endpoint, params, "ERROR_DETAIL", formatProviderErrorDetails("Jikan", endpoint, e));
        }
        circuitBreaker.recordFailure();
        throw e;
    }
}

function extractSeasonNumber(title: string): number | null {
    const patterns = [/(?:season|s)\s*(\d+)/i, /(\d+)(?:st|nd|rd|th)\s*season/i];
    for (const pattern of patterns) {
        const match = title.match(pattern);
        if (match) return parseInt(match[1], 10);
    }
    const romanMap: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
    const romanMatch = title.match(/\b(II|III|IV|V|VI)(?:\s+(?:part|cour)\s*\d+)?$/i);
    if (romanMatch) {
        return romanMap[romanMatch[1].toLowerCase()] ?? null;
    }
    return null;
}

function isPartOfSameSeason(title: string): boolean {
    const partPatterns = [/\bpart\s*\d+\b(?!\s*:)/i, /\bcour\s*\d+\b(?!\s*:)/i];
    return partPatterns.some((p) => p.test(title));
}

function isSameSeasonContinuation(
    currentTitle: string | null | undefined,
    previousTitle: string | null | undefined,
    currentSeason: number,
): boolean {
    if (!currentTitle) return false;
    if (isPartOfSameSeason(currentTitle)) return true;

    const seasonInTitle = extractSeasonNumber(currentTitle);
    if (seasonInTitle !== null && seasonInTitle > 1 && seasonInTitle <= currentSeason) {
        return true;
    }

    if (previousTitle) {
        const currentPartPrefix = currentTitle.match(/\bpart\s*(\d+)\s*:/i)?.[1];
        const previousPartPrefix = previousTitle.match(/\bpart\s*(\d+)\s*:/i)?.[1];
        if (currentPartPrefix && previousPartPrefix && currentPartPrefix === previousPartPrefix) {
            return true;
        }

        const colonIndex = previousTitle.indexOf(":");
        if (colonIndex > 0) {
            const prevSubtitledBase = previousTitle
                .replace(/\s+(?:part|cour)\s*\d+.*$/i, "")
                .trim()
                .toLowerCase();
            const prevSubtitle = prevSubtitledBase.slice(colonIndex + 1).trim();
            const currNormalized = currentTitle.trim().toLowerCase();
            if (
                prevSubtitle.length >= 4 &&
                !/^(?:season\s*\d+|\d+(?:st|nd|rd|th)\s*season)$/i.test(prevSubtitle) &&
                currNormalized.length > prevSubtitledBase.length &&
                currNormalized.startsWith(prevSubtitledBase) &&
                /^[\s\-:]/i.test(currNormalized.slice(prevSubtitledBase.length))
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Extract season number from Jikan titles array (synonyms, etc.)
 * Handles patterns like "4th Season", "Season 4", etc.
 * Note: "Part X" and "Cour X" are sub-season divisions, not season indicators —
 * they are handled separately by isPartOfSameSeason().
 */
function extractSeasonFromTitles(titles: any[]): number | null {
    if (!titles || !Array.isArray(titles)) return null;

    const seasonPatterns = [/(\d+)(?:st|nd|rd|th)\s*season/i, /season\s*(\d+)/i];
    const romanMap: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

    for (const entry of titles) {
        const title = entry?.title || entry;
        if (typeof title !== "string") continue;

        for (const pattern of seasonPatterns) {
            const match = title.match(pattern);
            if (match) return parseInt(match[1], 10);
        }

        const romanMatch = title.match(/\b(II|III|IV|V|VI)(?:\s+(?:part|cour)\s*\d+)?$/i);
        if (romanMatch) {
            return romanMap[romanMatch[1].toLowerCase()] ?? null;
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
        .replace(/[/\-_.:]+/g, " ") // Replace special chars with space
        .replace(/\s+/g, " ") // Collapse multiple spaces
        .trim();
}

/**
 * Calculate Levenshtein distance between two strings.
 * Returns the minimum number of single-character edits required to change one into the other.
 */
export function levenshteinDistance(a: string, b: string): number {
    const aLen = a.length;
    const bLen = b.length;

    // Early termination for empty strings
    if (aLen === 0) return bLen;
    if (bLen === 0) return aLen;

    // Use two rows for O(n) memory
    let prevRow = new Array(bLen + 1);
    let currRow = new Array(bLen + 1);

    for (let j = 0; j <= bLen; j++) {
        prevRow[j] = j;
    }

    for (let i = 1; i <= aLen; i++) {
        currRow[0] = i;
        for (let j = 1; j <= bLen; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            currRow[j] = Math.min(
                prevRow[j] + 1, // deletion
                currRow[j - 1] + 1, // insertion
                prevRow[j - 1] + cost, // substitution
            );
        }
        [prevRow, currRow] = [currRow, prevRow];
    }

    return prevRow[bLen];
}

/**
 * Calculate a similarity score between search query and anime title
 * Higher score = better match
 */
export function calculateTitleScore(
    query: string,
    animeTitle: string,
    englishTitle: string | null,
    titles?: Array<{ type: string; title: string }>,
): number {
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
    const queryWords = normalizedQuery.split(" ").filter((w) => w.length > 1);
    const titleWords = `${normalizedRomaji} ${normalizedEnglish}`;
    const titleTokenSet = new Set(titleWords.split(" ").filter(Boolean));
    const matchedWords = queryWords.filter((w) => (w.length <= 2 ? titleTokenSet.has(w) : titleWords.includes(w)));
    if (matchedWords.length === queryWords.length) {
        score += 300 + matchedWords.length * 50;
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

    // Levenshtein fuzzy fallback: boost candidates that are close typo-wise
    // but would otherwise score low due to minor spelling differences
    const maxLen = Math.max(normalizedQuery.length, normalizedRomaji.length, normalizedEnglish.length || 1);
    const romajiDist = levenshteinDistance(normalizedQuery, normalizedRomaji);
    const englishDist = normalizedEnglish ? levenshteinDistance(normalizedQuery, normalizedEnglish) : Infinity;
    const bestDist = Math.min(romajiDist, englishDist);
    const similarity = 1 - bestDist / maxLen;

    // Boost only if the candidate is reasonably close but didn't match via other methods
    if (similarity >= 0.7 && score < 200) {
        const fuzzyBoost = Math.round(similarity * 200);
        score += fuzzyBoost;
    }

    // Score against alternative titles (synonyms, Japanese, etc.) at 50% weight
    if (titles && titles.length > 0) {
        const alternativeScore = computeAlternativeTitleScore(normalizedQuery, titles);
        if (alternativeScore > 0 && alternativeScore > score) {
            score = alternativeScore + 50; // Bonus for matching an alternative title
        }
    }

    return score;
}

/**
 * Score the query against alternative titles (excluding "Default" and "English")
 * at 50% weight, returning the best alternative score (or 0 if none).
 */
export function computeAlternativeTitleScore(
    normalizedQuery: string,
    titles: Array<{ type: string; title: string }>,
): number {
    let bestScore = 0;

    for (const entry of titles) {
        // Skip "Default" (same as animeTitle) and "English" (same as englishTitle)
        if (entry.type === "Default" || entry.type === "English") continue;
        if (!entry.title || typeof entry.title !== "string") continue;

        const normalizedAlt = normalizeForComparison(entry.title);
        if (!normalizedAlt) continue;

        let altScore = 0;

        // Exact match
        if (normalizedAlt === normalizedQuery) {
            altScore += 1000;
        }

        // Starts with query
        if (normalizedAlt.startsWith(normalizedQuery)) {
            altScore += 500;
        }

        // Contains all words from query
        const queryWords = normalizedQuery.split(" ").filter((w) => w.length > 1);
        const matchedWords = queryWords.filter((w) => normalizedAlt.includes(w));
        if (matchedWords.length === queryWords.length) {
            altScore += 300 + matchedWords.length * 50;
        } else {
            altScore += matchedWords.length * 30;
        }

        // Contains query as substring
        if (normalizedAlt.includes(normalizedQuery)) {
            altScore += 200;
        }

        // Apply 50% weight for alternative titles
        altScore = Math.round(altScore * 0.5);

        if (altScore > bestScore) {
            bestScore = altScore;
        }
    }

    return bestScore;
}

function formatCompactJikanError(error: unknown): string {
    const err = (error ?? {}) as {
        message?: unknown;
        code?: unknown;
        response?: {
            status?: unknown;
            data?: {
                error?: {
                    code?: unknown;
                    message?: unknown;
                };
            };
        };
    };

    const status = typeof err.response?.status === "number" ? err.response.status : null;
    const apiError = err.response?.data?.error;
    const code = typeof err.code === "string" ? err.code : typeof apiError?.code === "string" ? apiError.code : null;
    const message =
        typeof apiError?.message === "string" && apiError.message.trim().length > 0
            ? apiError.message
            : typeof err.message === "string"
              ? err.message
              : "unknown error";

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
            const response = await jikanRequest<JikanAnimeData[]>("/anime", {
                q: title,
            });

            const results = Array.isArray(response.data) ? response.data : [];
            if (results.length === 0) {
                logApiCall("Jikan", "/anime", { q: title }, "DETAIL", "0 results");
                return null;
            }

            // Filter spin-offs first
            const spinoffPatterns = /chibi|theatre|theater|special|tebie|caidan|petit|mini/i;
            const mainResults = results.filter((anime) => !spinoffPatterns.test(anime.title || ""));
            const candidates = mainResults.length > 0 ? mainResults : results;
            const queryHasSeason = extractSeasonNumber(title) !== null || /\bfinal\s+season\b/i.test(title);

            // Score each candidate by title similarity
            const scoredCandidates = candidates.map((anime) => {
                const englishTitle = anime.titleEnglish ?? anime.title_english ?? null;
                const synthesizedTitles = buildJikanTitles(anime);
                let score = calculateTitleScore(title, anime.title || "", englishTitle, synthesizedTitles);
                let seasonValidation: AnimeSearchResult["seasonValidation"];
                const synonymSeason = extractSeasonFromTitles(synthesizedTitles);

                const isExplicitSequelSeason =
                    (synonymSeason !== null && synonymSeason > 1) ||
                    /\b(?:final\s+season|part\s+[2-9]|cour\s+[2-9])\b/i.test(anime.title || "");

                // 2FA: Check titles/synonyms for season match when expectedSeason is provided
                if (expectedSeason && expectedSeason > 1) {
                    if (synonymSeason === expectedSeason) {
                        score += 2000;
                        seasonValidation = { expectedSeason, method: "explicit-title" };
                        logApiCall(
                            "Jikan",
                            "/anime",
                            { q: title },
                            "DETAIL",
                            `Synonym match: "${anime.title}" has season ${synonymSeason} in titles`,
                        );
                    } else if ((synonymSeason && synonymSeason !== expectedSeason) || isExplicitSequelSeason) {
                        score -= 500;
                    }
                } else if (!queryHasSeason) {
                    // Penalize sequel seasons when searching for the base title (season 1)
                    if (isExplicitSequelSeason) {
                        score -= 500;
                    }
                }

                if (
                    !/\b(?:ova|movie|special)\b/i.test(title) &&
                    (anime.type === "OVA" || anime.type === "Movie" || anime.type === "Special")
                ) {
                    score -= 100;
                }

                return { anime, score, seasonValidation };
            });

            // Sort by score (descending), then prefer TV/ONA types
            scoredCandidates.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                const aIsTV = a.anime.type === "TV" || a.anime.type === "ONA";
                const bIsTV = b.anime.type === "TV" || b.anime.type === "ONA";
                if (bIsTV && !aIsTV) return 1;
                if (aIsTV && !bIsTV) return -1;
                return 0;
            });

            const selectedCandidate = scoredCandidates[0];
            const selected = selectedCandidate.anime;
            const selectedMalId = readJikanMalId(selected) ?? 0;
            const selectedScore = selectedCandidate.score;
            logApiCall(
                "Jikan",
                "/anime",
                { q: title },
                "DETAIL",
                `"${selected.title}" (MAL:${selectedMalId}) [score:${selectedScore}]`,
            );
            return {
                ...this.mapSearchResult(selected),
                seasonValidation: selectedCandidate.seasonValidation,
            };
        } catch (e) {
            console.error(`[Jikan] Search error: ${formatCompactJikanError(e)}`);
            return null;
        }
    }

    async getAnimeById(id: number): Promise<AnimeInfo | null> {
        try {
            const response = await jikanRequest<JikanAnimeData>(`/anime/${id}`);
            const anime = response.data;
            if (!anime) return null;

            const malId = readJikanMalId(anime) ?? id;
            const englishTitle = anime.titleEnglish ?? anime.title_english ?? null;

            logApiCall("Jikan", `/anime/${id}`, {}, "DETAIL", `"${englishTitle || anime.title}" (${anime.type})`);

            return {
                id: malId,
                mal_id: malId,
                title_english: englishTitle,
                title_romaji: anime.title || "",
                cover_url: readJikanCoverUrl(anime),
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
        _context?: EpisodeLookupContext,
    ): Promise<string | null> {
        const episodeEndpoint = `/anime/${animeId}/episodes/${episode}`;
        try {
            const response = await jikanRequest<JikanEpisodeData>(episodeEndpoint);
            if (response.data) {
                const title = readJikanEpisodeTitle(response.data);
                if (title) {
                    logApiCall("Jikan", episodeEndpoint, {}, "DETAIL", `"${title}"`);
                    return title;
                }
            }
        } catch {
            logApiCall("Jikan", episodeEndpoint, {}, "DETAIL", "falling back to episode list");
        }

        const listEndpoint = `/anime/${animeId}/episodes`;
        try {
            const targetPage = Math.max(1, Math.ceil(episode / 100));
            const listParams = targetPage > 1 ? { page: targetPage } : undefined;
            const response = await jikanRequest<JikanEpisodeData[]>(listEndpoint, listParams);
            let matchingEpisode = response.data?.find((entry) => readJikanEpisodeNumber(entry) === episode);

            if (!matchingEpisode && response.meta?.pagination?.hasNextPage) {
                const nextPage = (response.meta.pagination.page || targetPage) + 1;
                const nextResponse = await jikanRequest<JikanEpisodeData[]>(listEndpoint, { page: nextPage });
                matchingEpisode = nextResponse.data?.find((entry) => readJikanEpisodeNumber(entry) === episode);
            }

            if (!matchingEpisode) {
                logApiCall("Jikan", listEndpoint, listParams ?? {}, "DETAIL", `episode ${episode} not found in list`);
                return null;
            }

            const title = readJikanEpisodeTitle(matchingEpisode);
            if (title) {
                logApiCall("Jikan", listEndpoint, listParams ?? {}, "DETAIL", `episode ${episode}: "${title}"`);
                return title;
            }

            logApiCall("Jikan", listEndpoint, listParams ?? {}, "DETAIL", `episode ${episode} has no title in list`);
            return null;
        } catch {
            return null;
        }
    }

    async findSeasonAnime(baseId: number, targetSeason: number): Promise<AnimeInfo | null> {
        if (targetSeason <= 1) {
            const anime = await this.getAnimeById(baseId);
            return anime ? markSeasonAnimeValidated(anime, targetSeason, "base-season") : null;
        }

        const visited = new Set<number>();
        let currentId = baseId;
        let currentSeason = 1;
        let lastValidId = baseId;
        let previousAnime: AnimeInfo | null = null;

        while (currentSeason < targetSeason) {
            if (visited.has(currentId)) break;
            visited.add(currentId);

            const relations = await this.getRelations(currentId);
            const sequel = this.findSequel(relations);

            if (!sequel) break;

            const sequelAnime = await this.getAnimeById(sequel.malId);
            if (!sequelAnime) break;

            currentId = sequelAnime.id;
            lastValidId = currentId;

            const seasonInTitle =
                extractSeasonNumber(sequelAnime.title_romaji) || extractSeasonNumber(sequelAnime.title_english || "");
            const isPart =
                isSameSeasonContinuation(sequelAnime.title_romaji, previousAnime?.title_romaji, currentSeason) ||
                isSameSeasonContinuation(sequelAnime.title_english, previousAnime?.title_english, currentSeason);

            if (!isPart && seasonInTitle === targetSeason) {
                return markSeasonAnimeValidated(sequelAnime, targetSeason, "explicit-title");
            }

            // Check if this is a new season or just a "Part" / cour continuation
            if (!isPart) {
                currentSeason++;
            }
            previousAnime = sequelAnime;
        }

        if (currentSeason < targetSeason) {
            return null;
        }

        const anime = await this.getAnimeById(lastValidId);
        return anime ? markSeasonAnimeValidated(anime, targetSeason, "relation-chain") : null;
    }

    private async getRelations(malId: number): Promise<JikanRelationData[]> {
        try {
            const response = await jikanRequest<JikanRelationData[]>(`/anime/${malId}/relations`);
            return Array.isArray(response.data) ? response.data : [];
        } catch {
            return [];
        }
    }

    private findSequel(relations: JikanRelationData[]): { malId: number; type: string; title?: string } | null {
        const sequelEntries: Array<{ malId: number; type: string; title?: string }> = [];

        for (const relation of relations) {
            if (relation.relation !== "Sequel") continue;

            const flatId = readJikanMalId(relation);
            if (flatId !== null && typeof relation.type === "string") {
                sequelEntries.push({
                    malId: flatId,
                    type: relation.type,
                    title: relation.title,
                });
            }

            if (Array.isArray(relation.entry)) {
                for (const entry of relation.entry) {
                    const entryId = readJikanMalId(entry);
                    if (entryId !== null && typeof entry.type === "string") {
                        sequelEntries.push({
                            malId: entryId,
                            type: entry.type,
                            title: entry.title,
                        });
                    }
                }
            }
        }

        if (sequelEntries.length === 0) return null;

        // Prefer TV sequels
        const tvEntry = sequelEntries.find((entry) => entry.type === "TV");
        if (tvEntry) return tvEntry;

        // Prefer non-movie/special anime entries in jikan-edge flat relations
        const nonMovieAnimeEntry = sequelEntries.find(
            (entry) =>
                entry.type === "anime" && (!entry.title || !/\b(?:movie|ova|special|recap)\b/i.test(entry.title)),
        );
        if (nonMovieAnimeEntry) return nonMovieAnimeEntry;

        // Fallback to any anime
        const anyEntry = sequelEntries.find(
            (entry) => entry.type === "Movie" || entry.type === "OVA" || entry.type === "ONA" || entry.type === "anime",
        );
        return anyEntry ?? null;
    }

    async getSequelInfo(animeId: number): Promise<SequelInfo | null> {
        try {
            const relations = await this.getRelations(animeId);
            const sequel = this.findSequel(relations);
            if (!sequel) return null;

            const sequelAnime = await this.getAnimeById(sequel.malId);
            if (!sequelAnime) return null;

            const isSplitCour =
                isPartOfSameSeason(sequelAnime.title_romaji) || isPartOfSameSeason(sequelAnime.title_english || "");

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

    private mapSearchResult(anime: JikanAnimeData): AnimeSearchResult {
        return {
            id: readJikanMalId(anime) ?? 0,
            title: anime.title || "",
            title_english: anime.titleEnglish ?? anime.title_english ?? null,
            type: anime.type || "Unknown",
            coverImage: readJikanCoverUrl(anime),
            titles: buildJikanTitles(anime),
        };
    }
}
