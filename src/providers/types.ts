/**
 * Common types and interfaces for anime metadata providers
 */

import * as fs from "fs";
import * as path from "path";

export interface AnimeInfo {
    id: number;                    // Provider-specific ID (MAL ID or AniList ID)
    title_english: string | null;
    title_romaji: string;
    cover_url: string | null;
}

export interface AnimeSearchResult {
    id: number;
    title: string;
    title_english: string | null;
    type: string;                  // TV, Movie, OVA, etc.
    coverImage: string | null;
}

export interface AnimeProvider {
    readonly name: string;

    /**
     * Search for anime by title
     */
    searchAnime(title: string): Promise<AnimeSearchResult | null>;

    /**
     * Get full anime info by ID
     */
    getAnimeById(id: number): Promise<AnimeInfo | null>;

    /**
     * Get episode title
     */
    getEpisodeTitle(animeId: number, episode: number): Promise<string | null>;

    /**
     * Find the correct season through relations
     */
    findSeasonAnime(baseId: number, targetSeason: number): Promise<AnimeInfo | null>;
}

/**
 * Log API call for debugging - unified function for all providers
 */
export function logApiCall(
    provider: string,
    endpoint: string,
    params: Record<string, any> | undefined,
    status: string,
    result: string
): void {
    try {
        const cacheDir = path.join(process.cwd(), ".anime_cache");
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const logPath = path.join(cacheDir, "api_log.txt");

        const now = new Date();
        const timestamp = now.getFullYear() + "-" +
            String(now.getMonth() + 1).padStart(2, "0") + "-" +
            String(now.getDate()).padStart(2, "0") + " " +
            String(now.getHours()).padStart(2, "0") + ":" +
            String(now.getMinutes()).padStart(2, "0") + ":" +
            String(now.getSeconds()).padStart(2, "0");

        const paramsStr = params ? JSON.stringify(params) : "{}";
        const logLine = `[${timestamp}] ${status} | ${provider}:${endpoint} | params: ${paramsStr} | result: ${result}\n`;
        fs.appendFileSync(logPath, logLine);
    } catch {
        // Ignore log errors
    }
}
