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
import type { AnimeProvider, AnimeInfo, AnimeSearchResult, SequelInfo, OverflowResult } from "./providers/types";

// Re-export types for other modules
export type { AnimeInfo, OverflowResult } from "./providers/types";

/**
 * Result of anime info resolution that includes the source provider name.
 * Use this when you need to know which provider resolved the anime info,
 * e.g. for overflow resolution where the provider must match the anime ID namespace.
 */
export interface AnimeInfoResult {
    animeInfo: AnimeInfo;
    sourceProvider: string;
}

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
const overflowCache: Map<string, { result: OverflowResult; timestamp: number }> = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const NEGATIVE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes for not-found results
const OVERFLOW_CACHE_TTL = 30 * 60 * 1000; // 30 minutes for overflow resolution



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
    // When season > 1, try searching with season included first
    // This handles cases where the sequel chain is broken or titles don't have explicit season numbers
    if (season && season > 1) {
        const seasonSearchTitle = `${title} Season ${season}`;
        const seasonSearchResult = await currentProvider.searchAnime(seasonSearchTitle, season);
        if (seasonSearchResult) {
            const animeInfo = await currentProvider.getAnimeById(seasonSearchResult.id);
            if (animeInfo) {
                return normalizeProviderFields(animeInfo, currentProvider.name);
            }
        }
    }

    // Fallback: search by title alone and traverse sequel chain
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

function getOverflowCacheKey(animeId: number, episode: number, providerName?: string): string {
    return `${providerName || "unknown"}:${animeId}:${episode}`;
}

/**
 * Resolve an episode that overflows the current anime's episode count.
 *
 * When episode > total_episodes, walks the sequel chain to find the correct
 * cour and adjusted episode number. For example, if "Dr. Stone: New World"
 * has 11 episodes and the user is watching Episode 12, this resolves to
 * "Dr. Stone: New World Part 2" Episode 1.
 *
 * @param animeInfo - The originally resolved anime info
 * @param episode - The episode number from the filename
 * @param season - The season number from the filename (may be null)
 * @returns OverflowResult if overflow was resolved, null if no overflow needed
 */
