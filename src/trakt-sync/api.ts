/**
 * Trakt.tv API Client
 * Handles Trakt API v2 calls for scrobbling, search, and history sync
 */

import * as fs from "node:fs";
import type { Agent } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import type { AxiosRequestConfig } from "axios";
import axios from "axios";
import { config } from "../config";
import { getAccessToken } from "./auth";
import type {
    TraktEpisode,
    TraktHistoryItem,
    TraktSearchResult,
    TraktSeasonEpisode,
    TraktShow,
    TraktUser,
} from "./types";

/**
 * Sanitize a proxy URL for logging by redacting userinfo (username/password).
 */
function sanitizeProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = "***";
            parsed.password = "";
            return parsed.toString();
        }
        return url;
    } catch {
        return url;
    }
}

/**
 * Log Trakt API call for debugging when config.debug is true.
 * Appends to .anime_cache/api_log.txt to keep consistent with provider logging.
 */
function logApiCall(method: string, url: string, status: number | string, detail?: string): void {
    if (!config.debug) return;

    try {
        const cacheDir = path.join(process.cwd(), ".anime_cache");
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const logPath = path.join(cacheDir, "api_log.txt");

        const now = new Date();
        const timestamp =
            now.getFullYear() +
            "-" +
            String(now.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(now.getDate()).padStart(2, "0") +
            " " +
            String(now.getHours()).padStart(2, "0") +
            ":" +
            String(now.getMinutes()).padStart(2, "0") +
            ":" +
            String(now.getSeconds()).padStart(2, "0");

        const line = `[${timestamp}] [Trakt] ${method} ${url} → ${status}${detail ? ` | ${detail}` : ""}\n`;
        fs.appendFileSync(logPath, line, "utf-8");
    } catch {
        // Silently ignore logging failures
    }
}

// Create axios instance with IPv4 forcing and optional Tor proxy
function createTraktAxios(): ReturnType<typeof axios.create> {
    const httpsAgent = new https.Agent({ family: 4 });
    const httpAgent = new http.Agent({ family: 4 });

    const axiosConfig: AxiosRequestConfig = {
        httpAgent,
        httpsAgent,
    };

    if (config.trakt.useTor) {
        // socks-proxy-agent v10 is ESM-only, use dynamic require to avoid module resolution issues
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SocksProxyAgent } = require("socks-proxy-agent") as {
            SocksProxyAgent: new (proxy: string) => Agent;
        };
        const socksAgent = new SocksProxyAgent(config.trakt.torProxy);
        axiosConfig.httpsAgent = socksAgent;
        axiosConfig.httpAgent = socksAgent;
        console.log("[Trakt] Using Tor proxy:", sanitizeProxyUrl(config.trakt.torProxy));
    }

    return axios.create(axiosConfig);
}

const traktAxios = createTraktAxios();

const TRAKT_API = "https://api.trakt.tv";
const MAX_RETRIES = 3;

/**
 * Build headers required for all authenticated Trakt API requests
 */
function buildHeaders(): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "trakt-api-key": config.trakt.clientId,
        "trakt-api-version": "2",
        "User-Agent": "mpv-rpc/2.2.0",
    };
}

/**
 * Build headers with Authorization for authenticated requests
 */
async function buildAuthHeaders(): Promise<Record<string, string> | null> {
    const token = await getAccessToken();
    if (!token) return null;

    return {
        ...buildHeaders(),
        Authorization: `Bearer ${token}`,
    };
}

/**
 * Normalize a title for comparison: lowercase, strip punctuation, trim
 */
export function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Execute a request with exponential backoff retry on 429 responses
 */
