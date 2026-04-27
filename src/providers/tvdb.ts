/**
 * TheTVDB API V4 Provider - Fetches series/anime metadata
 * API Docs: https://thetvdb.github.io/v4-api/
 *
 * Supports localized titles via language parameter.
 */

import axios from "axios";
import { formatProviderErrorDetails, logApiCall } from "./types";
import type { AnimeProvider, AnimeInfo, AnimeSearchResult, EpisodeLookupContext } from "./types";
import { config } from "../config";

const TVDB_BASE = "https://api4.thetvdb.com/v4";
const MAX_SEASON_LOOKUP_PAGES = 3;
const MIN_INFERENCE_SCORE = 40;
const TITLE_HINT_STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "arc",
    "cour",
    "episode",
    "of",
    "part",
    "season",
    "series",
    "the",
    "to",
]);

type TvdbSeasonType = "official" | "default";

interface TvdbEpisodeRecord {
    id?: number | string;
    name?: string | null;
    seasonNumber?: number | string;
    number?: number | string;
}

interface TvdbSeasonRecord {
    id?: number | string;
    name?: string | null;
    number?: number | string;
    seasonNumber?: number | string;
    type?: {
        name?: string | null;
        type?: string | null;
    } | string | null;
}

interface SeasonInferenceResult {
    season: number;
    score: number;
    reason: string;
}

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
        if (config.debug) {
            logApiCall("TVDB", "login", {}, "ERROR_DETAIL", formatProviderErrorDetails("TVDB", "login", e));
        }
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
        if (config.debug) {
            logApiCall("TVDB", operation, params || {}, "ERROR_DETAIL", formatProviderErrorDetails("TVDB", operation, e));
        }
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

function normalizeEpisodeNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? null : parsed;
    }

    return null;
}

function extractEpisodeList(response: any): TvdbEpisodeRecord[] {
    const episodes = response?.data?.episodes;
    return Array.isArray(episodes) ? episodes as TvdbEpisodeRecord[] : [];
}

function findExactEpisode(
    episodes: TvdbEpisodeRecord[],
    season: number,
    episode: number
): TvdbEpisodeRecord | null {
    const seasonNum = normalizeEpisodeNumber(season);
    const episodeNum = normalizeEpisodeNumber(episode);

    if (seasonNum === null || episodeNum === null) {
        return null;
    }

    return episodes.find((candidate) =>
        normalizeEpisodeNumber(candidate.seasonNumber) === seasonNum
        && normalizeEpisodeNumber(candidate.number) === episodeNum
    ) || null;
}

