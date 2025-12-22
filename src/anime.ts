/**
 * Anime Metadata Module - Uses configured provider to fetch metadata
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { JikanProvider } from "./providers/jikan";
import { AniListProvider } from "./providers/anilist";
import { KitsuProvider } from "./providers/kitsu";
import type { AnimeProvider, AnimeInfo } from "./providers/types";

// Re-export AnimeInfo type for other modules
export type { AnimeInfo } from "./providers/types";

// Select provider based on config
function createProvider(): AnimeProvider {
    switch (config.metadataProvider) {
        case "anilist":
            return new AniListProvider();
        case "kitsu":
            return new KitsuProvider();
        default:
            return new JikanProvider();
    }
}

const provider = createProvider();

// Export provider name for logging
export const providerName = provider.name;

// Cache
interface CacheEntry {
    data: AnimeInfo | null;
    timestamp: number;
}

const cache: Map<string, CacheEntry> = new Map();
const episodeCache: Map<string, string | null> = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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
            for (const [key, value] of Object.entries(data)) {
                cache.set(key, value as CacheEntry);
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
        cache.forEach((value, key) => {
            data[key] = value;
        });
        fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("[Anime] Error saving cache:", e);
    }
}

loadCache();

function getCacheKey(title: string, season: number | null): string {
    return `${config.metadataProvider}:${title.toLowerCase()}:${season ?? 1}`;
}

/**
 * Get anime info including cover and titles
 */
export async function getAnimeInfo(title: string, season: number | null = null): Promise<AnimeInfo | null> {
    const cacheKey = getCacheKey(title, season);

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }

    try {
        // Search for anime
        const searchResult = await provider.searchAnime(title);
        if (!searchResult) {
            cache.set(cacheKey, { data: null, timestamp: Date.now() });
            saveCache();
            return null;
        }

        let animeInfo: AnimeInfo | null;

        // If season > 1, find correct season through relations
        if (season && season > 1) {
            animeInfo = await provider.findSeasonAnime(searchResult.id, season);
        } else {
            animeInfo = await provider.getAnimeById(searchResult.id);
        }

        if (!animeInfo) {
            // Fallback to search result data
            animeInfo = {
                id: searchResult.id,
                title_english: searchResult.title_english,
                title_romaji: searchResult.title,
                cover_url: searchResult.coverImage,
            };
        }

        // Cache result
        cache.set(cacheKey, { data: animeInfo, timestamp: Date.now() });
        saveCache();

        return animeInfo;
    } catch (e) {
        console.error("[Anime] Error getting anime info:", e);
        return null;
    }
}

/**
 * Get episode title
 */
export async function getEpisodeTitle(
    animeTitle: string,
    season: number | null,
    episode: number
): Promise<string | null> {
    try {
        const animeInfo = await getAnimeInfo(animeTitle, season);
        if (!animeInfo) return null;

        const episodeCacheKey = `${config.metadataProvider}:${animeInfo.id}:${episode}`;
        if (episodeCache.has(episodeCacheKey)) {
            return episodeCache.get(episodeCacheKey) ?? null;
        }

        const title = await provider.getEpisodeTitle(animeInfo.id, episode);
        episodeCache.set(episodeCacheKey, title);
        return title;
    } catch {
        return null;
    }
}