async function requestWithRetry<T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRIES): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e: unknown) {
            if (!axios.isAxiosError(e) || e.response?.status !== 429) {
                throw e;
            }

            lastError = e;

            if (attempt >= maxRetries) {
                break;
            }

            const retryAfter = e.response?.headers["retry-after"];
            const parsedDelay = retryAfter ? parseInt(retryAfter, 10) : NaN;
            const delayMs = Number.isFinite(parsedDelay) ? parsedDelay * 1000 : 2 ** attempt * 1000;

            console.log(
                `[Trakt] Rate limited (429). Retrying after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw lastError ?? new Error("[Trakt] Request failed after retries");
}

/**
 * Get the authenticated user's profile info
 */
export async function getUser(): Promise<TraktUser | null> {
    const headers = await buildAuthHeaders();
    if (!headers) {
        console.log("[Trakt] Not authenticated - cannot fetch user");
        return null;
    }

    try {
        const response = await requestWithRetry(() => traktAxios.get<TraktUser>(`${TRAKT_API}/users/me`, { headers }));

        logApiCall("GET", `${TRAKT_API}/users/me`, response.status);
        return response.data;
    } catch (e: unknown) {
        const status = axios.isAxiosError(e) ? (e.response?.status ?? "N/A") : "N/A";
        logApiCall("GET", `${TRAKT_API}/users/me`, status, "error");
        if (axios.isAxiosError(e)) {
            if (e.response?.status === 401) {
                console.error("[Trakt] Authentication expired - please re-authorize");
            } else {
                console.error("[Trakt] API Error (getUser):", {
                    status: e.response?.status,
                    message: e.response?.data?.message || e.message,
                });
            }
        } else {
            console.error("[Trakt] API Error (getUser):", e);
        }
        return null;
    }
}

/**
 * Search Trakt by title. Returns results sorted by score, year proximity, and title similarity.
 */
export async function searchByTitle(query: string, type: string): Promise<TraktSearchResult[]> {
    const headers = await buildAuthHeaders();
    if (!headers) {
        console.log("[Trakt] Not authenticated - cannot search");
        return [];
    }

    try {
        const response = await requestWithRetry(() =>
            traktAxios.get<TraktSearchResult[]>(`${TRAKT_API}/search/${type}`, {
                headers,
                params: { query },
            }),
        );

        const results = response.data;
        const normalizedQuery = normalizeTitle(query);

        const sorted = results.sort((a, b) => {
            // Primary: score descending
            if (b.score !== a.score) return b.score - a.score;

            // Secondary: year proximity to current year
            const currentYear = new Date().getFullYear();
            const aYearDiff = Math.abs((a.show?.year ?? 0) - currentYear);
            const bYearDiff = Math.abs((b.show?.year ?? 0) - currentYear);
            if (aYearDiff !== bYearDiff) return aYearDiff - bYearDiff;

            // Tertiary: normalized title similarity
            const aTitle = normalizeTitle(a.show?.title ?? "");
            const bTitle = normalizeTitle(b.show?.title ?? "");
            const aSimilarity = titleSimilarity(normalizedQuery, aTitle);
            const bSimilarity = titleSimilarity(normalizedQuery, bTitle);
            return bSimilarity - aSimilarity;
        });

        const bestTitle = sorted[0]?.show?.title ?? "N/A";
        logApiCall(
            "GET",
            `${TRAKT_API}/search/${type}`,
            response.status,
            `query="${query}", ${results.length} results, best="${bestTitle}"`,
        );

        return sorted;
    } catch (e: unknown) {
        const status = axios.isAxiosError(e) ? (e.response?.status ?? "N/A") : "N/A";
        logApiCall("GET", `${TRAKT_API}/search/${type}`, status, `query="${query}", error`);
        if (axios.isAxiosError(e)) {
            console.error("[Trakt] API Error (searchByTitle):", {
                status: e.response?.status,
                message: e.response?.data?.message || e.message,
            });
        } else {
            console.error("[Trakt] API Error (searchByTitle):", e);
        }
        return [];
    }
}

/**
 * Compute a simple character-level similarity ratio between two normalized titles
 */
function titleSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    if (longer.length === 0) return 1;

    let matches = 0;
    const shorterChars = shorter.split("");
    const longerChars = longer.split("");

    for (const char of shorterChars) {
        const index = longerChars.indexOf(char);
        if (index !== -1) {
            matches++;
            longerChars.splice(index, 1);
        }
    }

    return matches / longer.length;
}

/**
 * Look up a specific ID from an external source (imdb, tvdb)
 */
export async function lookupById(source: string, id: string): Promise<TraktSearchResult | null> {
    const headers = await buildAuthHeaders();
    if (!headers) {
        console.log("[Trakt] Not authenticated - cannot lookup ID");
        return null;
    }

    try {
        const response = await requestWithRetry(() =>
            traktAxios.get<TraktSearchResult[]>(`${TRAKT_API}/search/${source}/${id}`, { headers }),
        );

        const results = response.data;
        const first = results[0];
        const showTitle = first?.show?.title ?? "N/A";
        const showYear = first?.show?.year ?? "?";
        logApiCall("GET", `${TRAKT_API}/search/${source}/${id}`, response.status, `→ ${showTitle} (${showYear})`);

        return results.length > 0 ? results[0] : null;
    } catch (e: unknown) {
        const status = axios.isAxiosError(e) ? (e.response?.status ?? "N/A") : "N/A";
        logApiCall("GET", `${TRAKT_API}/search/${source}/${id}`, status, "error");
        if (axios.isAxiosError(e)) {
            console.error("[Trakt] API Error (lookupById):", {
                status: e.response?.status,
                message: e.response?.data?.message || e.message,
            });
        } else {
            console.error("[Trakt] API Error (lookupById):", e);
        }
        return null;
    }
}

/**
 * Get all seasons and episodes for a show
 */
export async function getShowSeasons(showId: number): Promise<TraktSeasonEpisode[]> {
    const headers = await buildAuthHeaders();
    if (!headers) {
        console.log("[Trakt] Not authenticated - cannot fetch seasons");
        return [];
    }

    try {
        const response = await requestWithRetry(() =>
            traktAxios.get<TraktSeasonEpisode[]>(`${TRAKT_API}/shows/${showId}/seasons`, {
                headers,
                params: { extended: "episodes" },
            }),
        );

        const seasonCount = response.data.length;
        const totalEps = response.data.reduce((sum, s) => sum + s.episodes.length, 0);
        logApiCall(
            "GET",
            `${TRAKT_API}/shows/${showId}/seasons`,
            response.status,
            `${seasonCount} seasons, ${totalEps} episodes`,
        );
        return response.data;
    } catch (e: unknown) {
        const status = axios.isAxiosError(e) ? (e.response?.status ?? "N/A") : "N/A";
        logApiCall("GET", `${TRAKT_API}/shows/${showId}/seasons`, status, "error");
        if (axios.isAxiosError(e)) {
            console.error("[Trakt] API Error (getShowSeasons):", {
                status: e.response?.status,
                message: e.response?.data?.message || e.message,
            });
        } else {
            console.error("[Trakt] API Error (getShowSeasons):", e);
        }
        return [];
    }
}

/**
 * Build the scrobble payload for start/stop/pause actions
 */
function buildScrobblePayload(
    episode: TraktEpisode,
    show: TraktShow,
    progress: number,
): { episode: TraktEpisode; show: TraktShow; progress: number } {
    return { episode, show, progress };
}

/**
 * Send a scrobble action to Trakt
 */
async function scrobbleAction(
    action: "start" | "stop" | "pause",
    episode: TraktEpisode,
    show: TraktShow,
    progress: number,
): Promise<boolean> {
    const headers = await buildAuthHeaders();
    if (!headers) {
        console.log(`[Trakt] Not authenticated - cannot scrobble ${action}`);
        return false;
    }

    try {
        const response = await requestWithRetry(() =>
            traktAxios.post(`${TRAKT_API}/scrobble/${action}`, buildScrobblePayload(episode, show, progress), {
                headers,
            }),
        );

        logApiCall(
            "POST",
            `${TRAKT_API}/scrobble/${action}`,
            response.status,
            `${show.title} S${String(episode.season).padStart(2, "0")}E${String(episode.number).padStart(2, "0")} @ ${progress.toFixed(0)}%`,
        );

        if (response.status === 200 || response.status === 201) {
            console.log(
                `[Trakt] Scrobble ${action}: ${show.title} S${String(episode.season).padStart(2, "0")}E${String(episode.number).padStart(2, "0")} (${progress.toFixed(0)}%)`,
            );
            return true;
        }

        return false;
    } catch (e: unknown) {
        const status = axios.isAxiosError(e) ? (e.response?.status ?? "N/A") : "N/A";
        logApiCall("POST", `${TRAKT_API}/scrobble/${action}`, status, `${progress.toFixed(0)}%, error`);
        if (axios.isAxiosError(e)) {
            console.error(`[Trakt] API Error (scrobble ${action}):`, {
                status: e.response?.status,
                message: e.response?.data?.message || e.message,
            });
        } else {
            console.error(`[Trakt] API Error (scrobble ${action}):`, e);
        }
        return false;
    }
}

/**
 * Start scrobbling an episode
 */
export async function scrobbleStart(episode: TraktEpisode, show: TraktShow, progress: number): Promise<boolean> {
    return scrobbleAction("start", episode, show, progress);
}

/**
 * Stop scrobbling an episode (mark as watched)
 */
export async function scrobbleStop(episode: TraktEpisode, show: TraktShow, progress: number): Promise<boolean> {
    return scrobbleAction("stop", episode, show, progress);
}

/**
 * Pause scrobbling an episode
 */
export async function scrobblePause(episode: TraktEpisode, show: TraktShow, progress: number): Promise<boolean> {
    return scrobbleAction("pause", episode, show, progress);
}

/**
 * Get watch history for a specific show, filtered by season and episode.
 * Returns null on error (transient failures should not poison the cache).
 */
export async function getHistory(showId: number, season: number, episode: number): Promise<TraktHistoryItem[] | null> {
    const headers = await buildAuthHeaders();
    if (!headers) {
        console.log("[Trakt] Not authenticated - cannot fetch history");
        return null;
    }

    try {
        const response = await requestWithRetry(() =>
            traktAxios.get<TraktHistoryItem[]>(`${TRAKT_API}/sync/history/shows/${showId}`, { headers }),
        );

        logApiCall(
            "GET",
            `${TRAKT_API}/sync/history/shows/${showId}`,
            response.status,
            `S${season}E${episode}, ${response.data.length} items`,
        );
        return response.data.filter((item) => item.episode.season === season && item.episode.number === episode);
    } catch (e: unknown) {
        const status = axios.isAxiosError(e) ? (e.response?.status ?? "N/A") : "N/A";
        logApiCall("GET", `${TRAKT_API}/sync/history/shows/${showId}`, status, `S${season}E${episode}, error`);
        if (axios.isAxiosError(e)) {
            console.error("[Trakt] API Error (getHistory):", {
                status: e.response?.status,
                message: e.response?.data?.message || e.message,
            });
        } else {
            console.error("[Trakt] API Error (getHistory):", e);
        }
        return null;
    }
}