function normalizeTitleForComparison(value: string): string {
    return value
        .toLowerCase()
        .replace(/['`´’]+/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractMeaningfulTitleTokens(value: string): string[] {
    if (!value.trim()) {
        return [];
    }

    return normalizeTitleForComparison(value)
        .split(" ")
        .filter((token) => token.length >= 3 && !TITLE_HINT_STOP_WORDS.has(token));
}

function getSeasonTypeLabel(season: TvdbSeasonRecord): string {
    if (typeof season.type === "string") {
        return season.type;
    }

    if (typeof season.type?.type === "string") {
        return season.type.type;
    }

    if (typeof season.type?.name === "string") {
        return season.type.name;
    }

    return "";
}

function extractSeasonRecords(response: any): TvdbSeasonRecord[] {
    const directData = response?.data;
    if (Array.isArray(directData)) {
        return directData as TvdbSeasonRecord[];
    }

    if (Array.isArray(directData?.seasons)) {
        return directData.seasons as TvdbSeasonRecord[];
    }

    const wrappedData = response?.data?.data;
    if (Array.isArray(wrappedData)) {
        return wrappedData as TvdbSeasonRecord[];
    }

    if (Array.isArray(wrappedData?.seasons)) {
        return wrappedData.seasons as TvdbSeasonRecord[];
    }

    return [];
}

function getSeasonNumber(season: TvdbSeasonRecord): number | null {
    return normalizeEpisodeNumber(season.number) ?? normalizeEpisodeNumber(season.seasonNumber);
}

function buildSeasonInferenceInputs(context?: EpisodeLookupContext): {
    normalizedHints: string[];
    hintTokens: Set<string>;
} {
    const rawHints: Array<string | undefined> = [
        context?.searchTitle,
        ...(context?.canonicalTitles || []),
    ];

    const normalizedHints: string[] = [];
    const seenHints = new Set<string>();

    for (const rawHint of rawHints) {
        if (!rawHint) {
            continue;
        }

        const normalizedHint = normalizeTitleForComparison(rawHint);
        if (!normalizedHint || seenHints.has(normalizedHint)) {
            continue;
        }

        seenHints.add(normalizedHint);
        normalizedHints.push(normalizedHint);
    }

    const hintTokens = new Set<string>();
    for (const hint of normalizedHints) {
        for (const token of extractMeaningfulTitleTokens(hint)) {
            hintTokens.add(token);
        }
    }

    return { normalizedHints, hintTokens };
}

function computeSeasonHintScore(
    seasonName: string,
    normalizedHints: string[],
    hintTokens: Set<string>
): number {
    const normalizedSeasonName = normalizeTitleForComparison(seasonName);
    if (!normalizedSeasonName) {
        return 0;
    }

    let score = 0;

    for (const normalizedHint of normalizedHints) {
        if (normalizedSeasonName.length >= 4 && normalizedHint.includes(normalizedSeasonName)) {
            score += 120;
            break;
        }
    }

    const seasonTokens = extractMeaningfulTitleTokens(normalizedSeasonName);
    if (seasonTokens.length === 0) {
        return score;
    }

    let matchedTokenCount = 0;
    for (const token of seasonTokens) {
        if (!hintTokens.has(token)) {
            continue;
        }

        matchedTokenCount++;
        score += 25;
    }

    if (matchedTokenCount > 0 && matchedTokenCount === seasonTokens.length) {
        score += 40;
    }

    return score;
}

function logSeasonInferenceDebug(seriesId: number, message: string): void {
    if (!config.debug) {
        return;
    }

    console.log(`[TVDB] Season inference (series:${seriesId}) ${message}`);
}

async function inferSeasonFromTitleHints(
    seriesId: number,
    context?: EpisodeLookupContext
): Promise<SeasonInferenceResult | null> {
    if (!context?.allowSeasonInference) {
        logSeasonInferenceDebug(seriesId, "skip: disabled");
        return null;
    }

    const { normalizedHints, hintTokens } = buildSeasonInferenceInputs(context);
    if (normalizedHints.length === 0 || hintTokens.size === 0) {
        logSeasonInferenceDebug(seriesId, "skip: no title hints");
        return null;
    }

    try {
        const seasonsResponse = await tvdbRequest(
            `/series/${seriesId}/extended`,
            { meta: "episodes" },
            "getSeasons"
        );
        const allSeasonRecords = extractSeasonRecords(seasonsResponse);

        const candidateSeasons: TvdbSeasonRecord[] = [];
        for (const seasonRecord of allSeasonRecords) {
            const seasonNum = getSeasonNumber(seasonRecord);
            if (seasonNum === null || seasonNum <= 1) {
                continue;
            }

            const typeLabel = getSeasonTypeLabel(seasonRecord).toLowerCase();
            if (typeLabel && !typeLabel.includes("official") && !typeLabel.includes("default")) {
                continue;
            }

            candidateSeasons.push(seasonRecord);
        }

        if (candidateSeasons.length === 0) {
            logSeasonInferenceDebug(seriesId, "skip: no eligible season metadata");
            return null;
        }

        let best: SeasonInferenceResult | null = null;

        for (const seasonRecord of candidateSeasons) {
            const seasonNum = getSeasonNumber(seasonRecord);
            if (seasonNum === null) {
                continue;
            }

            const seasonName = typeof seasonRecord.name === "string" ? seasonRecord.name.trim() : "";
            if (!seasonName) {
                continue;
            }

            const score = computeSeasonHintScore(seasonName, normalizedHints, hintTokens);
            logSeasonInferenceDebug(seriesId, `candidate season=${seasonNum} name=\"${seasonName}\" score=${score}`);

            if (score < MIN_INFERENCE_SCORE) {
                continue;
            }

            if (!best || score > best.score || (score === best.score && seasonNum > best.season)) {
                best = {
                    season: seasonNum,
                    score,
                    reason: `title-hint match \"${seasonName}\"`,
                };
            }
        }

        if (!best) {
            logSeasonInferenceDebug(seriesId, "no season candidate reached threshold");
            return null;
        }

        logSeasonInferenceDebug(seriesId, `selected season=${best.season} score=${best.score} reason=${best.reason}`);
        return best;
    } catch {
        logSeasonInferenceDebug(seriesId, "failed: season metadata unavailable");
        return null;
    }
}

async function lookupEpisodeForSeasonNumber(
    seriesId: number,
    seasonNum: number,
    episode: number
): Promise<{ episode: TvdbEpisodeRecord; seasonType: TvdbSeasonType } | null> {
    for (const seasonType of ["official", "default"] as TvdbSeasonType[]) {
        try {
            logApiCall(
                "TVDB",
                "getEpisode",
                { id: seriesId, season: seasonNum, ep: episode },
                "DETAIL",
                `seasonType=${seasonType} exact`
            );

            const exactResponse = await tvdbRequest(
                `/series/${seriesId}/episodes/${seasonType}`,
                {
                    page: 0,
                    season: seasonNum,
                    episodeNumber: episode,
                },
                "getEpisode"
            );

            const exactEpisodes = extractEpisodeList(exactResponse);
            const exactMatch = findExactEpisode(exactEpisodes, seasonNum, episode);
            if (exactMatch) {
                logApiCall(
                    "TVDB",
                    "getEpisode",
                    { id: seriesId, season: seasonNum, ep: episode },
                    "DETAIL",
                    `seasonType=${seasonType} exact-match`
                );
                return {
                    episode: exactMatch,
                    seasonType,
                };
            }

            logApiCall(
                "TVDB",
                "getEpisode",
                { id: seriesId, season: seasonNum, ep: episode },
                "DETAIL",
                `seasonType=${seasonType} exact-miss -> paginated`
            );

            for (let page = 0; page < MAX_SEASON_LOOKUP_PAGES; page++) {
                const pageResponse = await tvdbRequest(
                    `/series/${seriesId}/episodes/${seasonType}`,
                    {
                        page,
                        season: seasonNum,
                    },
                    "getEpisode"
                );

                const pageEpisodes = extractEpisodeList(pageResponse);
                if (pageEpisodes.length === 0) {
                    break;
                }

                const pageMatch = findExactEpisode(pageEpisodes, seasonNum, episode);
                if (pageMatch) {
                    logApiCall(
                        "TVDB",
                        "getEpisode",
                        { id: seriesId, season: seasonNum, ep: episode },
                        "DETAIL",
                        `seasonType=${seasonType} paginated-match page=${page}`
                    );
                    return {
                        episode: pageMatch,
                        seasonType,
                    };
                }
            }

            if (seasonType === "official") {
                logApiCall(
                    "TVDB",
                    "getEpisode",
                    { id: seriesId, season: seasonNum, ep: episode },
                    "DETAIL",
                    "seasonType=official miss -> trying default"
                );
            }
        } catch {
            logApiCall(
                "TVDB",
                "getEpisode",
                { id: seriesId, season: seasonNum, ep: episode },
                "DETAIL",
                `seasonType=${seasonType} failed`
            );
        }
    }

    return null;
}

export class TvdbProvider implements AnimeProvider {
    readonly name = "tvdb";

    async searchAnime(title: string, _expectedSeason?: number): Promise<AnimeSearchResult | null> {
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

    async getEpisodeTitle(
        seriesId: number,
        episode: number,
        season?: number,
        context?: EpisodeLookupContext
    ): Promise<string | null> {
        try {
            const requestedSeason = season ?? 1;
            let resolvedSeason = requestedSeason;

            if (!season || season <= 1) {
                const inferredSeason = await inferSeasonFromTitleHints(seriesId, context);
                if (inferredSeason) {
                    resolvedSeason = inferredSeason.season;
                    logSeasonInferenceDebug(
                        seriesId,
                        `using inferred season=${resolvedSeason} for episode=${episode}`
                    );
                } else {
                    logSeasonInferenceDebug(
                        seriesId,
                        `using default season=${resolvedSeason} for episode=${episode}`
                    );
                }
            }

            const lookupResult = await lookupEpisodeForSeasonNumber(seriesId, resolvedSeason, episode);

            if (!lookupResult) {
                logApiCall(
                    "TVDB",
                    "getEpisode",
                    { id: seriesId, season: resolvedSeason, ep: episode },
                    "DETAIL",
                    "no exact season+episode match"
                );
                return null;
            }

            const selectedEpisode = lookupResult.episode;
            const selectedSeasonType = lookupResult.seasonType;

            let epTitle = selectedEpisode.name || null;
            const episodeId = normalizeEpisodeNumber(selectedEpisode.id);

            // Try to get localized episode title
            const lang = getTvdbLanguage();
            if (epTitle && lang !== "eng" && episodeId !== null) {
                try {
                    const transResponse = await tvdbRequest(
                        `/episodes/${episodeId}/translations/${lang}`,
                        { episodeId, lang },
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
                    { id: seriesId, season: resolvedSeason, ep: episode },
                    "DETAIL", `seasonType=${selectedSeasonType || "unknown"} "${epTitle}"`);
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
