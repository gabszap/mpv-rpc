/**
 * Filename Parser Module - PTT (native TypeScript) with regex fallbacks
 */

import { type PttParsed, parseWithPtt } from "./parser-ptt";

/** Which parsing method produced a `ParsedFilename`. */
export type ParseMethod = "ptt" | "anime-regex" | "regex";

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
    // Which method produced this result. Optional so existing consumers and
    // hand-built values keep working.
    parseMethod?: ParseMethod;
}

/**
 * Result of `parseAnimeReleaseFallback` — a partial parse of an anime release
 * filename shaped like "[Group] Title - Episode [Tags]".
 *
 * Fields mirror the structural data the existing parse flow needs to build a
 * `ParsedFilename` without consulting PTT again.
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

// Cache for parsed filenames to avoid parsing the same name twice
const parseCache: Map<string, ParsedFilename> = new Map();

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
 * Build the display title: "Title - S01E02 - Episode title", or "Title - E02"
 * when there is no season.
 */
function buildFullTitle(
    title: string,
    season: number | null,
    episode: number | null,
    episodeTitle: string | null,
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

/**
 * True when the filename carries an episode marker (S01E02, "E05", "Episode 5",
 * or a trailing "- 05").
 */
function hasEpisodeMarker(filename: string): boolean {
    // extractEpisodeFromFilename only recognizes a trailing "- 05" at the very end
    // of the string, so drop a file extension first.
    const withoutExtension = filename.replace(/\.[A-Za-z0-9]{2,4}$/, "");
    return /[Ss](\d{1,2})[Ee](\d{1,3})/.test(withoutExtension) || extractEpisodeFromFilename(withoutExtension) !== null;
}

/**
 * Convert a PTT result into a `ParsedFilename`. Returns null when the result must
 * not be used: the title is not valid for provider searches, or the filename has
 * an episode marker but PTT did not extract an episode.
 */
function fromPtt(parsed: PttParsed, filename: string): ParsedFilename | null {
    const title = cleanTitle(parsed.title);
    if (!isValidSearchTitle(title)) {
        return null;
    }
    if (hasEpisodeMarker(filename) && parsed.episode === null) {
        return null;
    }

    const result: ParsedFilename = {
        full_title: buildFullTitle(title, parsed.season, parsed.episode, parsed.episodeTitle),
        series_title: title,
        season: parsed.season,
        episode: parsed.episode,
        episode_title: parsed.episodeTitle,
        media_type: detectMediaType(filename),
        parseMethod: "ptt",
    };
    if (parsed.releaseGroup) result.releaseGroup = parsed.releaseGroup;
    if (parsed.resolution) result.resolution = parsed.resolution;
    if (parsed.source) result.source = parsed.source;
    if (parsed.codec) result.codec = parsed.codec;
    return result;
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
 * A subtitle between the title and the episode ("Science Future Part 3") is easy
 * to mistake for an episode title; this parser keeps it in the title and extracts
 * the fields the existing flow needs (title, episode, release metadata). It
 * returns null when the pattern does not match.
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
 * Parse a filename: PTT first, then the anime release regex, then the generic regex.
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

    // PTT first: native, local and deterministic. The regex fallbacks below only run
    // when PTT is unavailable or its result is not usable for this filename.
    const pttParsed = await parseWithPtt(normalizedFilename);
    if (pttParsed) {
        const pttResult = fromPtt(pttParsed, filename);
        if (pttResult) {
            parseCache.set(cacheKey, pttResult);
            return pttResult;
        }
    }

    // Anime-release fallback: handles filenames like
    // "[Group] Title - Episode [Tags]". Only consulted when PTT produced nothing
    // useful.
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
            parseMethod: "anime-regex",
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
 * Generic regex-based parsing, used when PTT and the anime release regex fail
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

    const full_title = buildFullTitle(title, season, episode, null);

    return {
        full_title,
        series_title: isValidSearchTitle(title) ? title : "N/A",
        season,
        episode,
        episode_title: null,
        media_type: isValidSearchTitle(title) ? detectMediaType(filename) : "unknown",
        parseMethod: "regex",
    };
}