export async function resolveOverflowEpisode(
    animeInfo: AnimeInfo,
    episode: number,
    season: number | null,
    sourceProviderName?: string
): Promise<OverflowResult | null> {
    // Can't determine overflow without episode count
    if (!animeInfo.total_episodes || animeInfo.total_episodes <= 0) {
        return null;
    }

    // No overflow needed — episode fits within current anime
    if (episode <= animeInfo.total_episodes) {
        return null;
    }

    // Check overflow cache for previously resolved results
    const cacheKey = getOverflowCacheKey(animeInfo.id, episode, sourceProviderName);
    const cachedEntry = overflowCache.get(cacheKey);
    if (cachedEntry && Date.now() - cachedEntry.timestamp < OVERFLOW_CACHE_TTL) {
        return cachedEntry.result;
    }

    const MAX_DEPTH = 5;
    const visited = new Set<number>();
    let currentAnime = animeInfo;
    let remainingEpisode = episode;
    let depth = 0;
    // Seed with the provider that originally resolved the anime info
    let lastSequelProvider: AnimeProvider | null = sourceProviderName
        ? getProvidersInResolutionOrder().find(p => p.name === sourceProviderName) || null
        : null;

    while (remainingEpisode > (currentAnime.total_episodes || 0) && depth < MAX_DEPTH) {
        // Cycle detection
        if (visited.has(currentAnime.id)) {
            if (config.debug) {
                console.log(`[Anime] Overflow resolution: cycle detected at ID ${currentAnime.id}, stopping`);
            }
            break;
        }
        visited.add(currentAnime.id);

        // Only use the provider that owns the current anime ID for sequel lookup.
        // Other providers would need a title-based search since IDs are provider-specific.
        // If the source provider is known but unavailable, skip the lookup entirely
        // rather than passing a foreign ID to other providers.
        let sequelInfo: SequelInfo | null = null;
        let sequelProvider: AnimeProvider | null = null;

        let sequelLookupProviders: AnimeProvider[];
        if (lastSequelProvider) {
            sequelLookupProviders = [lastSequelProvider];
        } else if (sourceProviderName) {
            const sourceProvider = getProvidersInResolutionOrder().find(p => p.name === sourceProviderName);
            if (sourceProvider) {
                sequelLookupProviders = [sourceProvider];
                lastSequelProvider = sourceProvider;
            } else {
                // Source provider is known but unavailable — skip cross-provider ID lookup
                if (config.debug) {
                    console.log(`[Anime] Overflow resolution: source provider "${sourceProviderName}" is not available, skipping sequel lookup`);
                }
                break;
            }
        } else {
            sequelLookupProviders = getProvidersInResolutionOrder();
        }

        for (const currentProvider of sequelLookupProviders) {
            try {
                sequelInfo = await currentProvider.getSequelInfo(currentAnime.id);
                if (sequelInfo) {
                    sequelProvider = currentProvider;
                    break;
                }
            } catch {
                if (config.debug) {
                    console.log(`[Anime] Overflow resolution: ${currentProvider.name} failed to get sequel for ID ${currentAnime.id}`);
                }
            }
        }

        if (!sequelInfo) {
            if (config.debug) {
                console.log(`[Anime] Overflow resolution: no sequel found for "${currentAnime.title_romaji}" (ID: ${currentAnime.id})`);
            }
            break;
        }

        // Subtract current anime's episodes from remaining count
        remainingEpisode -= (currentAnime.total_episodes || 0);
        depth++;

        if (config.debug) {
            console.log(`[Anime] Overflow resolution: step ${depth}, "${sequelInfo.title_romaji}" (ID: ${sequelInfo.id}), remaining episode: ${remainingEpisode}, is_split_cour: ${sequelInfo.is_split_cour}`);
        }

        // Get full AnimeInfo for the sequel
        // Only use the provider that owns the sequel ID for direct lookups.
        // Other providers would need a title-based search since IDs are provider-specific.
        let sequelAnime: AnimeInfo | null = null;
        const sequelAnimeProviders = sequelProvider
            ? [sequelProvider]
            : getProvidersInResolutionOrder();

        for (const currentProvider of sequelAnimeProviders) {
            try {
                sequelAnime = await currentProvider.getAnimeById(sequelInfo.id);
                if (sequelAnime) {
                    // Normalize MAL ID
                    sequelAnime = normalizeProviderFields(sequelAnime, currentProvider.name);
                    break;
                }
            } catch {
                // Try next provider
            }
        }

        if (!sequelAnime) {
            if (config.debug) {
                console.log(`[Anime] Overflow resolution: could not get full info for sequel ID ${sequelInfo.id}`);
            }
            break;
        }

        currentAnime = sequelAnime;
        lastSequelProvider = sequelProvider;

        // If remaining episode fits within this sequel, we found the right cour
        if (currentAnime.total_episodes && remainingEpisode <= currentAnime.total_episodes) {
            console.log(`[Anime] Overflow resolved: "${animeInfo.title_romaji}" EP ${episode} → "${currentAnime.title_romaji}" EP ${remainingEpisode} (depth: ${depth})`);
            const result: OverflowResult = {
                animeInfo: currentAnime,
                adjustedEpisode: remainingEpisode,
                originalEpisode: episode,
                overflowDepth: depth,
                sourceProvider: lastSequelProvider?.name,
            };
            overflowCache.set(cacheKey, { result, timestamp: Date.now() });
            return result;
        }

        // If this sequel has no episode count, we can't continue resolving
        if (!currentAnime.total_episodes || currentAnime.total_episodes <= 0) {
            if (config.debug) {
                console.log(`[Anime] Overflow resolution: sequel "${currentAnime.title_romaji}" has no episode count, stopping`);
            }
            break;
        }
    }

    // Could not fully resolve the overflow
    // Return the last known anime with the remaining episode count
    // This is better than returning null — at least we tried
    if (depth > 0 && remainingEpisode > 0) {
        console.log(`[Anime] Overflow resolution: could not fully resolve "${animeInfo.title_romaji}" EP ${episode}, best guess: "${currentAnime.title_romaji}" EP ${remainingEpisode}`);
        const result: OverflowResult = {
            animeInfo: currentAnime,
            adjustedEpisode: remainingEpisode,
            originalEpisode: episode,
            overflowDepth: depth,
            sourceProvider: lastSequelProvider?.name,
        };
        overflowCache.set(cacheKey, { result, timestamp: Date.now() });
        return result;
    }

    return null;
}

