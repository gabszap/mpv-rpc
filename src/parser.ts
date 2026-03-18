/**
 * Filename Parser Module - Uses GuessIt API with CLI fallback
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import axios from "axios";
import { config } from "./config";

export interface ParsedFilename {
    full_title: string;
    series_title: string;
    season: number | null;
    episode: number | null;
    episode_title: string | null;
    media_type: "anime" | "series" | "unknown";
}

const execFileAsync = promisify(execFile);

// Cache for parsed filenames to avoid repeated API calls
const parseCache: Map<string, ParsedFilename> = new Map();

/**
 * Call GuessIt via HTTP API
 */
async function callGuessItApi(filename: string): Promise<Record<string, any> | null> {
    if (!config.guessitApi.url) {
        return null;
    }

    try {
        const response = await axios.post(
            config.guessitApi.url,
            { filename },
            {
                timeout: config.guessitApi.timeout,
                headers: {
                    "Content-Type": "application/json",
                },
            }
        );
        return response.data;
    } catch (e: any) {
        // Log only once to avoid spam
        if (e.response?.status === 404) {
            console.warn("[Parser] GuessIt API endpoint not found, will try CLI fallback");
        }
        return null;
    }
}

/**
 * Call GuessIt via local CLI
 */
async function callGuessItCli(filename: string): Promise<Record<string, any> | null> {
    try {
        const { stdout } = await execFileAsync("guessit", [filename, "--json"], {
            timeout: 15000,
        });
        return JSON.parse(stdout.trim());
    } catch (e) {
        return null;
    }
}

/**
 * Check if GuessIt CLI is available locally
 */
