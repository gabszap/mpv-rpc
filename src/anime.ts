/**
 * Anime Metadata Module - Uses configured provider to fetch metadata
 */

import * as fs from "fs";
import * as path from "path";
import { config, type MetadataProvider } from "./config";
import { JikanProvider } from "./providers/jikan";
import { AniListProvider } from "./providers/anilist";
import { KitsuProvider } from "./providers/kitsu";
import { TvdbProvider } from "./providers/tvdb";
import type { AnimeProvider, AnimeInfo, AnimeSearchResult } from "./providers/types";

// Re-export AnimeInfo type for other modules
export type { AnimeInfo } from "./providers/types";

// Select provider based on config
function createProvider(metadataProvider: MetadataProvider): AnimeProvider {
    switch (metadataProvider) {
        case "anilist":
            return new AniListProvider();
        case "kitsu":
            return new KitsuProvider();
        case "tvdb":
            return new TvdbProvider();
        default:
            return new JikanProvider();
    }
}

const provider = createProvider(config.metadataProvider);

// Fallback providers for episode titles
function createFallbackProviders(primaryProviderName: string): AnimeProvider[] {
    const fallbackCandidates: AnimeProvider[] = [
        new JikanProvider(),
        new KitsuProvider(),
    ];

    if (config.tvdb.apiKey) {
        fallbackCandidates.push(new TvdbProvider());
    }

    const seenProviderNames = new Set<string>([primaryProviderName]);
    const fallbackList: AnimeProvider[] = [];

    for (const fallbackCandidate of fallbackCandidates) {
        if (seenProviderNames.has(fallbackCandidate.name)) {
            continue;
        }

        seenProviderNames.add(fallbackCandidate.name);
        fallbackList.push(fallbackCandidate);
    }

    return fallbackList;
}

const fallbackProviders = createFallbackProviders(provider.name);

// Export provider name for logging
export const providerName = provider.name;

// Cache
interface CacheEntry {
    data: AnimeInfo | null;
    timestamp: number;
    sourceProvider?: string;
}

const cache: Map<string, CacheEntry> = new Map();
const episodeCache: Map<string, string | null> = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const NEGATIVE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes for not-found results

function isCacheEntryValid(entry: CacheEntry, now = Date.now()): boolean {
    const ttl = entry.data === null ? NEGATIVE_CACHE_TTL : CACHE_TTL;
    return now - entry.timestamp < ttl;
}

function normalizeProviderFields(info: AnimeInfo, providerName: string): AnimeInfo {
    if (providerName === "jikan" && !info.mal_id) {
        return {
            ...info,
            mal_id: info.id,
        };
    }

    return info;
}

function getProvidersInResolutionOrder(): AnimeProvider[] {
    const providersInOrder: AnimeProvider[] = [];
    const seen = new Set<string>();

    for (const currentProvider of [provider, ...fallbackProviders]) {
        if (seen.has(currentProvider.name)) {
            continue;
        }

        seen.add(currentProvider.name);
        providersInOrder.push(currentProvider);
    }

    return providersInOrder;
}

interface AnimeResolutionContext {
    requestedTitle: string;
    season: number | null;
    episode: number | null;
}

interface ScoredResolutionCandidate {
    animeInfo: AnimeInfo;
    score: number;
    seasonFamilyKey: string | null;
    hasSplitCourMarker: boolean;
    hasMatchingSeasonMarker: boolean;
    hasConflictingSeasonMarker: boolean;
    isEpisodeCompatible: boolean;
    hasEpisodeCountEvidence: boolean;
    queryIncludesSeasonHint: boolean;
}

interface ParsedCacheKey {
    providerName: string;
    title: string;
    season: number;
    episode: number | null;
    isLegacy: boolean;
}

