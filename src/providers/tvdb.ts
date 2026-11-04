/**
 * TheTVDB API V4 Provider - Fetches series/anime metadata
 * API Docs: https://thetvdb.github.io/v4-api/
 *
 * Supports localized titles via language parameter.
 */

import axios from "axios";
import { config } from "../core/config";
import type { AnimeInfo, AnimeProvider, AnimeSearchResult, EpisodeLookupContext, SequelInfo } from "./types";
import { formatProviderErrorDetails, logApiCall, markSeasonAnimeValidated } from "./types";

const TVDB_BASE = "https://api4.thetvdb.com/v4";
const MAX_SEASON_LOOKUP_PAGES = 3;
const MAX_ORDER_MAPPING_PAGES = 20;
const MIN_INFERENCE_SCORE = 40;
export const TVDB_ARTWORK_TYPE_SERIES_POSTER = 2;
export const TVDB_ARTWORK_TYPE_SEASON_POSTER = 7;
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
type TvdbEpisodeOrderType = TvdbSeasonType | "absolute";

interface TvdbEpisodeRecord {
    id?: number | string;
    name?: string | null;
    seasonNumber?: number | string;
    number?: number | string;
    absoluteNumber?: number | string | null;
    nameTranslations?: unknown;
    overviewTranslations?: unknown;
    translationLanguages?: unknown;
    translations?: unknown;
}

interface TvdbRequestOptions {
    expectedMissingStatuses?: number[];
}

interface EpisodeTranslationLanguagePlan {
    canonicalLanguage: string;
    candidates: string[];
    availableLanguages: string[];
}

export interface TvdbArtworkRecord {
    id?: number | string;
    image?: string | null;
    thumbnail?: string | null;
    language?: string | null;
    score?: number | string | null;
    seasonId?: number | string | null;
    type?: number | string | null;
}

export interface TvdbAiredToAbsoluteMapping {
    seriesId: number;
    season: number;
    episode: number;
    absoluteEpisode: number;
    seasonType: TvdbSeasonType;
    episodeId: number | null;
}

interface TvdbSeasonRecord {
    id?: number | string;
    name?: string | null;
    number?: number | string;
    seasonNumber?: number | string;
    type?:
        | {
              name?: string | null;
              type?: string | null;
          }
        | string
        | null;
}

