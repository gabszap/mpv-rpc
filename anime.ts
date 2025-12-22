/**
 * Jikan API Module - Fetches anime metadata from MyAnimeList
 */

import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config";

interface AnimeInfo {
    mal_id: number;
    title_english: string | null;
    title_romaji: string;
    cover_url: string | null;
}

interface CacheEntry {
    data: AnimeInfo | null;
    timestamp: number;
}

// In-memory cache
const cache: Map<string, CacheEntry> = new Map();
const episodeCache: Map<string, string | null> = new Map(); // Cache for episode titles
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiting
let lastRequestTime = 0;

/**
 * Load persistent cache from file
 */
function getCachePath(): string {
    const cacheDir = path.join(process.cwd(), ".anime_cache");
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    return path.join(cacheDir, "anime_cache.json");
}

function getLogPath(): string {
    const cacheDir = path.join(process.cwd(), ".anime_cache");
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    return path.join(cacheDir, "api_log.txt");
}

/**
 * Log API call for debugging
 */
function logApiCall(endpoint: string, params: Record<string, any> | undefined, status: string, result: string): void {
    try {
        const logPath = getLogPath();
        // Format: [YYYY-MM-DD HH:mm:ss]
        const now = new Date();
        const timestamp = now.getFullYear() + "-" +
            String(now.getMonth() + 1).padStart(2, "0") + "-" +
            String(now.getDate()).padStart(2, "0") + " " +
            String(now.getHours()).padStart(2, "0") + ":" +
            String(now.getMinutes()).padStart(2, "0") + ":" +
            String(now.getSeconds()).padStart(2, "0");
        const paramsStr = params ? JSON.stringify(params) : "{}";
        const logLine = `[${timestamp}] ${status} | ${endpoint} | params: ${paramsStr} | result: ${result}\n`;
        fs.appendFileSync(logPath, logLine);
    } catch (e) {
        // Ignore log errors
    }
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

// Load cache on startup
loadCache();

/**
 * Get cache key from title and season
 */
function getCacheKey(title: string, season: number | null): string {
    return `${title.toLowerCase()}:${season ?? 1}`;
}

/**
 * Make a request to Jikan API with rate limiting
 */
async function jikanRequest(endpoint: string, params?: Record<string, any>, retryCount = 0): Promise<any> {
    // Rate limiting
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < config.jikan.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, config.jikan.minRequestInterval - elapsed));
    }
    lastRequestTime = Date.now();

    try {
        const response = await axios.get(`${config.jikan.baseUrl}${endpoint}`, {
            params,
            timeout: 10000, // 10 second timeout
        });
        // Log with status code in front like "200 OK"
        logApiCall(endpoint, params, `${response.status} OK`, "");
        return response.data;
    } catch (e: any) {
        if (e.response?.status === 429) {
            logApiCall(endpoint, params, "429 RATE_LIMITED", "retrying in 1s");
            console.log("[Anime] Rate limited, waiting 1s...");
            await new Promise(resolve => setTimeout(resolve, 1000));
            return jikanRequest(endpoint, params, retryCount);
        }

        // Timeout or network error - retry once
        if ((e.code === "ECONNABORTED" || e.code === "ETIMEDOUT") && retryCount < 1) {
            logApiCall(endpoint, params, "TIMEOUT", "retrying...");
            console.log("[Anime] Request timeout, retrying...");
            await new Promise(resolve => setTimeout(resolve, 500));
            return jikanRequest(endpoint, params, retryCount + 1);
        }

        logApiCall(endpoint, params, "ERROR", e.message || "unknown error");
        throw e;
    }
}

/**
 * Search for an anime by title
 */
async function searchAnime(title: string): Promise<any | null> {
    try {
        const response = await jikanRequest("/anime", {
            q: title,
            limit: 10,
            sfw: true,
            order_by: "members",
            sort: "desc",
        });

        if (!response.data || response.data.length === 0) {
            logApiCall("/anime", { q: title }, "DETAIL", "0 results");
            return null;
        }

        // Log search results like Python did
        const results = response.data;
        const resultList = results.map((a: any) => `${a.mal_id}: ${a.title}`).join("', '");
        logApiCall("/anime", { q: title }, "DETAIL", `${results.length} results: ['${resultList}']`);

        const titleLower = title.toLowerCase();

        // Prefer exact matches or matches that start with the search term
        for (const anime of results) {
            const romaji = (anime.title || "").toLowerCase();
            const english = (anime.title_english || "").toLowerCase();

            if (romaji === titleLower || english === titleLower) {
                return anime; // Exact match
            }
            if (romaji.startsWith(titleLower) || english.startsWith(titleLower)) {
                return anime; // Starts with match
            }
        }

        // Filter out spin-offs (Chibi, Theatre, Special, etc.)
        const spinoffPatterns = /chibi|theatre|theater|special|tebie|caidan|petit|mini/i;
        const mainResults = results.filter((a: any) => {
            const t = (a.title || "").toLowerCase();
            return !spinoffPatterns.test(t);
        });
        const candidates = mainResults.length > 0 ? mainResults : results;

        // Prefer TV/ONA over Movie/OVA for main series
        const tvResult = candidates.find((a: any) => a.type === "TV" || a.type === "ONA");
        if (tvResult) return tvResult;

        // Return most popular (first)
        return candidates[0];
    } catch (e) {
        console.error("[Anime] Search error:", e);
        return null;
    }
}

/**
 * Get anime relations (sequels, prequels, etc.)
 */