function normalizeTitleForMatching(value: string): string {
    return value
        .toLowerCase()
        .replace(/['`´’]+/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function hasExplicitSeasonHint(value: string, season: number): boolean {
    const seasonPattern = new RegExp(
        `\\b(?:season|s)\\s*0*${season}\\b|\\b0*${season}(?:st|nd|rd|th)\\s*season\\b`,
        "i"
    );
    return seasonPattern.test(value);
}

function parseCacheKey(key: string): ParsedCacheKey | null {
    const parts = key.split(":");

    if (parts.length === 4) {
        const [providerName, title, seasonRaw, episodeRaw] = parts;
        const season = Number.parseInt(seasonRaw, 10);

        if (!providerName || !title || Number.isNaN(season)) {
            return null;
        }

        if (episodeRaw === "any") {
            return {
                providerName,
                title,
                season,
                episode: null,
                isLegacy: false,
            };
        }

        const episode = Number.parseInt(episodeRaw, 10);
        if (Number.isNaN(episode) || episode < 1) {
            return null;
        }

        return {
            providerName,
            title,
            season,
            episode,
            isLegacy: false,
        };
    }

    if (parts.length === 3) {
        const [providerName, title, seasonRaw] = parts;
        const season = Number.parseInt(seasonRaw, 10);

        if (!providerName || !title || Number.isNaN(season)) {
            return null;
        }

        return {
            providerName,
            title,
            season,
            episode: null,
            isLegacy: true,
        };
    }

    return null;
}

function buildResolutionSearchQueries(title: string, season: number | null): string[] {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
        return [];
    }

    const shouldAppendSeasonQuery = Boolean(
        season
        && season > 1
        && !hasExplicitSeasonHint(normalizedTitle, season)
    );

    const rawQueries: Array<string | null> = [
        shouldAppendSeasonQuery ? `${normalizedTitle} season ${season}` : null,
        normalizedTitle,
    ];

    const seen = new Set<string>();
    const queries: string[] = [];

    for (const rawQuery of rawQueries) {
        const query = rawQuery?.trim();
        if (!query) {
            continue;
        }

        const dedupeKey = query.toLowerCase();
        if (seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
        queries.push(query);
    }

    return queries;
}

function extractSeasonNumberFromTitle(title: string): number | null {
    const patterns = [
        /(?:season|s)\s*(\d+)/i,
        /(\d+)(?:st|nd|rd|th)\s*season/i,
    ];

    for (const pattern of patterns) {
        const match = title.match(pattern);
        if (!match) {
            continue;
        }

        return Number.parseInt(match[1], 10);
    }

    return null;
}

function hasPartMarker(title: string): boolean {
    return /\b(part|cour)\s*\d+\b/i.test(title);
}

function collectCandidateTitles(searchResult: AnimeSearchResult, animeInfo: AnimeInfo): string[] {
    const rawTitles = [
        searchResult.title,
        searchResult.title_english,
        animeInfo.title_romaji,
        animeInfo.title_english,
    ];

    const seen = new Set<string>();
    const titles: string[] = [];

    for (const rawTitle of rawTitles) {
        const trimmedTitle = rawTitle?.trim();
        if (!trimmedTitle) {
            continue;
        }

        const key = normalizeTitleForMatching(trimmedTitle);
        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        titles.push(trimmedTitle);
    }

    return titles;
}

function normalizeTitleForSeasonFamily(value: string): string | null {
    const normalizedTitle = normalizeTitleForMatching(value);
    if (!normalizedTitle) {
        return null;
    }

    const normalizedFamilyTitle = normalizedTitle
        .replace(/\b\d+(?:st|nd|rd|th)\s*season\b/g, " ")
        .replace(/\b(?:season|s)\s*\d+\b/g, " ")
        .replace(/\b(?:part|cour)\s*\d+\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return normalizedFamilyTitle.length > 0 ? normalizedFamilyTitle : null;
}

function getSeasonFamilyKey(candidateTitles: string[]): string | null {
    for (const candidateTitle of candidateTitles) {
        const normalizedFamilyTitle = normalizeTitleForSeasonFamily(candidateTitle);
        if (!normalizedFamilyTitle) {
            continue;
        }

        return normalizedFamilyTitle;
    }

    return null;
}

function hasSpecialMarker(title: string): boolean {
    return /\b(special|movie|film|ova|oad|recap|summary)\b/i.test(title);
}

function normalizeMediaType(type: string | null | undefined): string {
    return (type || "").toUpperCase().trim();
}

function isSeriesMediaType(type: string): boolean {
    return type === "TV" || type === "ONA";
}

function isSpecialMediaType(type: string): boolean {
    return type.includes("SPECIAL")
        || type.includes("MOVIE")
        || type.includes("FILM")
        || type.includes("OVA")
        || type.includes("OAD")
        || type.includes("MUSIC");
}

function isEpisodeCompatibleWithAnime(
    animeInfo: Pick<AnimeInfo, "total_episodes">,
    season: number | null,
    episode: number | null
): boolean {
    if (!season || season < 1 || !episode || episode < 1) {
        return true;
    }

    if (typeof animeInfo.total_episodes !== "number") {
        return true;
    }

    return animeInfo.total_episodes >= episode;
}

function hasConflictingSeasonMarkerForContext(candidateTitles: string[], season: number): boolean {
    for (const title of candidateTitles) {
        const seasonMarker = extractSeasonNumberFromTitle(title);
        if (seasonMarker === null) {
            continue;
        }

        if (seasonMarker !== season) {
            return true;
        }
    }

    return false;
}

/**
 * Rewards candidates that belong to a split-cour family validated by episode/season context.
 * The value is intentionally stronger than single-signal title bonuses so validated family
 * grouping wins over noisy sequel naming.
 */
const SPLIT_COUR_FAMILY_BONUS = 260;
/**
 * Penalizes candidates that clearly belong to a different normalized family once a preferred
 * split-cour family has been identified. This remains lower than hard incompatibility penalties
 * so episode count mismatches still dominate final ranking.
 */
const SPLIT_COUR_FAMILY_MISMATCH_PENALTY = 220;
/**
 * Rewards split-cour families that are also discoverable from the base (non-season-appended)
 * query. This keeps explicit season+episode lookups anchored to the current family instead of
 * drifting to sequel-family "Part N" entries only surfaced by season-appended queries.
 */
const SPLIT_COUR_BASE_QUERY_ANCHOR_BONUS = 260;
/**
 * Penalizes season-appended query candidates that still fail to expose an explicit matching
 * season marker while a base-query split-cour family anchor exists.
 */
const SPLIT_COUR_SEASON_QUERY_DRIFT_PENALTY = 320;

function applySplitCourSeasonFamilyHeuristic(
    candidates: ScoredResolutionCandidate[],
    context: AnimeResolutionContext
): ScoredResolutionCandidate[] {
    if (!context.season || context.season < 1 || !context.episode || context.episode < 1) {
        return candidates;
    }

    const familyStats = new Map<string, {
        hasSplitCourMarker: boolean;
        hasCompatibleCandidate: boolean;
        hasBaseQueryCandidate: boolean;
        hasEpisodeCountEvidence: boolean;
        hasConflictingSeasonMarker: boolean;
    }>();

    for (const candidate of candidates) {
        if (!candidate.seasonFamilyKey) {
            continue;
        }

        const previousStats = familyStats.get(candidate.seasonFamilyKey) ?? {
            hasSplitCourMarker: false,
            hasCompatibleCandidate: false,
            hasBaseQueryCandidate: false,
            hasEpisodeCountEvidence: false,
            hasConflictingSeasonMarker: false,
        };

        familyStats.set(candidate.seasonFamilyKey, {
            hasSplitCourMarker: previousStats.hasSplitCourMarker || candidate.hasSplitCourMarker,
            hasCompatibleCandidate: previousStats.hasCompatibleCandidate || candidate.isEpisodeCompatible,
            hasBaseQueryCandidate:
                previousStats.hasBaseQueryCandidate || !candidate.queryIncludesSeasonHint,
            hasEpisodeCountEvidence:
                previousStats.hasEpisodeCountEvidence || candidate.hasEpisodeCountEvidence,
            hasConflictingSeasonMarker:
                previousStats.hasConflictingSeasonMarker
                || candidate.hasConflictingSeasonMarker,
        });
    }

    const preferredFamilyKeys = new Set<string>();
    for (const [familyKey, stats] of familyStats.entries()) {
        if (
            stats.hasSplitCourMarker
            && stats.hasCompatibleCandidate
            && !stats.hasConflictingSeasonMarker
        ) {
            preferredFamilyKeys.add(familyKey);
        }
    }

    if (preferredFamilyKeys.size === 0) {
        return candidates;
    }

    const baseAnchoredPreferredFamilyKeys = new Set<string>();
    for (const preferredFamilyKey of preferredFamilyKeys) {
        const familyStat = familyStats.get(preferredFamilyKey);
        if (familyStat?.hasBaseQueryCandidate && familyStat.hasEpisodeCountEvidence) {
            baseAnchoredPreferredFamilyKeys.add(preferredFamilyKey);
        }
    }

    const hasBaseAnchoredFamily = baseAnchoredPreferredFamilyKeys.size > 0;

    return candidates.map((candidate) => {
        if (!candidate.seasonFamilyKey) {
            return candidate;
        }

        let nextScore = candidate.score;

        if (preferredFamilyKeys.has(candidate.seasonFamilyKey)) {
            nextScore += SPLIT_COUR_FAMILY_BONUS;
        } else {
            nextScore -= SPLIT_COUR_FAMILY_MISMATCH_PENALTY;
        }

        if (hasBaseAnchoredFamily) {
            if (baseAnchoredPreferredFamilyKeys.has(candidate.seasonFamilyKey)) {
                nextScore += SPLIT_COUR_BASE_QUERY_ANCHOR_BONUS;
            } else if (
                candidate.queryIncludesSeasonHint
                && !candidate.hasMatchingSeasonMarker
            ) {
                nextScore -= SPLIT_COUR_SEASON_QUERY_DRIFT_PENALTY;
            }
        }

        return {
            ...candidate,
            score: nextScore,
        };
    });
}

function isSeasonQuerySplitCourDriftCandidate(
    bestMatch: ScoredResolutionCandidate,
    candidates: ScoredResolutionCandidate[],
    context: AnimeResolutionContext
): boolean {
    if (!context.season || context.season < 1 || !context.episode || context.episode < 1) {
        return false;
    }

    if (!bestMatch.queryIncludesSeasonHint || !bestMatch.hasSplitCourMarker || bestMatch.hasMatchingSeasonMarker) {
        return false;
    }

    if (!bestMatch.seasonFamilyKey) {
        return false;
    }

    return candidates.some((candidate) => (
        !candidate.queryIncludesSeasonHint
        && candidate.seasonFamilyKey !== null
        && candidate.seasonFamilyKey !== bestMatch.seasonFamilyKey
    ));
}

function scoreResolvedAnimeCandidate(
    searchResult: AnimeSearchResult,
    animeInfo: AnimeInfo,
    context: AnimeResolutionContext,
    queryUsed: string
): number {
    const normalizedRequestedTitle = normalizeTitleForMatching(context.requestedTitle);
    const candidateTitles = collectCandidateTitles(searchResult, animeInfo);
    const normalizedCandidateTitles = candidateTitles.map((title) => normalizeTitleForMatching(title));

    let score = 0;

    if (normalizedCandidateTitles.includes(normalizedRequestedTitle)) {
        score += 180;
    } else if (normalizedCandidateTitles.some((title) => title.startsWith(normalizedRequestedTitle))) {
        score += 120;
    } else if (normalizedCandidateTitles.some((title) => title.includes(normalizedRequestedTitle))) {
        score += 70;
    }

    if (context.season && context.season > 1) {
        const normalizedQueryUsed = normalizeTitleForMatching(queryUsed);
        if (normalizedQueryUsed.includes(`season ${context.season}`)) {
            score += 80;
        }

        const mediaType = normalizeMediaType(searchResult.type);
        if (isSeriesMediaType(mediaType)) {
            score += 120;
        } else {
            score -= 220;
        }

        if (isSpecialMediaType(mediaType)) {
            score -= 180;
        }

        if (candidateTitles.some((title) => hasSpecialMarker(title))) {
            score -= 140;
        }

        let hasMatchingSeasonMarker = false;
        let hasConflictingSeasonMarker = false;
        const hasSplitCourMarker = candidateTitles.some((title) => hasPartMarker(title));

        for (const title of candidateTitles) {
            const seasonMarker = extractSeasonNumberFromTitle(title);
            if (seasonMarker === null) {
                continue;
            }

            if (seasonMarker === context.season) {
                hasMatchingSeasonMarker = true;
                continue;
            }

            hasConflictingSeasonMarker = true;
        }

        if (hasMatchingSeasonMarker) {
            score += 220;
        } else if (hasConflictingSeasonMarker) {
            score -= 280;
        }

        if (context.episode && context.episode > 0 && hasSplitCourMarker) {
            score += 140;
        }

        const hasSeasonContextHint = hasMatchingSeasonMarker || hasSplitCourMarker;
        if (
            context.episode
            && context.episode > 0
            && normalizedQueryUsed.includes(`season ${context.season}`)
            && !hasSeasonContextHint
        ) {
            score -= 120;
        }
    }

    if (context.episode && context.episode > 0 && typeof animeInfo.total_episodes === "number") {
        if (animeInfo.total_episodes >= context.episode) {
            score += 220;
        } else {
            score -= 1200;
        }
    }

    return score;
}

async function resolveAnimeInfoFromSearchResult(
    currentProvider: AnimeProvider,
    searchResult: AnimeSearchResult,
    season: number | null,
    queryUsed: string
): Promise<AnimeInfo | null> {
    let animeInfo: AnimeInfo | null = null;
    const hasSeasonHintInQuery = Boolean(season && season > 1 && hasExplicitSeasonHint(queryUsed, season));

    try {
        if (season && season > 1 && !hasSeasonHintInQuery) {
            animeInfo = await currentProvider.findSeasonAnime(searchResult.id, season);
        }
    } catch {
        animeInfo = null;
    }

    if (!animeInfo) {
        try {
            animeInfo = await currentProvider.getAnimeById(searchResult.id);
        } catch {
            animeInfo = null;
        }
    }

    if (!animeInfo && season && season > 1 && hasSeasonHintInQuery) {
        try {
            animeInfo = await currentProvider.findSeasonAnime(searchResult.id, season);
        } catch {
            animeInfo = null;
        }
    }

    if (!animeInfo) {
        animeInfo = buildAnimeInfoFromSearchResult(searchResult);
    }

    return normalizeProviderFields(animeInfo, currentProvider.name);
}

async function resolveAnimeInfoWithProvider(
    currentProvider: AnimeProvider,
    title: string,
    season: number | null,
    episode: number | null
): Promise<AnimeInfo | null> {
    const context: AnimeResolutionContext = {
        requestedTitle: title,
        season,
        episode,
    };

    const queries = buildResolutionSearchQueries(title, season);
    const scoredCandidates: ScoredResolutionCandidate[] = [];

    for (const query of queries) {
        const searchResult = await currentProvider.searchAnime(query);
        if (!searchResult) {
            continue;
        }

        const animeInfo = await resolveAnimeInfoFromSearchResult(currentProvider, searchResult, season, query);
        if (!animeInfo) {
            continue;
        }

        const candidateTitles = collectCandidateTitles(searchResult, animeInfo);
        const queryIncludesSeasonHint = Boolean(
            season
            && season > 1
            && hasExplicitSeasonHint(query, season)
        );
        const hasMatchingSeasonMarker = Boolean(
            season
            && season > 1
            && candidateTitles.some(
                (candidateTitle) => extractSeasonNumberFromTitle(candidateTitle) === season
            )
        );
        const score = scoreResolvedAnimeCandidate(searchResult, animeInfo, context, query);
        scoredCandidates.push({
            animeInfo,
            score,
            seasonFamilyKey: getSeasonFamilyKey(candidateTitles),
            hasSplitCourMarker: candidateTitles.some((candidateTitle) => hasPartMarker(candidateTitle)),
            hasMatchingSeasonMarker,
            hasConflictingSeasonMarker: Boolean(
                season
                && season > 1
                && hasConflictingSeasonMarkerForContext(candidateTitles, season)
            ),
            isEpisodeCompatible: isEpisodeCompatibleWithAnime(animeInfo, season, episode),
            hasEpisodeCountEvidence: Boolean(
                episode
                && episode > 0
                && typeof animeInfo.total_episodes === "number"
                && animeInfo.total_episodes >= episode
            ),
            queryIncludesSeasonHint,
        });
    }

    if (scoredCandidates.length === 0) {
        return null;
    }

    const rankedCandidates = applySplitCourSeasonFamilyHeuristic(scoredCandidates, context);
    let bestMatch: ScoredResolutionCandidate | null = null;

    for (const candidate of rankedCandidates) {
        if (!bestMatch || candidate.score > bestMatch.score) {
            bestMatch = candidate;
        }
    }

    if (!bestMatch) {
        return null;
    }

    if (isSeasonQuerySplitCourDriftCandidate(bestMatch, rankedCandidates, context)) {
        return null;
    }

    if (!bestMatch.isEpisodeCompatible) {
        return null;
    }

    return bestMatch.animeInfo;
}

function buildAnimeInfoFromSearchResult(searchResult: AnimeSearchResult): AnimeInfo {
    return {
        id: searchResult.id,
        title_english: searchResult.title_english,
        title_romaji: searchResult.title,
        cover_url: searchResult.coverImage,
    };
}

function getCachePath(): string {
    const cacheDir = path.join(process.cwd(), ".anime_cache");
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    return path.join(cacheDir, "anime_cache.json");
}

function loadCache(): void {
    try {
        const cachePath = getCachePath();
        if (fs.existsSync(cachePath)) {
            const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            const now = Date.now();
            let expiredCount = 0;
            let incompatibleKeyCount = 0;
            for (const [key, value] of Object.entries(data)) {
                const parsedCacheKey = parseCacheKey(key);
                if (!parsedCacheKey || parsedCacheKey.isLegacy) {
                    incompatibleKeyCount++;
                    continue;
                }

                const entry = value as CacheEntry;
                // Only load entries that are not expired
                if (isCacheEntryValid(entry, now)) {
                    cache.set(key, entry);
                } else {
                    expiredCount++;
                }
            }
            if (expiredCount > 0) {
                console.log(`[Anime] Cleaned ${expiredCount} expired cache entries`);
            }

            if (incompatibleKeyCount > 0) {
                console.log(`[Anime] Ignored ${incompatibleKeyCount} legacy/incompatible cache entries`);
            }

            if (expiredCount > 0 || incompatibleKeyCount > 0) {
                // Save immediately to persist the cleanup
                saveCache();
            }
        }
    } catch (e) {
        console.error("[Anime] Error loading cache:", e);
    }
}

function saveCache(): void {
    try {
        const cachePath = getCachePath();
        const data: Record<string, CacheEntry> = {};
        const now = Date.now();
        // Only save entries that are still valid
        cache.forEach((value, key) => {
            if (isCacheEntryValid(value, now)) {
                data[key] = value;
            }
        });
        fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("[Anime] Error saving cache:", e);
    }
}

loadCache();

function getCacheKey(title: string, season: number | null, episode: number | null): string {
    const normalizedSeason = season ?? 1;
    const normalizedEpisode = episode && episode > 0 ? episode : "any";
    return `${provider.name}:${title.toLowerCase()}:${normalizedSeason}:${normalizedEpisode}`;
}

function normalizeEpisodeTitleValue(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
}

export function buildFallbackSearchCandidates(
    animeTitle: string,
    season: number | null,
    animeInfo: Pick<AnimeInfo, "title_romaji" | "title_english">
): string[] {
    const parsedTitle = animeTitle.trim();
    const shouldAppendSeasonCandidate = Boolean(
        season
        && season > 1
        && parsedTitle
        && !hasExplicitSeasonHint(parsedTitle, season)
    );

    const rawCandidates: Array<string | null | undefined> = [
        parsedTitle,
        shouldAppendSeasonCandidate ? `${parsedTitle} season ${season}` : null,
        animeInfo.title_romaji,
        animeInfo.title_english,
    ];

    const seen = new Set<string>();
    const candidates: string[] = [];

    for (const candidate of rawCandidates) {
        const trimmed = candidate?.trim();
        if (!trimmed) {
            continue;
        }

        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        candidates.push(trimmed);
    }

    return candidates;
}

/**
 * Get anime info including cover and titles
 */
export async function getAnimeInfo(
    title: string,
    season: number | null = null,
    episode: number | null = null
): Promise<AnimeInfo | null> {
    // Don't search for titles that are too short or just contain numbers
    // Minimum 3 words or 10 characters to avoid false matches like "strange" → "Orange"
    const wordCount = title.split(/\s+/).filter(w => w.length > 0).length;
    const isValidLength = title.length >= 10 || wordCount >= 2;
    if (!isValidLength || /^[\d.\-_\s]+$/.test(title)) {
        return null;
    }

    const cacheKey = getCacheKey(title, season, episode);

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && isCacheEntryValid(cached)) {
        if (cached.data) {
            const normalizedCached = normalizeProviderFields(cached.data, cached.sourceProvider ?? provider.name);
            if (!isEpisodeCompatibleWithAnime(normalizedCached, season, episode)) {
                cache.delete(cacheKey);
                saveCache();
            } else {
                if (normalizedCached !== cached.data) {
                    cache.set(cacheKey, {
                        data: normalizedCached,
                        timestamp: cached.timestamp,
                        sourceProvider: cached.sourceProvider,
                    });
                    saveCache();
                }
                return normalizedCached;
            }
        } else {
            return null;
        }
    }

    let hadProviderError = false;
    let lastNotFoundProvider: string | null = null;

    for (const currentProvider of getProvidersInResolutionOrder()) {
        try {
            const animeInfo = await resolveAnimeInfoWithProvider(currentProvider, title, season, episode);
            if (!animeInfo) {
                lastNotFoundProvider = currentProvider.name;
                continue;
            }

            cache.set(cacheKey, {
                data: animeInfo,
                timestamp: Date.now(),
                sourceProvider: currentProvider.name,
            });
            saveCache();

            return animeInfo;
        } catch {
            hadProviderError = true;
            if (config.debug) {
                console.log(`[Anime] ${currentProvider.name} failed while resolving anime info, trying next provider`);
            }
        }
    }

    if (hadProviderError) {
        console.error("[Anime] Error getting anime info: all providers failed");
        return null;
    }

    cache.set(cacheKey, {
        data: null,
        timestamp: Date.now(),
        sourceProvider: lastNotFoundProvider || "resolution-exhausted",
    });
    saveCache();
    return null;
}

/**
 * Get episode title (with fallback to Jikan if primary provider fails)
 */
export async function getEpisodeTitle(
    animeTitle: string,
    season: number | null,
    episode: number
): Promise<string | null> {
        try {
            const animeInfo = await getAnimeInfo(animeTitle, season, episode);
            if (!animeInfo) return null;

            if (!isEpisodeCompatibleWithAnime(animeInfo, season, episode)) {
                if (config.debug) {
                    console.log(
                        `[Anime] Skipping episode fallback: resolved anime total episodes (${animeInfo.total_episodes}) is lower than requested episode ${episode}`
                    );
                }
                return null;
            }

            const episodeLookupContext = {
                searchTitle: animeTitle,
                canonicalTitles: [animeInfo.title_english, animeInfo.title_romaji].filter(
                    (value): value is string => Boolean(value)
                ),
                allowSeasonInference: season === null || season <= 1,
            };

            const episodeCacheKey = `${provider.name}:${animeInfo.id}:${season ?? 1}:${episode}`;
            if (episodeCache.has(episodeCacheKey)) {
                return episodeCache.get(episodeCacheKey) ?? null;
            }

        // Try primary provider first
            let title: string | null = null;
            try {
                title = normalizeEpisodeTitleValue(
                    await provider.getEpisodeTitle(
                        animeInfo.id,
                        episode,
                        season ?? undefined,
                        episodeLookupContext
                    )
                );
            } catch {
                if (config.debug) {
                    console.log(`[Anime] ${provider.name} failed while fetching episode title, trying fallbacks`);
                }
            }

        // Try fallback providers if primary has no episode data
        if (!title && fallbackProviders.length > 0) {
            console.log(`[Anime] ${provider.name} has no episode data, trying fallbacks...`);

            for (const fallback of fallbackProviders) {
                console.log(`[Anime] Trying ${fallback.name} fallback...`);

                try {
                    // If we have the MAL ID from AniList, use it directly (works for Jikan)
                    if (fallback.name === "jikan" && animeInfo.mal_id) {
                        title = normalizeEpisodeTitleValue(
                            await fallback.getEpisodeTitle(
                                animeInfo.mal_id,
                                episode,
                                season ?? undefined,
                                episodeLookupContext
                            )
                        );
                    } else {
                        // Fallback: search by title if no MAL ID or not Jikan
                        const searchCandidates = buildFallbackSearchCandidates(animeTitle, season, animeInfo);

                        for (const candidate of searchCandidates) {
                            if (config.debug) {
                                console.log(`[Anime] Trying ${fallback.name} fallback query: "${candidate}"`);
                            }

                            const fallbackAnime = await resolveAnimeInfoWithProvider(
                                fallback,
                                candidate,
                                season,
                                episode
                            );
                            if (!fallbackAnime) {
                                continue;
                            }

                            title = normalizeEpisodeTitleValue(
                                await fallback.getEpisodeTitle(fallbackAnime.id, episode, season ?? undefined, {
                                    ...episodeLookupContext,
                                    searchTitle: candidate,
                                })
                            );
                            if (title) {
                                break;
                            }
                        }
                    }
                } catch {
                    if (config.debug) {
                        console.log(`[Anime] ${fallback.name} fallback failed, trying next fallback`);
                    }
                }

                if (title) {
                    console.log(`[Anime] Found episode title via ${fallback.name}`);
                    break;
                }
            }

            if (!title) {
                console.log(`[Anime] No episode data found in any provider`);
            }
        }

        episodeCache.set(episodeCacheKey, title);
        return title;
    } catch {
        return null;
    }
}
