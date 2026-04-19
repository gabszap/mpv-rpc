/**
 * Filename Parser Module - PoC with parse-torrent-title and legacy fallback
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ParsedResult as ParseTorrentTitleResult } from "@viren070/parse-torrent-title";
import axios from "axios";
import { config } from "./config";

export type ParseMethod = "ptt" | "api" | "cli" | "regex";

export interface ParsedFilename {
    full_title: string;
    series_title: string;
    season: number | null;
    episode: number | null;
    episode_title: string | null;
    media_type: "anime" | "series" | "unknown";
    release_group: string | null;
    languages: string[] | null;
    parse_method: ParseMethod;
}

const execFileAsync = promisify(execFile);
const moduleRequire = typeof require === "function"
    ? require
    : createRequire(path.join(process.cwd(), "noop.js"));

type ParseTorrentTitleModule = {
    parseTorrentTitle: (title: string) => ParseTorrentTitleResult;
};

// Cache for parsed filenames to avoid repeated API calls
const parseCache: Map<string, ParsedFilename> = new Map();
const loggedParseMethods: Set<string> = new Set();

let parseTorrentTitleModulePromise: Promise<ParseTorrentTitleModule | null> | null = null;
let hasLoggedParseTorrentTitleModuleError = false;
let hasLoggedParseTorrentTitleRuntimeError = false;

function logParseMethodOnce(method: ParseMethod): void {
    if (loggedParseMethods.has(method)) {
        return;
    }

    console.log(`[Parser][PoC] Using parser method: ${method}`);
    loggedParseMethods.add(method);
}

function buildFullTitle(
    title: string,
    season: number | null,
    episode: number | null,
    episodeTitle: string | null
): string {
    let fullTitle = title;

    if (season !== null && episode !== null) {
        fullTitle += ` - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    } else if (episode !== null) {
        fullTitle += ` - E${String(episode).padStart(2, "0")}`;
    }

    if (episodeTitle) {
        fullTitle += ` - ${episodeTitle}`;
    }

    return fullTitle;
}

function normalizeLanguages(languages: unknown): string[] | null {
    if (!Array.isArray(languages) || languages.length === 0) {
        return null;
    }

    const normalizedLanguages = languages
        .filter((language): language is string => typeof language === "string")
        .map((language) => language.trim())
        .filter((language) => language.length > 0);

    if (normalizedLanguages.length === 0) {
        return null;
    }

    return Array.from(new Set(normalizedLanguages));
}

function normalizeGuessitLanguages(guessed: Record<string, any>): string[] | null {
    if (Array.isArray(guessed.language)) {
        return normalizeLanguages(guessed.language);
    }

    if (typeof guessed.language === "string" && guessed.language.trim().length > 0) {
        return [guessed.language.trim()];
    }

    return null;
}

function getFirstNumber(value: unknown): number | null {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }

    const firstValue = value[0];
    if (typeof firstValue !== "number" || !Number.isFinite(firstValue)) {
        return null;
    }

    return firstValue;
}

export function extractEpisodeMarker(input: string): {
    hasMarker: boolean;
    season: number | null;
    episode: number | null;
} {
    const seMatch = input.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (seMatch) {
        return {
            hasMarker: true,
            season: parseInt(seMatch[1], 10),
            episode: parseInt(seMatch[2], 10),
        };
    }

    const explicitEpisodeMatch = input.match(/(?:^|[\s._-])[Ee][Pp]?(?:isode)?[\s._-]*(\d{1,3})(?=[^\d]|$)/);
    if (explicitEpisodeMatch) {
        return {
            hasMarker: true,
            season: null,
            episode: parseInt(explicitEpisodeMatch[1], 10),
        };
    }

    const trailingEpisodeMatch = input.match(/-\s*(\d{1,3})(?=\s*(?:\[|\(|v\d|$))/i);
    if (trailingEpisodeMatch) {
        return {
            hasMarker: true,
            season: null,
            episode: parseInt(trailingEpisodeMatch[1], 10),
        };
    }

    const cjkEpisodeMatch = input.match(/第\s*(\d{1,3})\s*話/);
    if (cjkEpisodeMatch) {
        return {
            hasMarker: true,
            season: null,
            episode: parseInt(cjkEpisodeMatch[1], 10),
        };
    }

    return {
        hasMarker: false,
        season: null,
        episode: null,
    };
}

function hasEpisodeMarker(filename: string): boolean {
    return extractEpisodeMarker(filename).hasMarker;
}

function shouldUsePttResult(result: ParsedFilename, normalizedFilename: string): boolean {
    if (!isValidSearchTitle(result.series_title)) {
        return false;
    }

    if (!hasEpisodeMarker(normalizedFilename)) {
        return true;
    }

    return result.episode !== null;
}

async function loadParseTorrentTitleModule(): Promise<ParseTorrentTitleModule | null> {
    if (parseTorrentTitleModulePromise) {
        return parseTorrentTitleModulePromise;
    }

    parseTorrentTitleModulePromise = (async () => {
        try {
            const modulePath = path.join(
                process.cwd(),
                "node_modules",
                "@viren070",
                "parse-torrent-title",
                "dist",
                "index.js"
            );
            const loadedModule = moduleRequire(modulePath) as Partial<ParseTorrentTitleModule>;
            if (typeof loadedModule.parseTorrentTitle !== "function") {
                if (!hasLoggedParseTorrentTitleModuleError) {
                    console.warn("[Parser][PoC] parse-torrent-title loaded without parse function; using legacy parser");
                    hasLoggedParseTorrentTitleModuleError = true;
                }
                return null;
            }

            return {
                parseTorrentTitle: loadedModule.parseTorrentTitle,
            };
        } catch {
            if (!hasLoggedParseTorrentTitleModuleError) {
                console.warn("[Parser][PoC] Failed to load parse-torrent-title; using legacy parser");
                hasLoggedParseTorrentTitleModuleError = true;
            }
            return null;
        }
    })();

    return parseTorrentTitleModulePromise;
}

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
        .replace(/第\s*\d{1,3}\s*話/g, "")
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

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEpisodeFromFilename(filename: string): number | null {
    return extractEpisodeMarker(filename).episode;
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
    normalizedFilename: string,
    parseMethod: "api" | "cli"
): ParsedFilename | null {
    if (!guessed || Object.keys(guessed).length === 0) {
        return null;
    }

    let title = guessed.title || filename;

    const alternativeTitle = typeof guessed.alternative_title === "string"
        ? cleanTitle(guessed.alternative_title)
        : null;

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
            release_group: typeof guessed.release_group === "string" ? guessed.release_group : null,
            languages: normalizeGuessitLanguages(guessed),
            parse_method: parseMethod,
        };
    }

    let season = guessed.season ?? null;
    let episode = guessed.episode ?? null;
    let episode_title = guessed.episode_title ?? null;

    if (season === null || episode === null) {
        const seMatch = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
        if (seMatch) {
            if (season === null) season = parseInt(seMatch[1], 10);
            if (episode === null) episode = parseInt(seMatch[2], 10);
        }
    }

    // Handle patterns where GuessIt splits season/subtitle into alternative_title,
    // e.g. "Dr Stone - New World - 02" => title="Dr Stone", alternative_title="New World".
    if (alternativeTitle && guessed.title && guessed.episode) {
        const normalizedTitle = cleanTitle(guessed.title);
        const combinedPattern = new RegExp(
            `${escapeRegex(normalizedTitle)}\\s*-\\s*${escapeRegex(alternativeTitle)}\\s*-\\s*0*${guessed.episode}(?:[^\\d]|$)`,
            "i"
        );

        if (combinedPattern.test(filename)) {
            title = `${normalizedTitle} - ${alternativeTitle}`;
        }
    }

    if (episode === null) {
        episode = extractEpisodeFromFilename(filename);
    }

    if (episode !== null && episode_title && title) {
        const arcPattern = new RegExp(
            `${escapeRegex(title)}\\s*-\\s*${escapeRegex(episode_title)}\\s*-\\s*0*${episode}(?:[^\\d]|$)`,
            "i"
        );

        if (arcPattern.test(filename)) {
            title = `${title} - ${episode_title}`;
            episode_title = null;
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

    const full_title = buildFullTitle(title, season, episode, episode_title);

    return {
        full_title,
        series_title: title,
        season,
        episode,
        episode_title,
        media_type: detectMediaType(filename),
        release_group: typeof guessed.release_group === "string" ? guessed.release_group : null,
        languages: normalizeGuessitLanguages(guessed),
        parse_method: parseMethod,
    };
}

function processParseTorrentTitleResult(
    parsedResult: ParseTorrentTitleResult,
    filename: string
): ParsedFilename | null {
    const title = cleanTitle(parsedResult.title || "");
    if (!isValidSearchTitle(title)) {
        return null;
    }

    const season = getFirstNumber(parsedResult.seasons);
    const episode = getFirstNumber(parsedResult.episodes);
    const full_title = buildFullTitle(title, season, episode, null);

    return {
        full_title,
        series_title: title,
        season,
        episode,
        episode_title: null,
        media_type: detectMediaType(filename),
        release_group: parsedResult.group ?? null,
        languages: normalizeLanguages(parsedResult.languages),
        parse_method: "ptt",
    };
}

/**
 * Parse a filename using parse-torrent-title PoC with legacy fallback
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
            release_group: null,
            languages: null,
            parse_method: "regex",
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

    const parseTorrentTitleModule = await loadParseTorrentTitleModule();
    if (parseTorrentTitleModule) {
        try {
            const pttResult = parseTorrentTitleModule.parseTorrentTitle(normalizedFilename);
            const mappedPttResult = processParseTorrentTitleResult(pttResult, filename);
            if (mappedPttResult && shouldUsePttResult(mappedPttResult, normalizedFilename)) {
                logParseMethodOnce("ptt");
                parseCache.set(filename, mappedPttResult);
                return mappedPttResult;
            }
        } catch {
            if (!hasLoggedParseTorrentTitleRuntimeError) {
                console.warn("[Parser][PoC] parse-torrent-title failed during parsing; using legacy parser");
                hasLoggedParseTorrentTitleRuntimeError = true;
            }
        }
    }

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
    if (guessed && usedMethod !== "none") {
        const result = processGuessitResult(guessed, filename, normalizedFilename, usedMethod);
        if (result) {
            // Cache the result
            if (usedMethod === "api" || usedMethod === "cli") {
                logParseMethodOnce(usedMethod);
            }
            parseCache.set(filename, result);
            return result;
        }
    }

    // Final fallback: regex parsing
    const fallbackResult = fallbackParse(filename);
    // Cache the fallback result too
    logParseMethodOnce("regex");
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
        const cjkEpisodeMatch = filename.match(/第\s*(\d{1,3})\s*話/);

        if (epMatch) {
            episode = parseInt(epMatch[1], 10);
            const idx = filename.indexOf(epMatch[0]);
            if (idx > 0) {
                title = filename.substring(0, idx);
            }
        } else if (cjkEpisodeMatch) {
            episode = parseInt(cjkEpisodeMatch[1], 10);
            const idx = filename.indexOf(cjkEpisodeMatch[0]);
            if (idx > 0) {
                title = filename.substring(0, idx);
            }
        }
    }

    title = cleanTitle(title);
    title = title.replace(/\s*-\s*$/, "").trim();

    const full_title = buildFullTitle(title, season, episode, null);

    return {
        full_title,
        series_title: isValidSearchTitle(title) ? title : "N/A",
        season,
        episode,
        episode_title: null,
        media_type: isValidSearchTitle(title) ? detectMediaType(filename) : "unknown",
        release_group: null,
        languages: null,
        parse_method: "regex",
    };
}