interface TvdbSeriesRecord {
    name?: string | null;
    image?: string | null;
    artworks?: TvdbArtworkRecord[];
    nameTranslations?: unknown;
    seasons?: TvdbSeasonRecord[];
    status?: {
        name?: string | null;
    } | null;
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

const episodeOrderCache = new Map<string, Promise<TvdbEpisodeRecord[]>>();
const airedToAbsoluteCache = new Map<string, { expiresAt: number; result: TvdbAiredToAbsoluteMapping | null }>();
const ORDER_MAPPING_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const ORDER_MAPPING_FAILURE_TTL_MS = 10 * 60 * 1000;
const loggedLanguageNormalizations = new Set<string>();

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
        const response = await axios.post(
            `${TVDB_BASE}/login`,
            {
                apikey: apiKey,
            },
            {
                headers: { "Content-Type": "application/json" },
                timeout: 10000,
            },
        );

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
async function tvdbRequest(
    endpoint: string,
    params?: Record<string, any>,
    operation = "query",
    options: TvdbRequestOptions = {},
): Promise<any> {
    if (circuitBreaker.isOpen()) {
        logApiCall("TVDB", operation, params || {}, "CIRCUIT_OPEN", "blocked");
        throw new Error("Circuit breaker open");
    }

    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();

    try {
        const token = await authenticate();

        const response = await axios.get(`${TVDB_BASE}${endpoint}`, {
            params,
            headers: {
                Authorization: `Bearer ${token}`,
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
            return tvdbRequest(endpoint, params, operation, options);
        }

        if (e.response?.status === 429) {
            logApiCall("TVDB", operation, params || {}, "429 RATE_LIMITED", "retrying in 2s");
            console.log("[TVDB] Rate limited, waiting 2s...");
            circuitBreaker.recordFailure();
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return tvdbRequest(endpoint, params, operation, options);
        }

        const responseStatus = typeof e.response?.status === "number" ? e.response.status : null;
        if (responseStatus !== null && options.expectedMissingStatuses?.includes(responseStatus)) {
            throw e;
        }

        logApiCall("TVDB", operation, params || {}, "ERROR", e.message || "unknown");
        if (config.debug) {
            logApiCall(
                "TVDB",
                operation,
                params || {},
                "ERROR_DETAIL",
                formatProviderErrorDetails("TVDB", operation, e),
            );
        }
        circuitBreaker.recordFailure();
        throw e;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((item): item is string => typeof item === "string");
}

function normalizeRawTvdbLanguageCode(rawLanguage: string | null | undefined): string {
    const normalizedInput = (rawLanguage || "eng").trim().toLowerCase().replace(/_/g, "-");
    if (!normalizedInput) {
        return "eng";
    }

    const mappedLanguages: Record<string, string> = {
        en: "eng",
        pt: "por",
        "pt-br": "por",
        ptbr: "por",
        ja: "jpn",
        jp: "jpn",
        es: "spa",
        fr: "fra",
        de: "deu",
        it: "ita",
        ru: "rus",
        zh: "zho",
        cn: "zho",
        ko: "kor",
        kr: "kor",
    };

    if (mappedLanguages[normalizedInput]) {
        return mappedLanguages[normalizedInput];
    }

    if (/^[a-z]{3}$/.test(normalizedInput)) {
        return normalizedInput;
    }

    return normalizedInput;
}

export function normalizeTvdbLanguageCode(rawLanguage: string | null | undefined): string {
    return normalizeRawTvdbLanguageCode(rawLanguage);
}

/**
 * Get the configured TVDB language code.
 * Uses TVDB_LANG from config and normalizes common ISO-639-1 values to TVDB's ISO-639-2 codes.
 */
function getTvdbLanguage(): string {
    const rawLanguage = config.tvdb.language || "eng";
    const normalizedLanguage = normalizeRawTvdbLanguageCode(rawLanguage);
    const normalizedInput = rawLanguage.trim().toLowerCase().replace(/_/g, "-") || "eng";

    if (normalizedInput !== normalizedLanguage && !loggedLanguageNormalizations.has(rawLanguage)) {
        loggedLanguageNormalizations.add(rawLanguage);
        logApiCall(
            "TVDB",
            "language",
            { raw: rawLanguage },
            "DETAIL",
            `normalized "${rawLanguage}" -> "${normalizedLanguage}"`,
        );
    }

    return normalizedLanguage;
}

function appendUniqueLanguageCandidate(candidates: string[], candidate: string | null | undefined): void {
    const cleanedCandidate = readString(candidate);
    if (!cleanedCandidate) {
        return;
    }

    const normalizedCandidate = cleanedCandidate.toLowerCase();
    if (candidates.some((existingCandidate) => existingCandidate.toLowerCase() === normalizedCandidate)) {
        return;
    }

    candidates.push(cleanedCandidate);
}

function readTranslationLanguageCode(value: unknown): string | null {
    if (typeof value === "string") {
        return readString(value);
    }

    if (!isRecord(value)) {
        return null;
    }

    return (
        readString(value.language) ??
        readString(value.lang) ??
        readString(value.code) ??
        readString(value.id) ??
        readString(value.iso_639_3) ??
        readString(value.iso6393) ??
        readString(value.iso_639_1) ??
        readString(value.iso6391)
    );
}

function isLikelyTvdbLanguageCode(value: string): boolean {
    return /^[a-z]{2,3}(?:-[a-z]{2,3})?$/i.test(value.trim());
}

function collectTranslationLanguages(value: unknown, languages: string[]): void {
    const languageCode = readTranslationLanguageCode(value);
    if (languageCode) {
        appendUniqueLanguageCandidate(languages, languageCode);
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectTranslationLanguages(item, languages);
        }
        return;
    }

    if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (isLikelyTvdbLanguageCode(key)) {
                appendUniqueLanguageCandidate(languages, key);
            }
            collectTranslationLanguages(item, languages);
        }
    }
}

function readEpisodeAvailableTranslationLanguages(episode: TvdbEpisodeRecord): string[] {
    const languages: string[] = [];

    collectTranslationLanguages(episode.nameTranslations, languages);
    collectTranslationLanguages(episode.overviewTranslations, languages);
    collectTranslationLanguages(episode.translationLanguages, languages);
    collectTranslationLanguages(episode.translations, languages);

    return languages;
}

function isPortugueseTvdbLanguage(rawLanguage: string, canonicalLanguage: string): boolean {
    const normalizedRawLanguage = rawLanguage.trim().toLowerCase().replace(/_/g, "-");
    return canonicalLanguage === "por" || normalizedRawLanguage === "pt" || normalizedRawLanguage.startsWith("pt-");
}

function isPortugueseTranslationCandidate(language: string): boolean {
    const normalizedLanguage = language.trim().toLowerCase().replace(/_/g, "-");
    return (
        normalizedLanguage === "por" ||
        normalizedLanguage === "pt" ||
        normalizedLanguage === "ptbr" ||
        normalizedLanguage.startsWith("pt-")
    );
}

function buildEpisodeTranslationLanguagePlan(
    rawLanguage: string,
    canonicalLanguage: string,
    episode: TvdbEpisodeRecord,
): EpisodeTranslationLanguagePlan {
    const availableLanguages = readEpisodeAvailableTranslationLanguages(episode);
    const candidates: string[] = [];

    appendUniqueLanguageCandidate(candidates, canonicalLanguage);

    if (!isPortugueseTvdbLanguage(rawLanguage, canonicalLanguage)) {
        return {
            canonicalLanguage,
            candidates,
            availableLanguages,
        };
    }

    appendUniqueLanguageCandidate(candidates, "pt");
    appendUniqueLanguageCandidate(candidates, "pt-BR");

    for (const availableLanguage of availableLanguages) {
        if (isPortugueseTranslationCandidate(availableLanguage)) {
            appendUniqueLanguageCandidate(candidates, availableLanguage);
        }
    }

    return {
        canonicalLanguage,
        candidates,
        availableLanguages,
    };
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
    return Array.isArray(episodes) ? (episodes as TvdbEpisodeRecord[]) : [];
}

function readNextPage(response: any): number | null {
    const nextPage = response?.data?.links?.next ?? response?.links?.next;
    const normalizedNextPage = normalizeEpisodeNumber(nextPage);

    return normalizedNextPage !== null && normalizedNextPage >= 0 ? normalizedNextPage : null;
}

function getEpisodeRecordId(episode: TvdbEpisodeRecord): number | null {
    return normalizeEpisodeNumber(episode.id);
}

function getAbsoluteEpisodeNumber(episode: TvdbEpisodeRecord): number | null {
    const absoluteNumber = normalizeEpisodeNumber(episode.absoluteNumber);
    if (absoluteNumber !== null && absoluteNumber > 0) {
        return absoluteNumber;
    }

    return null;
}

function findExactEpisode(episodes: TvdbEpisodeRecord[], season: number, episode: number): TvdbEpisodeRecord | null {
    const seasonNum = normalizeEpisodeNumber(season);
    const episodeNum = normalizeEpisodeNumber(episode);

    if (seasonNum === null || episodeNum === null) {
        return null;
    }

    return (
        episodes.find(
            (candidate) =>
                normalizeEpisodeNumber(candidate.seasonNumber) === seasonNum &&
                normalizeEpisodeNumber(candidate.number) === episodeNum,
        ) || null
    );
}

function findEpisodeByAbsoluteNumber(episodes: TvdbEpisodeRecord[], absoluteEpisode: number): TvdbEpisodeRecord | null {
    const absoluteEpisodeNumber = normalizeEpisodeNumber(absoluteEpisode);
    if (absoluteEpisodeNumber === null || absoluteEpisodeNumber < 1) {
        return null;
    }

    return (
        episodes.find((candidate) => {
            const absoluteNumber = getAbsoluteEpisodeNumber(candidate);
            const episodeNumber = normalizeEpisodeNumber(candidate.number);

            return absoluteNumber === absoluteEpisodeNumber || episodeNumber === absoluteEpisodeNumber;
        }) || null
    );
}

async function fetchEpisodeOrder(seriesId: number, seasonType: TvdbEpisodeOrderType): Promise<TvdbEpisodeRecord[]> {
    const cacheKey = `${seriesId}:${seasonType}`;
    const cachedOrder = episodeOrderCache.get(cacheKey);
    if (cachedOrder) {
        return cachedOrder;
    }

    const orderPromise = fetchEpisodeOrderPages(seriesId, seasonType);
    episodeOrderCache.set(cacheKey, orderPromise);
    return orderPromise;
}

async function fetchEpisodeOrderPages(
    seriesId: number,
    seasonType: TvdbEpisodeOrderType,
): Promise<TvdbEpisodeRecord[]> {
    const episodes: TvdbEpisodeRecord[] = [];
    let page = 0;

    for (let pageCount = 0; pageCount < MAX_ORDER_MAPPING_PAGES; pageCount++) {
        const pageResponse = await tvdbRequest(
            `/series/${seriesId}/episodes/${seasonType}`,
            { page },
            "getEpisodeOrder",
        );
        const pageEpisodes = extractEpisodeList(pageResponse);
        if (pageEpisodes.length === 0) {
            break;
        }

        episodes.push(...pageEpisodes);

        const nextPage = readNextPage(pageResponse);
        if (nextPage === null || nextPage === page) {
            break;
        }

        page = nextPage;
    }

    return episodes;
}

function findAbsoluteNumberByEpisodeId(
    absoluteEpisodes: TvdbEpisodeRecord[],
    airedEpisode: TvdbEpisodeRecord,
): number | null {
    const airedEpisodeId = getEpisodeRecordId(airedEpisode);
    if (airedEpisodeId === null) {
        return null;
    }

    const absoluteEpisode = absoluteEpisodes.find((candidate) => getEpisodeRecordId(candidate) === airedEpisodeId);
    if (!absoluteEpisode) {
        return null;
    }

    return getAbsoluteEpisodeNumber(absoluteEpisode) ?? normalizeEpisodeNumber(absoluteEpisode.number);
}

function buildAiredToAbsoluteMapping(
    seriesId: number,
    season: number,
    episode: number,
    seasonType: TvdbSeasonType,
    airedEpisodes: TvdbEpisodeRecord[],
    absoluteEpisodes: TvdbEpisodeRecord[],
): TvdbAiredToAbsoluteMapping | null {
    const airedEpisode = findExactEpisode(airedEpisodes, season, episode);
    if (!airedEpisode) {
        return null;
    }

    const absoluteEpisode =
        getAbsoluteEpisodeNumber(airedEpisode) ?? findAbsoluteNumberByEpisodeId(absoluteEpisodes, airedEpisode);
    if (absoluteEpisode === null || absoluteEpisode < 1) {
        return null;
    }

    return {
        seriesId,
        season,
        episode,
        absoluteEpisode,
        seasonType,
        episodeId: getEpisodeRecordId(airedEpisode),
    };
}

function getCachedAiredToAbsoluteMapping(cacheKey: string): TvdbAiredToAbsoluteMapping | null | undefined {
    const cachedMapping = airedToAbsoluteCache.get(cacheKey);
    if (!cachedMapping) {
        return undefined;
    }

    if (Date.now() >= cachedMapping.expiresAt) {
        airedToAbsoluteCache.delete(cacheKey);
        return undefined;
    }

    return cachedMapping.result;
}

function cacheAiredToAbsoluteMapping(cacheKey: string, result: TvdbAiredToAbsoluteMapping | null): void {
    airedToAbsoluteCache.set(cacheKey, {
        expiresAt: Date.now() + (result ? ORDER_MAPPING_SUCCESS_TTL_MS : ORDER_MAPPING_FAILURE_TTL_MS),
        result,
    });
}

export async function mapTvdbAiredEpisodeToAbsolute(
    seriesId: number | null | undefined,
    season: number | null | undefined,
    episode: number | null | undefined,
): Promise<TvdbAiredToAbsoluteMapping | null> {
    if (!config.tvdb.apiKey) {
        logApiCall("TVDB", "mapAiredToAbsolute", {}, "DETAIL", "skip: missing TVDB_API_KEY");
        return null;
    }

    if (!Number.isInteger(seriesId) || !Number.isInteger(season) || !Number.isInteger(episode)) {
        return null;
    }

    if ((seriesId ?? 0) < 1 || (season ?? 0) < 1 || (episode ?? 0) < 1) {
        return null;
    }

    const resolvedSeriesId = seriesId as number;
    const resolvedSeason = season as number;
    const resolvedEpisode = episode as number;

    const cacheKey = `${resolvedSeriesId}:${resolvedSeason}:${resolvedEpisode}`;
    const cachedMapping = getCachedAiredToAbsoluteMapping(cacheKey);
    if (cachedMapping !== undefined) {
        return cachedMapping;
    }

    logApiCall(
        "TVDB",
        "mapAiredToAbsolute",
        { seriesId: resolvedSeriesId, season: resolvedSeason, episode: resolvedEpisode },
        "DETAIL",
        "attempt official/default → absolute",
    );

    try {
        const absoluteEpisodes = await fetchEpisodeOrder(resolvedSeriesId, "absolute");
        if (absoluteEpisodes.length === 0) {
            logApiCall(
                "TVDB",
                "mapAiredToAbsolute",
                { seriesId: resolvedSeriesId, season: resolvedSeason, episode: resolvedEpisode },
                "DETAIL",
                "fail-safe: absolute order unavailable",
            );
            cacheAiredToAbsoluteMapping(cacheKey, null);
            return null;
        }

        for (const seasonType of ["default", "official"] as TvdbSeasonType[]) {
            let airedEpisodes: TvdbEpisodeRecord[];
            try {
                airedEpisodes = await fetchEpisodeOrder(resolvedSeriesId, seasonType);
            } catch (error) {
                logApiCall(
                    "TVDB",
                    "mapAiredToAbsolute",
                    { seriesId: resolvedSeriesId, season: resolvedSeason, episode: resolvedEpisode },
                    "DETAIL",
                    `seasonType=${seasonType} unavailable: ${error instanceof Error ? error.message : "unknown"}`,
                );
                continue;
            }

            const mapping = buildAiredToAbsoluteMapping(
                resolvedSeriesId,
                resolvedSeason,
                resolvedEpisode,
                seasonType,
                airedEpisodes,
                absoluteEpisodes,
            );
            if (!mapping) {
                continue;
            }

            logApiCall(
                "TVDB",
                "mapAiredToAbsolute",
                { seriesId: resolvedSeriesId, season: resolvedSeason, episode: resolvedEpisode },
                "DETAIL",
                `seasonType=${seasonType} absolute=${mapping.absoluteEpisode}`,
            );
            cacheAiredToAbsoluteMapping(cacheKey, mapping);
            return mapping;
        }

        logApiCall(
            "TVDB",
            "mapAiredToAbsolute",
            { seriesId: resolvedSeriesId, season: resolvedSeason, episode: resolvedEpisode },
            "DETAIL",
            "fail-safe: no aired/default episode id matched absolute order",
        );
        cacheAiredToAbsoluteMapping(cacheKey, null);
        return null;
    } catch (error) {
        logApiCall(
            "TVDB",
            "mapAiredToAbsolute",
            { seriesId: resolvedSeriesId, season: resolvedSeason, episode: resolvedEpisode },
            "DETAIL",
            `fail-safe: ${error instanceof Error ? error.message : "mapping unavailable"}`,
        );
        cacheAiredToAbsoluteMapping(cacheKey, null);
        return null;
    }
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

function getSeasonId(season: TvdbSeasonRecord): number | null {
    return normalizeEpisodeNumber(season.id);
}

function findSeasonRecordByNumber(seasons: TvdbSeasonRecord[], targetSeason: number): TvdbSeasonRecord | null {
    if (!Number.isInteger(targetSeason) || targetSeason < 1) {
        return null;
    }

    return seasons.find((season) => getSeasonNumber(season) === targetSeason) ?? null;
}

function getArtworkType(artwork: TvdbArtworkRecord): number | null {
    return normalizeEpisodeNumber(artwork.type);
}

function getArtworkSeasonId(artwork: TvdbArtworkRecord): number | null {
    return normalizeEpisodeNumber(artwork.seasonId);
}

function getArtworkScore(artwork: TvdbArtworkRecord): number {
    if (typeof artwork.score === "number" && Number.isFinite(artwork.score)) {
        return artwork.score;
    }

    if (typeof artwork.score === "string") {
        const parsedScore = Number.parseFloat(artwork.score);
        return Number.isFinite(parsedScore) ? parsedScore : 0;
    }

    return 0;
}

function getArtworkImageUrl(artwork: TvdbArtworkRecord): string | null {
    return readString(artwork.image) ?? readString(artwork.thumbnail);
}

function getArtworkLanguage(artwork: TvdbArtworkRecord): string | null {
    const rawLanguage = readString(artwork.language);
    return rawLanguage ? normalizeRawTvdbLanguageCode(rawLanguage) : null;
}

function extractArtworkRecords(response: unknown): TvdbArtworkRecord[] {
    if (!isRecord(response)) {
        return [];
    }

    const data = response.data;
    if (Array.isArray(data)) {
        return data as TvdbArtworkRecord[];
    }

    if (isRecord(data) && Array.isArray(data.artworks)) {
        return data.artworks as TvdbArtworkRecord[];
    }

    if (isRecord(data) && Array.isArray(data.data)) {
        return data.data as TvdbArtworkRecord[];
    }

    if (isRecord(data) && isRecord(data.data) && Array.isArray(data.data.artworks)) {
        return data.data.artworks as TvdbArtworkRecord[];
    }

    return [];
}

function selectSeriesPosterUrl(artworks: TvdbArtworkRecord[]): string | null {
    const seriesPosters = artworks
        .filter((artwork) => getArtworkType(artwork) === TVDB_ARTWORK_TYPE_SERIES_POSTER)
        .filter((artwork) => getArtworkImageUrl(artwork));

    if (seriesPosters.length === 0) {
        return null;
    }

    const [bestPoster] = seriesPosters.sort((left, right) => getArtworkScore(right) - getArtworkScore(left));
    return bestPoster ? getArtworkImageUrl(bestPoster) : null;
}

function getArtworkLanguageRank(artwork: TvdbArtworkRecord, preferredLanguage: string): number {
    const language = getArtworkLanguage(artwork);
    if (language === preferredLanguage) {
        return 0;
    }

    if (language === "eng") {
        return 1;
    }

    return 2;
}

export function selectSeasonPosterUrl(
    artworks: TvdbArtworkRecord[],
    seasonId: number,
    preferredLanguage: string,
): string | null {
    if (!Number.isInteger(seasonId) || seasonId < 1) {
        return null;
    }

    const normalizedPreferredLanguage = normalizeRawTvdbLanguageCode(preferredLanguage);
    const matchingPosters = artworks
        .filter((artwork) => getArtworkType(artwork) === TVDB_ARTWORK_TYPE_SEASON_POSTER)
        .filter((artwork) => getArtworkSeasonId(artwork) === seasonId)
        .filter((artwork) => getArtworkImageUrl(artwork));

    if (matchingPosters.length === 0) {
        return null;
    }

    const [bestPoster] = matchingPosters.sort((left, right) => {
        const languageRankDifference =
            getArtworkLanguageRank(left, normalizedPreferredLanguage) -
            getArtworkLanguageRank(right, normalizedPreferredLanguage);
        if (languageRankDifference !== 0) {
            return languageRankDifference;
        }

        return getArtworkScore(right) - getArtworkScore(left);
    });

    return bestPoster ? getArtworkImageUrl(bestPoster) : null;
}

async function fetchSeasonCoverUrl(
    seriesId: number,
    targetSeason: number | null | undefined,
    preferredLanguage: string,
    initialResponse: unknown,
): Promise<string | null> {
    if (!Number.isInteger(targetSeason) || (targetSeason ?? 0) < 1) {
        return null;
    }

    const seasonNumber = targetSeason as number;

    try {
        let seasonRecords = extractSeasonRecords(initialResponse);
        let seasonRecord = findSeasonRecordByNumber(seasonRecords, seasonNumber);
        let seasonId = seasonRecord ? getSeasonId(seasonRecord) : null;

        if (seasonId === null) {
            const seasonsResponse = await tvdbRequest(
                `/series/${seriesId}/extended`,
                { meta: "episodes" },
                "getSeasons",
            );
            seasonRecords = extractSeasonRecords(seasonsResponse);
            seasonRecord = findSeasonRecordByNumber(seasonRecords, seasonNumber);
            seasonId = seasonRecord ? getSeasonId(seasonRecord) : null;
        }

        if (seasonId === null) {
            logApiCall("TVDB", "getSeasonArtwork", { seriesId, season: seasonNumber }, "DETAIL", "missing seasonId");
            return null;
        }

        const artworkResponse = await tvdbRequest(
            `/series/${seriesId}/artworks`,
            { type: TVDB_ARTWORK_TYPE_SEASON_POSTER },
            "getSeasonArtwork",
        );
        const seasonPosterUrl = selectSeasonPosterUrl(
            extractArtworkRecords(artworkResponse),
            seasonId,
            preferredLanguage,
        );

        logApiCall(
            "TVDB",
            "getSeasonArtwork",
            { seriesId, season: seasonNumber, seasonId },
            "DETAIL",
            seasonPosterUrl ? `found "${seasonPosterUrl}"` : "no matching season poster",
        );

        return seasonPosterUrl;
    } catch (error) {
        logApiCall(
            "TVDB",
            "getSeasonArtwork",
            { seriesId, season: seasonNumber },
            "DETAIL",
            `fallback series poster: ${error instanceof Error ? error.message : "artwork unavailable"}`,
        );
        return null;
    }
}

function buildSeasonInferenceInputs(context?: EpisodeLookupContext): {
    normalizedHints: string[];
    hintTokens: Set<string>;
} {
    const rawHints: Array<string | undefined> = [context?.searchTitle, ...(context?.canonicalTitles || [])];

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

function computeSeasonHintScore(seasonName: string, normalizedHints: string[], hintTokens: Set<string>): number {
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
    context?: EpisodeLookupContext,
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
        const seasonsResponse = await tvdbRequest(`/series/${seriesId}/extended`, { meta: "episodes" }, "getSeasons");
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
            logSeasonInferenceDebug(seriesId, `candidate season=${seasonNum} name="${seasonName}" score=${score}`);

            if (score < MIN_INFERENCE_SCORE) {
                continue;
            }

            if (!best || score > best.score || (score === best.score && seasonNum > best.season)) {
                best = {
                    season: seasonNum,
                    score,
                    reason: `title-hint match "${seasonName}"`,
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

interface TvdbEpisodeLookupResult {
    episode: TvdbEpisodeRecord;
    seasonType: TvdbEpisodeOrderType;
    sourceSeason?: number;
    sourceEpisode?: number;
    tvdbAbsoluteEpisode?: number;
}

async function lookupEpisodeForSeasonNumber(
    seriesId: number,
    seasonNum: number,
    episode: number,
): Promise<TvdbEpisodeLookupResult | null> {
    for (const seasonType of ["official", "default"] as TvdbSeasonType[]) {
        try {
            logApiCall(
                "TVDB",
                "getEpisode",
                { id: seriesId, season: seasonNum, ep: episode },
                "DETAIL",
                `seasonType=${seasonType} exact`,
            );

            const exactResponse = await tvdbRequest(
                `/series/${seriesId}/episodes/${seasonType}`,
                {
                    page: 0,
                    season: seasonNum,
                    episodeNumber: episode,
                },
                "getEpisode",
            );

            const exactEpisodes = extractEpisodeList(exactResponse);
            const exactMatch = findExactEpisode(exactEpisodes, seasonNum, episode);
            if (exactMatch) {
                logApiCall(
                    "TVDB",
                    "getEpisode",
                    { id: seriesId, season: seasonNum, ep: episode },
                    "DETAIL",
                    `seasonType=${seasonType} exact-match`,
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
                `seasonType=${seasonType} exact-miss -> paginated`,
            );

            for (let page = 0; page < MAX_SEASON_LOOKUP_PAGES; page++) {
                const pageResponse = await tvdbRequest(
                    `/series/${seriesId}/episodes/${seasonType}`,
                    {
                        page,
                        season: seasonNum,
                    },
                    "getEpisode",
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
                        `seasonType=${seasonType} paginated-match page=${page}`,
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
                    "seasonType=official miss -> trying default",
                );
            }
        } catch {
            logApiCall(
                "TVDB",
                "getEpisode",
                { id: seriesId, season: seasonNum, ep: episode },
                "DETAIL",
                `seasonType=${seasonType} failed`,
            );
        }
    }

    return null;
}

function readAbsoluteNumberFromAbsoluteOrderEpisode(episode: TvdbEpisodeRecord): number | null {
    return getAbsoluteEpisodeNumber(episode) ?? normalizeEpisodeNumber(episode.number);
}

async function lookupEpisodeForMappedSourcePosition(
    seriesId: number,
    sourceSeason: number,
    sourceEpisode: number,
    effectiveSeason: number,
    effectiveEpisode: number,
): Promise<TvdbEpisodeLookupResult | null> {
    logApiCall(
        "TVDB",
        "getEpisode",
        { id: seriesId, sourceSeason, sourceEpisode, effectiveSeason, effectiveEpisode },
        "DETAIL",
        "source S/E lookup before effective episode fallback",
    );

    const sourceSeasonMatch = await lookupEpisodeForSeasonNumber(seriesId, sourceSeason, sourceEpisode);
    if (sourceSeasonMatch) {
        logApiCall(
            "TVDB",
            "getEpisode",
            { id: seriesId, sourceSeason, sourceEpisode, effectiveSeason, effectiveEpisode },
            "DETAIL",
            `source S/E matched seasonType=${sourceSeasonMatch.seasonType}`,
        );

        return {
            ...sourceSeasonMatch,
            sourceSeason,
            sourceEpisode,
        };
    }

    try {
        const absoluteEpisodes = await fetchEpisodeOrder(seriesId, "absolute");
        const absoluteSourcePositionMatch = findExactEpisode(absoluteEpisodes, sourceSeason, sourceEpisode);
        if (absoluteSourcePositionMatch) {
            const tvdbAbsoluteEpisode = readAbsoluteNumberFromAbsoluteOrderEpisode(absoluteSourcePositionMatch);
            logApiCall(
                "TVDB",
                "getEpisode",
                { id: seriesId, sourceSeason, sourceEpisode, effectiveSeason, effectiveEpisode, tvdbAbsoluteEpisode },
                "DETAIL",
                "order=absolute source S/E match in TVDB absolute order",
            );

            return {
                episode: absoluteSourcePositionMatch,
                seasonType: "absolute",
                sourceSeason,
                sourceEpisode,
                tvdbAbsoluteEpisode: tvdbAbsoluteEpisode ?? undefined,
            };
        }

        const mappedEpisode = await mapTvdbAiredEpisodeToAbsolute(seriesId, sourceSeason, sourceEpisode);
        if (!mappedEpisode) {
            logApiCall(
                "TVDB",
                "getEpisode",
                { id: seriesId, sourceSeason, sourceEpisode, effectiveSeason, effectiveEpisode },
                "DETAIL",
                "order=absolute no proven source S/E mapping -> fallback official/default effective episode",
            );
            return null;
        }

        const absoluteEpisodeMatch = findEpisodeByAbsoluteNumber(absoluteEpisodes, mappedEpisode.absoluteEpisode);
        if (!absoluteEpisodeMatch) {
            logApiCall(
                "TVDB",
                "getEpisode",
                {
                    id: seriesId,
                    sourceSeason,
                    sourceEpisode,
                    effectiveSeason,
                    effectiveEpisode,
                    tvdbAbsoluteEpisode: mappedEpisode.absoluteEpisode,
                },
                "DETAIL",
                "order=absolute mapped number missing from absolute order -> fallback official/default effective episode",
            );
            return null;
        }

        logApiCall(
            "TVDB",
            "getEpisode",
            {
                id: seriesId,
                sourceSeason,
                sourceEpisode,
                effectiveSeason,
                effectiveEpisode,
                tvdbAbsoluteEpisode: mappedEpisode.absoluteEpisode,
            },
            "DETAIL",
            `order=absolute mapped source S/E via ${mappedEpisode.seasonType}`,
        );

        return {
            episode: absoluteEpisodeMatch,
            seasonType: "absolute",
            sourceSeason,
            sourceEpisode,
            tvdbAbsoluteEpisode: mappedEpisode.absoluteEpisode,
        };
    } catch (error) {
        logApiCall(
            "TVDB",
            "getEpisode",
            { id: seriesId, sourceSeason, sourceEpisode, effectiveSeason, effectiveEpisode },
            "DETAIL",
            `order=absolute unavailable: ${error instanceof Error ? error.message : "unknown"}`,
        );
        return null;
    }
}

async function fetchSeriesTranslationName(
    seriesId: number,
    lang: string,
    availableTranslations: string[],
    label: string,
): Promise<string | null> {
    if (!availableTranslations.includes(lang)) {
        logApiCall(
            "TVDB",
            "getTranslation",
            { seriesId, lang },
            "DETAIL",
            `series ${label} translation skipped: unavailable`,
        );
        return null;
    }

    try {
        const translationResponse = await tvdbRequest(
            `/series/${seriesId}/translations/${lang}`,
            { seriesId, lang },
            "getTranslation",
        );
        const translationData = isRecord(translationResponse?.data) ? translationResponse.data : null;
        const translatedName = readString(translationData?.name);

        logApiCall(
            "TVDB",
            "getTranslation",
            { seriesId, lang },
            "DETAIL",
            translatedName
                ? `series ${label} translation found: "${translatedName}"`
                : `series ${label} translation missing: no name`,
        );

        return translatedName;
    } catch (error) {
        logApiCall(
            "TVDB",
            "getTranslation",
            { seriesId, lang },
            "DETAIL",
            `series ${label} translation missing: ${error instanceof Error ? error.message : "request failed"}`,
        );
        return null;
    }
}

function isPlaceholderEpisodeTitle(title: string | null | undefined): boolean {
    if (!title) {
        return true;
    }

    const normalized = title.trim().toLowerCase();
    return (
        normalized.length === 0 ||
        normalized === "tba" ||
        normalized === "tbd" ||
        normalized === "to be announced" ||
        normalized === "to be determined"
    );
}

function hasNonLatinScript(title: string | null | undefined): boolean {
    if (!title) {
        return false;
    }

    return /[\u3000-\u9FFF\uAC00-\uD7AF\u0400-\u04FF]/u.test(title);
}

function normalizeTvdbSearchText(value: string | null | undefined): string {
    if (!value) {
        return "";
    }

    return value
        .toLowerCase()
        .replace(/['’`´]+/g, "")
        .replace(/[^a-z0-9\u3000-\u9fff\uac00-\ud7af]+/giu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function stripTrailingYearFromSearchText(normalizedValue: string): string {
    return normalizedValue.replace(/\s+(?:19|20)\d{2}$/, "").trim();
}

function selectBestTvdbSearchResult(results: any[], query: string, expectedSeason?: number): any {
    if (results.length <= 1) {
        return results[0];
    }

    const normalizedQuery = normalizeTvdbSearchText(query);
    const queryHasYear = /\b(?:19|20)\d{2}\b/.test(normalizedQuery);
    const querySlug = normalizedQuery.replace(/\s+/g, "-");
    let bestResult = results[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < results.length; index++) {
        const candidate = results[index];
        if (!isRecord(candidate)) {
            continue;
        }

        let score = -index;
        const rawName = readString(candidate.name) ?? "";
        const normalizedName = normalizeTvdbSearchText(rawName);
        const normalizedNameNoYear = queryHasYear ? normalizedName : stripTrailingYearFromSearchText(normalizedName);
        const rawSlug = readString(candidate.slug)?.toLowerCase() ?? "";
        const slugNoYear = queryHasYear ? rawSlug : rawSlug.replace(/-(?:19|20)\d{2}$/, "");
        const translations = isRecord(candidate.translations) ? candidate.translations : null;
        const englishTranslation = normalizeTvdbSearchText(readString(translations?.eng));
        const englishTranslationNoYear = queryHasYear
            ? englishTranslation
            : stripTrailingYearFromSearchText(englishTranslation);

        if (
            normalizedName === normalizedQuery ||
            englishTranslation === normalizedQuery ||
            normalizedNameNoYear === normalizedQuery ||
            englishTranslationNoYear === normalizedQuery
        ) {
            score += 100;
        }

        if (
            rawSlug &&
            (rawSlug === querySlug ||
                rawSlug === `${querySlug}-anime` ||
                slugNoYear === querySlug ||
                slugNoYear === `${querySlug}-anime`)
        ) {
            score += 80;
        }

        if (Array.isArray(candidate.aliases)) {
            const hasExactAlias = candidate.aliases.some((alias) => {
                const aliasText = isRecord(alias) ? readString(alias.name) : readString(alias);
                const normalizedAlias = normalizeTvdbSearchText(aliasText);
                const normalizedAliasNoYear = queryHasYear
                    ? normalizedAlias
                    : stripTrailingYearFromSearchText(normalizedAlias);
                return normalizedAlias === normalizedQuery || normalizedAliasNoYear === normalizedQuery;
            });
            if (hasExactAlias) {
                score += 60;
            }
        }

        if (Array.isArray(candidate.genres)) {
            const hasAnimeGenre = candidate.genres.some((genre) => {
                const genreText = (isRecord(genre) ? readString(genre.name) : readString(genre))?.toLowerCase() ?? "";
                return genreText === "anime" || genreText === "animation";
            });
            if (hasAnimeGenre) {
                score += 50;
            }
        }

        if (expectedSeason && expectedSeason > 1) {
            const statusText = (
                isRecord(candidate.status) ? readString(candidate.status.name) : readString(candidate.status)
            )?.toLowerCase();
            if (statusText === "continuing") {
                score += 15;
            }
        }

        if (hasNonLatinScript(rawName) && /[a-z]/i.test(rawName) && normalizedName !== normalizedQuery) {
            score -= 30;
        }

        if (score > bestScore) {
            bestScore = score;
            bestResult = candidate;
        }
    }

    return bestResult;
}

async function fetchLocalizedEpisodeTitle(
    episodeId: number | null,
    translationPlan: EpisodeTranslationLanguagePlan,
    defaultTitle: string | null,
): Promise<string | null> {
    const { canonicalLanguage, candidates, availableLanguages } = translationPlan;

    if (!defaultTitle) {
        logApiCall(
            "TVDB",
            "getEpisodeTranslation",
            { episodeId, lang: canonicalLanguage },
            "DETAIL",
            `episode translation skipped: no default title available for episodeId=${episodeId ?? "unknown"}, lang=${canonicalLanguage}`,
        );
        return null;
    }

    if (canonicalLanguage === "eng") {
        if (!isPlaceholderEpisodeTitle(defaultTitle) && !hasNonLatinScript(defaultTitle)) {
            logApiCall(
                "TVDB",
                "getEpisodeTranslation",
                { episodeId, lang: canonicalLanguage },
                "DETAIL",
                `episode translation skipped: requested lang=${canonicalLanguage}; using default "${defaultTitle}"`,
            );
            return defaultTitle;
        }

        if (episodeId !== null) {
            const englishTitle = await fetchLocalizedEpisodeTitleCandidate(episodeId, "eng");
            if (englishTitle) {
                logApiCall(
                    "TVDB",
                    "getEpisodeTranslation",
                    { episodeId, lang: "eng" },
                    "DETAIL",
                    `localized title found for episodeId=${episodeId}, lang=eng: "${englishTitle}"`,
                );
                return englishTitle;
            }
        }

        return isPlaceholderEpisodeTitle(defaultTitle) ? null : defaultTitle;
    }

    if (episodeId === null) {
        logApiCall(
            "TVDB",
            "getEpisodeTranslation",
            { episodeId, lang: canonicalLanguage },
            "DETAIL",
            `episode translation skipped: missing episodeId for lang=${canonicalLanguage}; fallback default "${defaultTitle}"`,
        );
        return isPlaceholderEpisodeTitle(defaultTitle) ? null : defaultTitle;
    }

    logApiCall(
        "TVDB",
        "getEpisodeTranslation",
        { episodeId, lang: canonicalLanguage },
        "DETAIL",
        `langCandidates:${JSON.stringify(candidates)}${
            availableLanguages.length > 0 ? ` availableLanguages:${JSON.stringify(availableLanguages)}` : ""
        }`,
    );

    for (const lang of candidates) {
        const candidateTitle = await fetchLocalizedEpisodeTitleCandidate(episodeId, lang);
        if (candidateTitle) {
            const canonicalSuffix = lang === canonicalLanguage ? "" : `, canonical=${canonicalLanguage}`;
            logApiCall(
                "TVDB",
                "getEpisodeTranslation",
                { episodeId, lang },
                "DETAIL",
                `localized title found for episodeId=${episodeId}, lang=${lang}${canonicalSuffix}: "${candidateTitle}"`,
            );
            return candidateTitle;
        }
    }

    const shouldTryEnglishFallback =
        availableLanguages.includes("eng") ||
        isPlaceholderEpisodeTitle(defaultTitle) ||
        hasNonLatinScript(defaultTitle);
    if (shouldTryEnglishFallback) {
        const englishFallbackTitle = await fetchLocalizedEpisodeTitleCandidate(episodeId, "eng");
        if (englishFallbackTitle) {
            logApiCall(
                "TVDB",
                "getEpisodeTranslation",
                { episodeId, lang: "eng" },
                "DETAIL",
                `localized title found for episodeId=${episodeId}, lang=eng, canonical=${canonicalLanguage}: "${englishFallbackTitle}"`,
            );
            return englishFallbackTitle;
        }
    }

    if (isPlaceholderEpisodeTitle(defaultTitle)) {
        logApiCall(
            "TVDB",
            "getEpisodeTranslation",
            { episodeId, lang: canonicalLanguage },
            "DETAIL",
            `no localized title found for episodeId=${episodeId}, langCandidates:${JSON.stringify(
                candidates,
            )}; rejecting placeholder default "${defaultTitle}"`,
        );
        return null;
    }

    logApiCall(
        "TVDB",
        "getEpisodeTranslation",
        { episodeId, lang: canonicalLanguage },
        "DETAIL",
        `no localized title found for episodeId=${episodeId}, langCandidates:${JSON.stringify(
            candidates,
        )}; fallback default "${defaultTitle}"`,
    );
    return defaultTitle;
}

async function fetchLocalizedEpisodeTitleCandidate(episodeId: number, lang: string): Promise<string | null> {
    try {
        const translationResponse = await tvdbRequest(
            `/episodes/${episodeId}/translations/${lang}`,
            { episodeId, lang },
            "getEpisodeTranslation",
            { expectedMissingStatuses: [404] },
        );
        const translationData = isRecord(translationResponse?.data) ? translationResponse.data : null;
        const localizedTitle = readString(translationData?.name);

        if (localizedTitle && !isPlaceholderEpisodeTitle(localizedTitle)) {
            return localizedTitle;
        }

        logApiCall(
            "TVDB",
            "getEpisodeTranslation",
            { episodeId, lang },
            "DETAIL",
            `candidate missing for episodeId=${episodeId}, lang=${lang}: ${localizedTitle ? "placeholder name" : "no name"}`,
        );
        return null;
    } catch (error) {
        logApiCall(
            "TVDB",
            "getEpisodeTranslation",
            { episodeId, lang },
            "DETAIL",
            `candidate unavailable for episodeId=${episodeId}, lang=${lang}: ${
                error instanceof Error ? error.message : "request failed"
            }`,
        );
        return null;
    }
}

export class TvdbProvider implements AnimeProvider {
    readonly name = "tvdb";

    getEpisodeCacheKeyScope(): string {
        return getTvdbLanguage();
    }

    async searchAnime(title: string, expectedSeason?: number): Promise<AnimeSearchResult | null> {
        try {
            const response = await tvdbRequest(
                "/search",
                {
                    query: title,
                    type: "series",
                    limit: 5,
                },
                "search",
            );

            const results = response?.data;
            if (!results || results.length === 0) {
                logApiCall("TVDB", "search", { query: title }, "DETAIL", "0 results");
                return null;
            }

            // Find best match - prefer exact or closest title match
            const result = selectBestTvdbSearchResult(results, title, expectedSeason);
            const tvdbId = parseInt(result.tvdb_id || result.id, 10);

            logApiCall("TVDB", "search", { query: title }, "DETAIL", `"${result.name}" (ID:${tvdbId})`);

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

    async getAnimeById(id: number, season?: number | null): Promise<AnimeInfo | null> {
        try {
            const response = await tvdbRequest(
                `/series/${id}/extended`,
                {
                    seriesId: id,
                    short: true,
                },
                "getById",
            );

            const series = response?.data as TvdbSeriesRecord | undefined;
            if (!series) return null;

            // series.name = original title (Japanese for anime)
            const titleRomaji = readString(series.name) || "";
            let displayTitle: string | null = null;
            const availableTranslations = readStringArray(series.nameTranslations);

            // Always try to get the English title
            displayTitle = await fetchSeriesTranslationName(id, "eng", availableTranslations, "English");

            // If TVDB_LANG is not English, also fetch localized name for display
            const lang = getTvdbLanguage();
            if (lang !== "eng") {
                const localizedName = await fetchSeriesTranslationName(id, lang, availableTranslations, "localized");
                if (localizedName) {
                    // Use the localized title as the display title
                    displayTitle = localizedName;
                }
            }

            // Fallback: if no English title found, use series.name
            if (!displayTitle) {
                displayTitle = readString(series.name);
            }

            // Get artwork - find poster type
            let coverUrl: string | null = readString(series.image);
            if (series.artworks && series.artworks.length > 0) {
                coverUrl = selectSeriesPosterUrl(series.artworks) ?? coverUrl;
            }
            const seasonCoverUrl = await fetchSeasonCoverUrl(id, season, lang, response);

            logApiCall(
                "TVDB",
                "getById",
                { id },
                "DETAIL",
                `"${displayTitle || titleRomaji}" (${series.status?.name || "unknown"})`,
            );

            return {
                id: id,
                title_english: displayTitle,
                title_romaji: titleRomaji,
                cover_url: coverUrl,
                season_cover_url: seasonCoverUrl,
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
        context?: EpisodeLookupContext,
    ): Promise<string | null> {
        try {
            const requestedSeason = season ?? 1;
            let resolvedSeason = requestedSeason;

            if (!season || season <= 1) {
                const inferredSeason = await inferSeasonFromTitleHints(seriesId, context);
                if (inferredSeason) {
                    resolvedSeason = inferredSeason.season;
                    logSeasonInferenceDebug(seriesId, `using inferred season=${resolvedSeason} for episode=${episode}`);
                } else {
                    logSeasonInferenceDebug(seriesId, `using default season=${resolvedSeason} for episode=${episode}`);
                }
            }

            const sourceEpisode = normalizeEpisodeNumber(context?.sourceEpisode);
            const sourceSeason = normalizeEpisodeNumber(context?.sourceSeason);
            const shouldTrySourcePosition =
                sourceSeason !== null &&
                sourceSeason > 0 &&
                sourceEpisode !== null &&
                sourceEpisode > 0 &&
                (sourceSeason !== resolvedSeason || sourceEpisode !== episode);
            const lookupResult = shouldTrySourcePosition
                ? ((await lookupEpisodeForMappedSourcePosition(
                      seriesId,
                      sourceSeason,
                      sourceEpisode,
                      resolvedSeason,
                      episode,
                  )) ?? (await lookupEpisodeForSeasonNumber(seriesId, resolvedSeason, episode)))
                : await lookupEpisodeForSeasonNumber(seriesId, resolvedSeason, episode);

            if (!lookupResult) {
                logApiCall(
                    "TVDB",
                    "getEpisode",
                    { id: seriesId, season: resolvedSeason, ep: episode },
                    "DETAIL",
                    "no exact season+episode match",
                );
                return null;
            }

            const selectedEpisode = lookupResult.episode;
            const selectedSeasonType = lookupResult.seasonType;

            let epTitle = readString(selectedEpisode.name);
            const episodeId = normalizeEpisodeNumber(selectedEpisode.id);

            // Try to get localized episode title
            const rawLanguage = config.tvdb.language || "eng";
            const lang = getTvdbLanguage();
            const translationPlan = buildEpisodeTranslationLanguagePlan(rawLanguage, lang, selectedEpisode);
            epTitle = await fetchLocalizedEpisodeTitle(episodeId, translationPlan, epTitle);

            if (epTitle) {
                const finalLogParams = {
                    id: seriesId,
                    season: resolvedSeason,
                    ep: episode,
                    ...(lookupResult.sourceSeason ? { sourceSeason: lookupResult.sourceSeason } : {}),
                    ...(lookupResult.sourceEpisode ? { sourceEpisode: lookupResult.sourceEpisode } : {}),
                    ...(lookupResult.tvdbAbsoluteEpisode
                        ? { tvdbAbsoluteEpisode: lookupResult.tvdbAbsoluteEpisode }
                        : {}),
                };
                logApiCall(
                    "TVDB",
                    "getEpisode",
                    finalLogParams,
                    "DETAIL",
                    `seasonType=${selectedSeasonType || "unknown"} "${epTitle}"`,
                );
            }

            return epTitle;
        } catch {
            return null;
        }
    }

    async findSeasonAnime(baseId: number, targetSeason: number): Promise<AnimeInfo | null> {
        // TVDB groups all seasons under one series, so we just return the base series
        // The season info is used when fetching episodes and season-specific artwork
        const anime = await this.getAnimeById(baseId, targetSeason);
        return anime ? markSeasonAnimeValidated(anime, targetSeason, "provider-season") : null;
    }

    async getSequelInfo(_animeId: number): Promise<SequelInfo | null> {
        // TVDB groups all seasons under one series; sequel traversal is not applicable
        return null;
    }
}
