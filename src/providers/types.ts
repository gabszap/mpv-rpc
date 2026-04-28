/**
 * Common types and interfaces for anime metadata providers
 */

import * as fs from "fs";
import * as path from "path";

export interface AnimeInfo {
    id: number;                    // Provider-specific ID (MAL ID or AniList ID)
    mal_id?: number;               // MyAnimeList ID (for fallback purposes)
    title_english: string | null;
    title_romaji: string;
    cover_url: string | null;
    total_episodes?: number;       // For MAL sync (mark as completed)
}

export interface AnimeSearchResult {
    id: number;
    title: string;
    title_english: string | null;
    type: string;                  // TV, Movie, OVA, etc.
    coverImage: string | null;
    titles?: Array<{ type: string; title: string }>;
}

export interface EpisodeLookupContext {
    searchTitle?: string;
    canonicalTitles?: string[];
    allowSeasonInference?: boolean;
}

export interface SequelInfo {
    id: number;                    // Provider-specific ID
    mal_id?: number;               // MAL ID (for sync)
    title_romaji: string;
    title_english: string | null;
    total_episodes?: number;       // Episode count of the sequel
    is_split_cour: boolean;        // true if "Part X"/"Cour X" (same logical season)
}

export interface OverflowResult {
    animeInfo: AnimeInfo;         // The resolved anime (may be different from original)
    adjustedEpisode: number;      // Episode number within the resolved anime
    originalEpisode: number;      // Original episode number from filename
    overflowDepth: number;        // How many sequel steps were traversed (0 = no overflow)
    sourceProvider?: string;      // Name of the provider that returned the final sequel info
}

export interface AnimeProvider {
    readonly name: string;

    /**
     * Search for anime by title
     */
    searchAnime(title: string, expectedSeason?: number): Promise<AnimeSearchResult | null>;

    /**
     * Get full anime info by ID
     */
    getAnimeById(id: number): Promise<AnimeInfo | null>;

    /**
     * Get episode title
     */
    getEpisodeTitle(
        animeId: number,
        episode: number,
        season?: number,
        context?: EpisodeLookupContext
    ): Promise<string | null>;

    /**
     * Find the correct season through relations
     */
    findSeasonAnime(baseId: number, targetSeason: number): Promise<AnimeInfo | null>;

    /**
     * Get the next sequel in the franchise chain
     * Returns null if no sequel exists or provider doesn't support sequel traversal
     */
    getSequelInfo(animeId: number): Promise<SequelInfo | null>;
}

interface ProviderErrorLogDetails {
    provider: string;
    operation: string;
    status: number | null;
    code: string | null;
    message: string;
    request: {
        method: string | null;
        url: string | null;
    };
    response: unknown;
    truncated?: boolean;
}

const LOG_MAX_DEPTH = 4;
const LOG_MAX_KEYS = 30;
const LOG_MAX_ARRAY_ITEMS = 20;
const LOG_MAX_STRING_LENGTH = 500;
const LOG_DEFAULT_MAX_LENGTH = 4000;

function truncateString(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    const suffix = `... [truncated ${value.length - maxLength} chars]`;
    return value.slice(0, maxLength) + suffix;
}

function sanitizeErrorValue(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === "string") {
        return truncateString(value, LOG_MAX_STRING_LENGTH);
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }

    if (depth >= LOG_MAX_DEPTH) {
        return "[max-depth-reached]";
    }

    if (Array.isArray(value)) {
        const items = value
            .slice(0, LOG_MAX_ARRAY_ITEMS)
            .map((item) => sanitizeErrorValue(item, depth + 1));

        if (value.length > LOG_MAX_ARRAY_ITEMS) {
            items.push(`[truncated ${value.length - LOG_MAX_ARRAY_ITEMS} items]`);
        }

        return items;
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        const truncatedEntries = entries.slice(0, LOG_MAX_KEYS);
        const output: Record<string, unknown> = {};

        for (const [key, entryValue] of truncatedEntries) {
            output[key] = sanitizeErrorValue(entryValue, depth + 1);
        }

        if (entries.length > LOG_MAX_KEYS) {
            output._truncatedKeys = entries.length - LOG_MAX_KEYS;
        }

        return output;
    }

    return String(value);
}

function getErrorMessage(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") {
            return message;
        }
    }

    return "unknown error";
}

function extractRequestUrl(errorConfig: { baseURL?: unknown; url?: unknown } | undefined): string | null {
    if (!errorConfig) {
        return null;
    }

    const baseURL = typeof errorConfig.baseURL === "string" ? errorConfig.baseURL : "";
    const url = typeof errorConfig.url === "string" ? errorConfig.url : "";
    const fullUrl = `${baseURL}${url}`.trim();

    return fullUrl || null;
}

export function formatProviderErrorDetails(
    provider: string,
    operation: string,
    error: unknown,
    maxLength = LOG_DEFAULT_MAX_LENGTH
): string {
    const err = (error ?? {}) as {
        code?: unknown;
        message?: unknown;
        response?: {
            status?: unknown;
            data?: unknown;
        };
        config?: {
            method?: unknown;
            url?: unknown;
            baseURL?: unknown;
        };
    };

    const status = typeof err.response?.status === "number" ? err.response.status : null;
    const code = typeof err.code === "string" ? err.code : null;
    const methodRaw = typeof err.config?.method === "string" ? err.config.method : null;

    const details: ProviderErrorLogDetails = {
        provider,
        operation,
        status,
        code,
        message: getErrorMessage(error),
        request: {
            method: methodRaw ? methodRaw.toUpperCase() : null,
            url: extractRequestUrl(err.config),
        },
        response: sanitizeErrorValue(err.response?.data),
    };

    const serialized = JSON.stringify(details);
    if (serialized.length <= maxLength) {
        return serialized;
    }

    const trimmedDetails: ProviderErrorLogDetails = {
        ...details,
        response: "[truncated]",
        message: truncateString(details.message, 200),
        truncated: true,
    };

    return JSON.stringify(trimmedDetails);
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
