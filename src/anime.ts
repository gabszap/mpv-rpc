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

async function resolveAnimeInfoWithProvider(
    currentProvider: AnimeProvider,
    title: string,
    season: number | null
): Promise<AnimeInfo | null> {
    const searchResult = await currentProvider.searchAnime(title);
    if (!searchResult) {
        return null;
    }

    let animeInfo: AnimeInfo | null;

    if (season && season > 1) {
        animeInfo = await currentProvider.findSeasonAnime(searchResult.id, season);
    } else {
        animeInfo = await currentProvider.getAnimeById(searchResult.id);
    }

    if (!animeInfo) {
        animeInfo = buildAnimeInfoFromSearchResult(searchResult);
    }

    return normalizeProviderFields(animeInfo, currentProvider.name);
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
            for (const [key, value] of Object.entries(data)) {
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

function getCacheKey(title: string, season: number | null): string {
    return `${provider.name}:${title.toLowerCase()}:${season ?? 1}`;
}

export function buildFallbackSearchCandidates(
    animeTitle: string,
    season: number | null,
    animeInfo: Pick<AnimeInfo, "title_romaji" | "title_english">
): string[] {
    const parsedTitle = animeTitle.trim();

    const rawCandidates: Array<string | null | undefined> = [
        parsedTitle,
        season && season > 1 && parsedTitle ? `${parsedTitle} season ${season}` : null,
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
export async function getAnimeInfo(title: string, season: number | null = null): Promise<AnimeInfo | null> {
    // Don't search for titles that are too short or just contain numbers
    // Minimum 3 words or 10 characters to avoid false matches like "strange" → "Orange"
    const wordCount = title.split(/\s+/).filter(w => w.length > 0).length;
    const isValidLength = title.length >= 10 || wordCount >= 2;
    if (!isValidLength || /^[\d.\-_\s]+$/.test(title)) {
        return null;
    }

    const cacheKey = getCacheKey(title, season);

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && isCacheEntryValid(cached)) {
        if (cached.data) {
            const normalizedCached = normalizeProviderFields(cached.data, cached.sourceProvider ?? provider.name);
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
        return null;
    }

    let hadProviderError = false;
    let lastNotFoundProvider: string | null = null;

    for (const currentProvider of getProvidersInResolutionOrder()) {
        try {
            const animeInfo = await resolveAnimeInfoWithProvider(currentProvider, title, season);
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
            const animeInfo = await getAnimeInfo(animeTitle, season);
            if (!animeInfo) return null;

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
                title = await provider.getEpisodeTitle(
                    animeInfo.id,
                    episode,
                    season ?? undefined,
                    episodeLookupContext
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
                        title = await fallback.getEpisodeTitle(
                            animeInfo.mal_id,
                            episode,
                            season ?? undefined,
                            episodeLookupContext
                        );
                    } else {
                        // Fallback: search by title if no MAL ID or not Jikan
                        const searchCandidates = buildFallbackSearchCandidates(animeTitle, season, animeInfo);

                        for (const candidate of searchCandidates) {
                            if (config.debug) {
                                console.log(`[Anime] Trying ${fallback.name} fallback query: "${candidate}"`);
                            }

                            const searchResult = await fallback.searchAnime(candidate);
                            if (!searchResult) {
                                continue;
                            }

                            title = await fallback.getEpisodeTitle(searchResult.id, episode, season ?? undefined, {
                                ...episodeLookupContext,
                                searchTitle: candidate,
                            });
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