async function getAnimeRelations(malId: number): Promise<any[]> {
    try {
        const response = await jikanRequest(`/anime/${malId}/relations`);
        const relations = response.data || [];
        // Log relations found
        const sequels = relations.filter((r: any) => r.relation === "Sequel");
        if (sequels.length > 0) {
            const sequelNames = sequels.flatMap((s: any) => s.entry.map((e: any) => `${e.name} (${e.type})`));
            logApiCall(`/anime/${malId}/relations`, {}, "DETAIL", `sequels: ${sequelNames.join(", ")}`);
        }
        return relations;
    } catch {
        return [];
    }
}

/**
 * Get anime by MAL ID
 */
async function getAnimeById(malId: number): Promise<any | null> {
    try {
        const response = await jikanRequest(`/anime/${malId}`);
        const anime = response.data || null;
        if (anime) {
            // Log anime details
            const title = anime.title_english || anime.title;
            logApiCall(`/anime/${malId}`, {}, "DETAIL", `"${title}" (${anime.type}, MAL:${anime.mal_id})`);
        }
        return anime;
    } catch {
        return null;
    }
}

/**
 * Extract season number from anime title
 */
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

/**
 * Check if an anime title indicates a "Part" of the same season (not a new season)
 * Examples: "Season 2 Part 2", "2nd Season Part 2", "Cour 2"
 */
function isPartOfSameSeason(title: string): boolean {
    // Match patterns like "Part 2", "Part 3", "Cour 2" etc.
    const partPatterns = [
        /\bpart\s*\d+/i,
        /\bcour\s*\d+/i,
    ];
    for (const pattern of partPatterns) {
        if (pattern.test(title)) return true;
    }
    return false;
}

/**
 * Find the correct season through anime relations
 */
async function findSeasonInRelations(baseAnime: any, targetSeason: number): Promise<any | null> {
    if (targetSeason <= 1) return baseAnime;

    const visited = new Set<number>();
    let current = baseAnime;
    let currentSeason = 1;
    let lastValidResult = baseAnime; // Fallback

    while (current && currentSeason < targetSeason) {
        if (visited.has(current.mal_id)) break;
        visited.add(current.mal_id);

        const relations = await getAnimeRelations(current.mal_id);
        let sequel: any = null;
        for (const relation of relations) {
            if (relation.relation === "Sequel") {
                for (const entry of relation.entry || []) {
                    if (entry.type === "TV") {
                        sequel = entry;
                        break;
                    }
                }
            }
            if (sequel) break;
        }

        // If no TV sequel, try Movie/OVA as intermediate
        if (!sequel) {
            for (const relation of relations) {
                if (relation.relation === "Sequel") {
                    for (const entry of relation.entry || []) {
                        if (entry.type === "Movie" || entry.type === "OVA" || entry.type === "anime") {
                            sequel = entry;
                            break;
                        }
                    }
                }
                if (sequel) break;
            }
        }

        if (!sequel) break;

        current = await getAnimeById(sequel.mal_id);
        if (!current) break;

        const currentTitle = current.title || "";
        const currentEnglishTitle = current.title_english || "";

        const seasonInTitle = extractSeasonNumber(currentTitle) ||
            extractSeasonNumber(currentEnglishTitle);
        if (seasonInTitle === targetSeason) return current;

        // Keep track of last valid result
        lastValidResult = current;

        // Only increment for TV series that are NOT just a "Part" of the same season
        // e.g. "Season 2 Part 2" is NOT a new season, it's the continuation of Season 2
        if (current.type === "TV") {
            const isPart = isPartOfSameSeason(currentTitle) || isPartOfSameSeason(currentEnglishTitle);
            if (!isPart) {
                currentSeason++;
            }
        }
    }
    return currentSeason >= targetSeason ? current : lastValidResult;
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
        let anime = await searchAnime(title);

        if (!anime) {
            cache.set(cacheKey, { data: null, timestamp: Date.now() });
            saveCache();
            return null;
        }

        // If season > 1, find correct season through relations
        if (season && season > 1) {
            const seasonAnime = await findSeasonInRelations(anime, season);
            if (seasonAnime) anime = seasonAnime;
        }

        const info: AnimeInfo = {
            mal_id: anime.mal_id,
            title_english: anime.title_english,
            title_romaji: anime.title,
            cover_url: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
        };

        // Cache result
        cache.set(cacheKey, { data: info, timestamp: Date.now() });
        saveCache();

        return info;
    } catch (e) {
        console.error("[Anime] Error getting anime info:", e);
        return null;
    }
}

/**
 * Get episode title from Jikan API
 */
export async function getEpisodeTitle(
    animeTitle: string,
    season: number | null,
    episode: number
): Promise<string | null> {
    try {
        const animeInfo = await getAnimeInfo(animeTitle, season);
        if (!animeInfo) return null;

        // Check episode cache first
        const episodeCacheKey = `${animeInfo.mal_id}:${episode}`;
        if (episodeCache.has(episodeCacheKey)) {
            return episodeCache.get(episodeCacheKey) ?? null;
        }

        const response = await jikanRequest(`/anime/${animeInfo.mal_id}/episodes/${episode}`);

        if (response.data) {
            const title = response.data.title || response.data.title_romanji || null;
            // Cache the result
            episodeCache.set(episodeCacheKey, title);
            if (title) {
                logApiCall(`/anime/${animeInfo.mal_id}/episodes/${episode}`, {}, "DETAIL", `"${title}"`);
            }
            return title;
        }
        // Cache null result too to avoid repeated requests
        episodeCache.set(episodeCacheKey, null);
        return null;
    } catch (e) {
        // Episode not found or API error
        return null;
    }
}