/**
 * Get anime info including cover and titles, along with the provider that resolved it.
 *
 * This is the preferred way to get anime info when overflow resolution will be
 * needed, because it returns the source provider alongside the anime info —
 * eliminating the race condition that occurs when module-level mutable state
 * is overwritten by concurrent async calls.
 */
export async function getAnimeInfoWithProvider(title: string, season: number | null = null): Promise<AnimeInfoResult | null> {
    // Don't search for titles that are too short or just contain numbers
    // Minimum 2 words or 10 characters to avoid false matches like "strange" → "Orange"
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
            const sourceProvider = cached.sourceProvider ?? provider.name;
            const normalizedCached = normalizeProviderFields(cached.data, sourceProvider);
            if (normalizedCached !== cached.data) {
                cache.set(cacheKey, {
                    data: normalizedCached,
                    timestamp: cached.timestamp,
                    sourceProvider,
                });
                saveCache();
            }
            return { animeInfo: normalizedCached, sourceProvider };
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

            return { animeInfo, sourceProvider: currentProvider.name };
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
 * Get anime info including cover and titles.
 *
 * For cases where you also need the source provider (e.g. for overflow resolution),
 * prefer getAnimeInfoWithProvider() to avoid provider-ID mismatch race conditions.
 */
export async function getAnimeInfo(title: string, season: number | null = null): Promise<AnimeInfo | null> {
    const result = await getAnimeInfoWithProvider(title, season);
    return result ? result.animeInfo : null;
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
        const animeResult = await getAnimeInfoWithProvider(animeTitle, season);
        if (!animeResult) return null;

        const { animeInfo, sourceProvider } = animeResult;

        const episodeLookupContext = {
            searchTitle: animeTitle,
            canonicalTitles: [animeInfo.title_english, animeInfo.title_romaji].filter(
                (value): value is string => Boolean(value)
            ),
            allowSeasonInference: season === null || season <= 1,
        };

        const episodeCacheKey = `${sourceProvider || provider.name}:${animeInfo.id}:${season ?? 1}:${episode}`;
        if (episodeCache.has(episodeCacheKey)) {
            return episodeCache.get(episodeCacheKey) ?? null;
        }

        // Only use the provider that owns the anime ID for direct lookups.
        // Other providers would need a title-based search first since IDs are provider-specific.
        let title: string | null = null;
        let overflowResult: OverflowResult | null = null;
        const sourceProviderObj = sourceProvider
            ? getProvidersInResolutionOrder().find(p => p.name === sourceProvider)
            : null;

        // Only use the provider that owns the anime ID for direct lookups.
        // Other providers would need a title-based search first since IDs are provider-specific.
        // If the source provider is known but unavailable, skip the direct lookup entirely.
        let episodeProviders: AnimeProvider[];
        if (sourceProviderObj && sourceProviderObj.name !== provider.name) {
            episodeProviders = [sourceProviderObj];  // Only try the source provider — it owns the ID
        } else if (sourceProvider && !sourceProviderObj) {
            // Source provider is known but unavailable — skip direct ID lookup
            episodeProviders = [];
        } else {
            episodeProviders = [provider];
        }

        for (const epProvider of episodeProviders) {
            try {
                title = await epProvider.getEpisodeTitle(
                    animeInfo.id,
                    episode,
                    season ?? undefined,
                    episodeLookupContext
                );
                if (title) break;
            } catch {
                if (config.debug) {
                    console.log(`[Anime] ${epProvider.name} failed while fetching episode title`);
                }
            }
        }

        // Try overflow resolution if episode exceeds total episodes
        if (!title && animeInfo.total_episodes && episode > animeInfo.total_episodes) {
            overflowResult = await resolveOverflowEpisode(animeInfo, episode, season, sourceProvider);
            if (overflowResult) {
                // Only use the provider that owns the overflow anime ID for direct lookups.
                // Other providers would need a title-based search first since IDs are provider-specific.
                const resolved = overflowResult;
                const overflowSourceProvider = resolved.sourceProvider
                    ? getProvidersInResolutionOrder().find(p => p.name === resolved.sourceProvider)
                    : null;

                const overflowProviders: AnimeProvider[] = overflowSourceProvider
                    ? [overflowSourceProvider]
                    : [provider];

                const overflowAnimeId = resolved.animeInfo.id;
                const overflowEpisode = resolved.adjustedEpisode;

                for (const overflowProvider of overflowProviders) {
                    try {
                        title = await overflowProvider.getEpisodeTitle(
                            overflowAnimeId,
                            overflowEpisode,
                            season ?? undefined,
                            episodeLookupContext
                        );
                        if (title) break;
                    } catch {
                        if (config.debug) {
                            console.log(`[Anime] ${overflowProvider.name} failed while fetching overflow episode title`);
                        }
                    }
                }

                if (title) {
                    console.log(`[Anime] Found episode title via overflow resolution: "${overflowResult.animeInfo.title_romaji}" EP ${overflowResult.adjustedEpisode}`);
                    episodeCache.set(episodeCacheKey, title);
                    return title;
                }
            }
        }

        // Use overflow-adjusted info for fallback lookups if available
        const effectiveAnimeInfo = overflowResult?.animeInfo ?? animeInfo;
        const effectiveEpisode = overflowResult?.adjustedEpisode ?? episode;

        // Try fallback providers only if we don't know the source provider
        // (if source is known but unavailable, fallback IDs would be in the wrong namespace)
        if (!title && fallbackProviders.length > 0) {
            if (sourceProvider && !sourceProviderObj) {
                if (config.debug) {
                    console.log(`[Anime] Skipping fallback episode title lookup — source provider "${sourceProvider}" is unavailable`);
                }
            } else {
                console.log(`[Anime] ${provider.name} has no episode data, trying fallbacks...`);

                for (const fallback of fallbackProviders) {
                    console.log(`[Anime] Trying ${fallback.name} fallback...`);

                    try {
                        // If we have the MAL ID from AniList, use it directly (works for Jikan)
                        if (fallback.name === "jikan" && effectiveAnimeInfo.mal_id) {
                            title = await fallback.getEpisodeTitle(
                                effectiveAnimeInfo.mal_id,
                                effectiveEpisode,
                                season ?? undefined,
                                episodeLookupContext
                            );
                        } else {
                            // Fallback: search by title if no MAL ID or not Jikan
                            const searchCandidates = buildFallbackSearchCandidates(animeTitle, season, effectiveAnimeInfo);

                            for (const candidate of searchCandidates) {
                                if (config.debug) {
                                    console.log(`[Anime] Trying ${fallback.name} fallback query: "${candidate}"`);
                                }

                                const searchResult = await fallback.searchAnime(candidate);
                                if (!searchResult) {
                                    continue;
                                }

                                title = await fallback.getEpisodeTitle(searchResult.id, effectiveEpisode, season ?? undefined, {
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
        }

        episodeCache.set(episodeCacheKey, title);
        return title;
    } catch {
        return null;
    }
}