export async function checkAvailability(): Promise<boolean> {
    try {
        await execFileAsync("guessit", ["--version"]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Detect if the file is anime or regular series based on filename patterns
 */
function detectMediaType(filename: string): "anime" | "series" | "unknown" {
    const hasGroupAtStart = /^\[[^\]]+\]/.test(filename);
    const hasCrcHash = /\[[0-9A-Fa-f]{8}\]/.test(filename);

    if (hasGroupAtStart || hasCrcHash) {
        return "anime";
    }

    const hasJapaneseAudio = /[.\-_](JPN|Japanese)[.\-_]/i.test(filename);
    const hasCrunchyroll = /[.\-_]CR[.\-_]/i.test(filename);
    const hasWebDL = /[.\-_]WEB-DL[.\-_]?/i.test(filename);
    const hasStreamingService = /[.\-_](CR|NF|AMZN|HULU|DSNP)[.\-_]/i.test(filename);

    if (hasCrunchyroll && hasWebDL) {
        return "anime";
    }

    if (hasJapaneseAudio && hasStreamingService) {
        return "anime";
    }

    const hasWesternPattern = /\.\d{3,4}p\./.test(filename) && !hasGroupAtStart;

    if (hasWesternPattern) {
        return "series";
    }

    return "unknown";
}

/**
 * Clean up title - remove dots, underscores, brackets, etc.
 */
function cleanTitle(title: string): string {
    return title
        .replace(/\./g, " ")
        .replace(/_/g, " ")
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Check if filename has URL-encoded characters
 */
function hasUrlEncodedChars(filename: string): boolean {
    return /%[0-9A-Fa-f]{2}/.test(filename);
}

const loggedInvalidTitles: Set<string> = new Set();

/**
 * Check if a title is valid for API searches
 */
function isValidSearchTitle(title: string): boolean {
    if (!title || title.trim().length === 0) {
        return false;
    }

    const cleaned = title.trim();

    if (/^[\d.\-_\s]+$/.test(cleaned)) {
        return false;
    }

    const letterCount = (cleaned.match(/\p{L}/gu) || []).length;

    if (letterCount < 2) {
        return false;
    }

    return true;
}

/**
 * Process GuessIt result into standardized format
 */
function processGuessitResult(
    guessed: Record<string, any>,
    filename: string,
    normalizedFilename: string
): ParsedFilename | null {
    if (!guessed || Object.keys(guessed).length === 0) {
        return null;
    }

    let title = guessed.title || filename;

    // Fix Guessit detecting "Ko" as Korean language in titles like "Oshi no Ko"
    // Also handles dot-separated filenames like "OSHI.NO.KO.S03E10..."
    if (guessed.language === "Korean" && title.toLowerCase() === "oshi no") {
        const koMatch = filename.match(/oshi[.\s_-]no[.\s_-]ko/i);
        if (koMatch) {
            title = koMatch[0].replace(/[._-]/g, " ");
        }
    }

    const knownReleaseGroups = [
        "subsplease", "erai-raws", "judas", "horriblesubs", "hs",
        "rarbg", "yts", "ettv", "fgt", "sparks", "axxo", "lol",
        "toonshub", "msubs", "ddp", "amzn", "nf", "hmax"
    ];

    if (guessed.release_group && guessed.title) {
        const groupLower = guessed.release_group.toLowerCase();
        const isKnownGroup = knownReleaseGroups.some(g => groupLower.includes(g));

        if (!isKnownGroup) {
            const combinedTitle = `${guessed.release_group}-${guessed.title}`;
            if (normalizedFilename.toLowerCase().includes(combinedTitle.toLowerCase().replace(/\s/g, "."))) {
                title = combinedTitle;
            }
        }
    }

    title = cleanTitle(title);

    if (!isValidSearchTitle(title)) {
        if (!loggedInvalidTitles.has(title)) {
            console.warn(`[Parser] Title "${title}" is not valid for API search, marking as unknown`);
            loggedInvalidTitles.add(title);
        }
        return {
            full_title: filename,
            series_title: "N/A",
            season: guessed.season ?? null,
            episode: guessed.episode ?? null,
            episode_title: guessed.episode_title ?? null,
            media_type: "unknown",
        };
    }

    let season = guessed.season ?? null;
    let episode = guessed.episode ?? null;
    const episode_title = guessed.episode_title ?? null;

    if (season === null || episode === null) {
        const seMatch = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
        if (seMatch) {
            if (season === null) season = parseInt(seMatch[1], 10);
            if (episode === null) episode = parseInt(seMatch[2], 10);
        }
    }

    if (season === null) {
        const seasonMatch = title.match(/(\d+)(?:st|nd|rd|th)?\s*[Ss]eason|[Ss]eason\s*(\d+)/i);
        if (seasonMatch) {
            season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
            title = title.replace(/(\d+)(?:st|nd|rd|th)?\s*[Ss]eason|[Ss]eason\s*(\d+)/i, "").trim();
            title = title.replace(/\s+/g, " ").trim();
        }
    }

    let full_title = title;
    if (season !== null && episode !== null) {
        full_title += ` - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    } else if (episode !== null) {
        full_title += ` - E${String(episode).padStart(2, "0")}`;
    }
    if (episode_title) {
        full_title += ` - ${episode_title}`;
    }

    return {
        full_title,
        series_title: title,
        season,
        episode,
        episode_title,
        media_type: detectMediaType(filename),
    };
}

/**
 * Parse a filename using GuessIt API with CLI fallback
 */
export async function parseFilename(filename: string): Promise<ParsedFilename> {
    // Check cache first
    const cached = parseCache.get(filename);
    if (cached) {
        return cached;
    }

    if (!filename || filename === "N/A") {
        return {
            full_title: "N/A",
            series_title: "N/A",
            season: null,
            episode: null,
            episode_title: null,
            media_type: "unknown",
        };
    }

    if (hasUrlEncodedChars(filename)) {
        try {
            filename = decodeURIComponent(filename);
            console.log("[Parser] Decoded URL-encoded filename");
        } catch (e) {
            console.warn("[Parser] Failed to decode URL-encoded filename, continuing anyway");
        }
    }

    const normalizedFilename = filename
        .replace(/\+/g, "-")
        .replace(/\//g, "-");

    let guessed: Record<string, any> | null = null;
    let usedMethod: "api" | "cli" | "none" = "none";

    // Try API first if enabled
    if (config.guessitApi.enabled && config.guessitApi.url) {
        guessed = await callGuessItApi(normalizedFilename);
        if (guessed) {
            usedMethod = "api";
        }
    }

    // Fallback to CLI if API failed or disabled
    if (!guessed) {
        guessed = await callGuessItCli(normalizedFilename);
        if (guessed) {
            usedMethod = "cli";
        }
    }

    // Process result if we got one
    if (guessed) {
        const result = processGuessitResult(guessed, filename, normalizedFilename);
        if (result) {
            // Cache the result
            parseCache.set(filename, result);
            return result;
        }
    }

    // Final fallback: regex parsing
    const fallbackResult = fallbackParse(filename);
    // Cache the fallback result too
    parseCache.set(filename, fallbackResult);
    return fallbackResult;
}

/**
 * Fallback regex-based parsing if GuessIt fails
 */
function fallbackParse(filename: string): ParsedFilename {
    let title = filename;
    let season: number | null = null;
    let episode: number | null = null;

    const seMatch = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (seMatch) {
        season = parseInt(seMatch[1], 10);
        episode = parseInt(seMatch[2], 10);
        const idx = filename.indexOf(seMatch[0]);
        if (idx > 0) {
            title = filename.substring(0, idx);
        }
    } else {
        const epMatch = filename.match(/(?:Episode\s*|[Ee]|[-_]\s*)(\d+)(?:[^\d]|$)/);
        if (epMatch) {
            episode = parseInt(epMatch[1], 10);
            const idx = filename.indexOf(epMatch[0]);
            if (idx > 0) {
                title = filename.substring(0, idx);
            }
        }
    }

    title = cleanTitle(title);
    title = title.replace(/\s*-\s*$/, "").trim();

    let full_title = title;
    if (season !== null && episode !== null) {
        full_title += ` - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    } else if (episode !== null) {
        full_title += ` - E${String(episode).padStart(2, "0")}`;
    }

    return {
        full_title,
        series_title: isValidSearchTitle(title) ? title : "N/A",
        season,
        episode,
        episode_title: null,
        media_type: isValidSearchTitle(title) ? detectMediaType(filename) : "unknown",
    };
}
