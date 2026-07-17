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
    // Optional release metadata (present when recovered via the anime
    // release regex, e.g. "[Group] Title - Episode [Tags]" releases).
    // Kept OPTIONAL so existing consumers that don't inspect them
    // continue to work unchanged.
    releaseGroup?: string;
    resolution?: string;
    source?: string;
    codec?: string;
}

/**
 * Result of `parseAnimeReleaseFallback` — a partial parse of an anime release
 * filename shaped like "[Group] Title - Episode [Tags]".
 *
 * Fields mirror the structural data the existing parse flow needs to build a
 * `ParsedFilename` without re-running the more expensive GuessIt pipeline.
 * Optional fields stay `undefined` when the corresponding tag is absent
 * from the release's tags block; the caller decides what to do with them.
 */
export type AnimeReleaseParseResult = {
    title: string;
    episode?: number;
    releaseGroup?: string;
    resolution?: string;
    source?: string;
    codec?: string;
    confidence: "low" | "medium" | "high";
};

/**
 * Primary regex for anime release filenames shaped like
 * "[Group] Title - Episode [Tags]".
 * Captures: group, title, episode, tags block.
 */
const ANIME_RELEASE_REGEX = /^\[(?<group>[^\]]+)\]\s+(?<title>.+?)\s+-\s+(?<episode>\d{1,4})\s+\[(?<tags>[^\]]+)\]/i;

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
            },
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
    } catch (_e) {
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

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEpisodeFromFilename(filename: string): number | null {
    const explicitEpisodeMatch = filename.match(/(?:^|[\s._-])[Ee][Pp]?(?:isode)?[\s._-]*(\d{1,3})(?=[^\d]|$)/);
    if (explicitEpisodeMatch) {
        return parseInt(explicitEpisodeMatch[1], 10);
    }

    const trailingEpisodeMatch = filename.match(/-\s*(\d{1,3})(?=\s*(?:\[|\(|v\d|$))/);
    if (trailingEpisodeMatch) {
        return parseInt(trailingEpisodeMatch[1], 10);
    }

    return null;
}

const loggedInvalidTitles: Set<string> = new Set();
const loggedTorrentExtractions: Set<string> = new Set();
const loggedAnimeFallbackMatches: Set<string> = new Set();

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
): ParsedFilename | null {
    if (!guessed || Object.keys(guessed).length === 0) {
        return null;
    }

    let title = guessed.title || filename;

    const alternativeTitle =
        typeof guessed.alternative_title === "string" ? cleanTitle(guessed.alternative_title) : null;

    // Fix Guessit detecting "Ko" as Korean language in titles like "Oshi no Ko"
    // Also handles dot-separated filenames like "OSHI.NO.KO.S03E10..."
    if (guessed.language === "Korean" && title.toLowerCase() === "oshi no") {
        const koMatch = filename.match(/oshi[.\s_-]no[.\s_-]ko/i);
        if (koMatch) {
            title = koMatch[0].replace(/[._-]/g, " ");
        }
    }

    const knownReleaseGroups = [
        "subsplease",
        "erai-raws",
        "judas",
        "horriblesubs",
        "hs",
        "rarbg",
        "yts",
        "ettv",
        "fgt",
        "sparks",
        "axxo",
        "lol",
        "toonshub",
        "msubs",
        "ddp",
        "amzn",
        "nf",
        "hmax",
    ];

    if (guessed.release_group && guessed.title) {
        const groupLower = guessed.release_group.toLowerCase();
        const isKnownGroup = knownReleaseGroups.some((g) => groupLower.includes(g));

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
            "i",
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
            "i",
        );

        if (arcPattern.test(filename)) {
            title = `${title} - ${episode_title}`;
            episode_title = null;
        }
    }

    // Anime-release recovery: upgrade title if GuessIt truncated it.
    // The anime regex captures the full title (e.g. "Dr Stone - Science Future Part 3")
    // when the input has the shape "[Group] Title - Subtitle - Episode [Tags]".
    // We only upgrade — never downgrade — by requiring the regex's title to be
    // a strict-prefix extension of the current GuessIt title.
    let animeRecoveryApplied: AnimeReleaseParseResult | null = null;
    const animeRecovery = parseAnimeReleaseFallback(filename);
    if (
        animeRecovery?.title &&
        typeof animeRecovery.episode === "number" &&
        (episode === null || episode === animeRecovery.episode) &&
        animeRecovery.title.trim().length > title.trim().length &&
        animeRecovery.title.trim().startsWith(title.trim())
    ) {
        title = animeRecovery.title;
        if (episode === null) {
            episode = animeRecovery.episode;
        }
        // Anime regex is authoritative for this shape — drop any partial
        // episode_title GuessIt may have produced.
        episode_title = null;
        animeRecoveryApplied = animeRecovery;
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
        // Propagate anime-release metadata only when the post-processor
        // actually upgraded the title from the regex match. Stays
        // `undefined` otherwise so existing non-anime parses are unaffected.
        releaseGroup: animeRecoveryApplied?.releaseGroup,
        resolution: animeRecoveryApplied?.resolution,
        source: animeRecoveryApplied?.source,
        codec: animeRecoveryApplied?.codec,
    };
}

/**
 * Emit a debug-level log at most once per unique key.
 * Uses `console.debug` when available, falling back to `console.log`.
 * Intended to remain quiet; can be enabled later via DEBUG=true plumbing.
 */
function logDebugOnce(key: string, message: string): void {
    if (loggedAnimeFallbackMatches.has(key)) {
        return;
    }
    loggedAnimeFallbackMatches.add(key);
    if (typeof console.debug === "function") {
        console.debug(message);
    } else {
        console.log(message);
    }
}

/**
 * Anime-release fallback parser for filenames like
 * "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p CR WEBRip HEVC]".
 *
 * GuessIt misinterprets the subtitle ("Science Future Part 3") as the
 * episode title for these releases; this parser extracts the fields the
 * existing flow needs (title, episode, release metadata) and returns
 * null when the pattern does not match.
 *
 * The returned `title` is the raw matched group so the caller can
 * apply the existing `cleanTitle` for normalization.
 */
export function parseAnimeReleaseFallback(filename: string): AnimeReleaseParseResult | null {
    const match = ANIME_RELEASE_REGEX.exec(filename);
    if (!match?.groups) {
        return null;
    }

    const group = match.groups.group?.trim();
    const title = match.groups.title?.trim();
    const episodeRaw = match.groups.episode;
    const tags = match.groups.tags ?? "";

    if (!title) {
        return null;
    }

    const episode = episodeRaw ? parseInt(episodeRaw, 10) : NaN;
    if (!Number.isFinite(episode)) {
        return null;
    }

    const resolutionMatch = tags.match(/(?<!\w)(720p|1080p|2160p|4K)(?!\w)/i);
    const sourceMatch = tags.match(/(CR\s*WEBRip|WEB-DL|WEBRip|BluRay|BDRip)/i);
    const codecMatch = tags.match(/\b(HEVC|H\.?264|H\.?265|AV1)\b/i);

    return {
        title,
        episode,
        releaseGroup: group,
        resolution: resolutionMatch ? resolutionMatch[1] : undefined,
        source: sourceMatch ? sourceMatch[1].replace(/\s+/g, " ") : undefined,
        codec: codecMatch ? codecMatch[1] : undefined,
        confidence: "high",
    };
}

/**
 * Parse a filename using GuessIt API with CLI fallback
 */
export async function parseFilename(filename: string): Promise<ParsedFilename> {
    // Extract torrent_name from URL query parameters early (Comet/Stremio streams)
    // This ensures consistent cache keys even if the URL path changes
    let extractedTorrentName: string | null = null;
    const torrentNameMatch = filename.match(/[?&]torrent_name=([^&]+)/);
    if (torrentNameMatch) {
        try {
            extractedTorrentName = decodeURIComponent(torrentNameMatch[1]);
        } catch (_e) {
            extractedTorrentName = torrentNameMatch[1];
        }

        // Log only once per unique torrent_name to avoid spam
        if (!loggedTorrentExtractions.has(extractedTorrentName)) {
            console.log("[Parser] Extracted torrent_name from URL");
            loggedTorrentExtractions.add(extractedTorrentName);
        }
    }

    // Use extracted torrent_name as cache key if available, otherwise use original filename
    const cacheKey = extractedTorrentName ?? filename;
    const cached = parseCache.get(cacheKey);
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

    // Ignore Stremio playlist filenames (internal MPV artifacts)
    if (/stremio-playlist-/i.test(filename)) {
        return {
            full_title: "N/A",
            series_title: "N/A",
            season: null,
            episode: null,
            episode_title: null,
            media_type: "unknown",
        };
    }

    // If we extracted torrent_name, use it as the working filename
    if (extractedTorrentName) {
        filename = extractedTorrentName;
    } else if (hasUrlEncodedChars(filename)) {
        try {
            filename = decodeURIComponent(filename);
            console.log("[Parser] Decoded URL-encoded filename");
        } catch (_e) {
            console.warn("[Parser] Failed to decode URL-encoded filename, continuing anyway");
        }
    }

    const normalizedFilename = filename.replace(/\+/g, "-").replace(/\//g, "-");

    let guessed: Record<string, any> | null = null;
    let _usedMethod: "api" | "cli" | "none" = "none";

    // Try API first if enabled
    if (config.guessitApi.enabled && config.guessitApi.url) {
        guessed = await callGuessItApi(normalizedFilename);
        if (guessed) {
            _usedMethod = "api";
        }
    }

    // Fallback to CLI if API failed or disabled
    if (!guessed) {
        guessed = await callGuessItCli(normalizedFilename);
        if (guessed) {
            _usedMethod = "cli";
        }
    }

    // Process result if we got one
    if (guessed) {
        const result = processGuessitResult(guessed, filename, normalizedFilename);
        if (result) {
            // Cache the result using the cache key
            parseCache.set(cacheKey, result);
            return result;
        }
    }

    // Anime-release fallback: handles filenames like
    // "[Group] Title - Episode [Tags]" where GuessIt misclassifies
    // the subtitle as the episode title. Only consulted when GuessIt
    // produced nothing useful.
    const animeFallback = parseAnimeReleaseFallback(filename);
    if (animeFallback?.title && typeof animeFallback.episode === "number") {
        const rawTitle = animeFallback.title;
        const episode = animeFallback.episode;
        const seriesTitle = cleanTitle(rawTitle);
        const paddedEpisode = String(episode).padStart(2, "0");
        const fullTitle = `${seriesTitle} - S00E${paddedEpisode}`;
        const mediaType = detectMediaType(filename);

        logDebugOnce(
            `anime-fallback:${filename}`,
            `[Parser][debug] Anime release fallback matched: ${seriesTitle} - E${paddedEpisode}`,
        );

        const animeResult: ParsedFilename = {
            full_title: fullTitle,
            series_title: seriesTitle,
            season: null,
            episode,
            episode_title: null,
            media_type: mediaType,
            releaseGroup: animeFallback.releaseGroup,
            resolution: animeFallback.resolution,
            source: animeFallback.source,
            codec: animeFallback.codec,
        };
        parseCache.set(cacheKey, animeResult);
        return animeResult;
    }

    // Final fallback: regex parsing
    const fallbackResult = fallbackParse(filename);
    // Cache the fallback result too
    parseCache.set(cacheKey, fallbackResult);
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
