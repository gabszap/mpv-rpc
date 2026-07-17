/**
 * MPV IPC Module - Connects to MPV via IPC
 * Windows: Named Pipes (\\.\pipe\mpv)
 * Linux/macOS: Unix Sockets (/tmp/mpv-socket)
 */

import * as net from "node:net";
import { getAnimeInfoWithProvider, getEpisodeTitle, resolveOverflowEpisode } from "../core/anime";
import { config } from "../core/config";
import { checkSeriesNameOverride } from "../console";
import { parseFilename } from "../core/parser";
import { normalizeTvdbLanguageCode } from "../providers/tvdb";
import { readStremioPlaybackContext, type StremioPlaybackContext } from "../stremio-sync/context";

/**
 * Normalize titles for a conservative bridge-context compatibility check.
 */
function normalizeStremioIdentityTitle(title: string | null | undefined): string[] {
    if (!title) {
        return [];
    }

    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
}

function titlesHaveSafeTokenOverlap(contextName: string | null, playbackTitle: string): boolean {
    const contextTokens = normalizeStremioIdentityTitle(contextName);
    const playbackTokens = normalizeStremioIdentityTitle(playbackTitle);
    if (contextTokens.length === 0 || playbackTokens.length === 0) {
        return false;
    }

    const shorterTokens = contextTokens.length <= playbackTokens.length ? contextTokens : playbackTokens;
    const longerTokens = new Set(contextTokens.length <= playbackTokens.length ? playbackTokens : contextTokens);
    const matchingTokens = shorterTokens.filter((token) => longerTokens.has(token)).length;

    return matchingTokens / shorterTokens.length >= 0.8;
}

function isStremioIdentitySafeForPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    if (!context.imdbId) {
        return false;
    }

    if (context.type === "movie") {
        return titlesHaveSafeTokenOverlap(context.name, data.series_title);
    }

    if (context.season === null || context.episode === null) {
        return false;
    }

    const isExactPositionMatch = data.season === context.season && data.episode === context.episode;
    const isEpisodeOnlyMatch = data.season === null && data.episode !== null && data.episode === context.episode;
    if (!isExactPositionMatch && !isEpisodeOnlyMatch) {
        return false;
    }

    return titlesHaveSafeTokenOverlap(context.name, data.series_title);
}

/**
 * Read secure Stremio identity fields when the bridge has already captured them.
 * The context must still be compatible with current playback before its IMDb ID
 * is copied into MPV data; otherwise a stale bridge context could validate itself.
 */
function readStremioPlaybackIdentity(data: MpvData): { imdbId?: string; type?: "series" | "movie" } {
    const context = readStremioPlaybackContext(Date.now());
    if (!context || !isStremioIdentitySafeForPlayback(context, data)) {
        return {};
    }

    return {
        ...(context.imdbId ? { imdbId: context.imdbId } : {}),
        ...(context.type ? { type: context.type } : {}),
    };
}

export interface MpvData {
    media_title: string;
    series_title: string;
    season: number | null;
    episode: number | null;
    episode_title: string | null;
    filename: string;
    path?: string;
    pause: boolean;
    percent_pos: number;
    time_pos: number;
    duration: number;
    artist: string;
    cover_image: string | null;
    mal_id: number | null; // For MAL sync
    total_episodes: number | null; // For MAL sync (mark as completed)
    adjusted_episode: number | null; // Adjusted episode for split cour (null if no overflow)
    imdb_id?: string; // For Stremio sync
    type?: string; // For Stremio sync
    playlistPos: number; // Current position in playlist (0-indexed)
    playlistCount: number; // Total number of items in playlist
}

export function selectCoverImage(
    animeInfo: { cover_url: string | null; season_cover_url?: string | null },
    existingCoverImage: string | null = null,
): string | null {
    return animeInfo.season_cover_url ?? animeInfo.cover_url ?? existingCoverImage;
}

interface RuntimeEpisodeTitleResolutionInput {
    currentEpisodeTitle: string | null;
    episode: number | null;
    metadataSourceProvider: string | null;
    tvdbLanguage: string;
    fetchEpisodeTitle: () => Promise<string | null>;
}

export function shouldPreferTvdbLocalizedEpisodeTitle(
    metadataSourceProvider: string | null,
    tvdbLanguage: string,
): boolean {
    if (metadataSourceProvider !== "tvdb") {
        return false;
    }

    return normalizeTvdbLanguageCode(tvdbLanguage) !== "eng";
}

export async function resolveRuntimeEpisodeTitle({
    currentEpisodeTitle,
    episode,
    metadataSourceProvider,
    tvdbLanguage,
    fetchEpisodeTitle,
}: RuntimeEpisodeTitleResolutionInput): Promise<string | null> {
    if (episode === null || episode < 1) {
        return currentEpisodeTitle;
    }

    const hasParsedEpisodeTitle = Boolean(currentEpisodeTitle?.trim());
    const shouldFetchMissingTitle = !hasParsedEpisodeTitle;
    const shouldRefreshLocalizedTvdbTitle =
        hasParsedEpisodeTitle && shouldPreferTvdbLocalizedEpisodeTitle(metadataSourceProvider, tvdbLanguage);

    if (!shouldFetchMissingTitle && !shouldRefreshLocalizedTvdbTitle) {
        return currentEpisodeTitle;
    }

    const fetchedEpisodeTitle = await fetchEpisodeTitle();
    return fetchedEpisodeTitle || currentEpisodeTitle;
}

let socket: net.Socket | null = null;
let requestId = 1;
let isConnected = false;
const pendingRequests: Map<number, (data: any) => void> = new Map();
let dataBuffer = "";
let lastConnectionAttempt = 0;
const CONNECTION_COOLDOWN = 5000; // 5 seconds between connection attempts

/**
 * Connect to MPV's IPC socket
 */
export async function connect(): Promise<boolean> {
    return new Promise((resolve) => {
        if (isConnected && socket) {
            resolve(true);
            return;
        }

        // Cooldown to avoid spamming connection attempts
        const now = Date.now();
        if (now - lastConnectionAttempt < CONNECTION_COOLDOWN) {
            resolve(false);
            return;
        }
        lastConnectionAttempt = now;

        socket = net.createConnection(config.mpvPipePath);

        socket.on("connect", () => {
            console.log("[MPV] Connected to MPV");
            isConnected = true;
            resolve(true);
        });

        socket.on("data", (data) => {
            dataBuffer += data.toString();

            // Process complete JSON messages (newline delimited)
            const lines = dataBuffer.split("\n");
            dataBuffer = lines.pop() || ""; // Keep incomplete line in buffer

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const response = JSON.parse(line);
                    const id = response.request_id;
                    if (id && pendingRequests.has(id)) {
                        const callback = pendingRequests.get(id);
                        pendingRequests.delete(id);
                        if (callback) {
                            callback(response.data);
                        }
                    }
                } catch (_e) {
                    // Ignore parse errors for event messages
                }
            }
        });

        socket.on("error", (err) => {
            console.log("[MPV] Connection error:", err.message);
            isConnected = false;
            resolve(false);
        });

        socket.on("close", () => {
            console.log("[MPV] Connection closed");
            isConnected = false;
            socket = null;
        });
    });
}

/**
 * Disconnect from MPV
 */
export function disconnect(): void {
    if (socket) {
        socket.destroy();
        socket = null;
        isConnected = false;
    }
}

/**
 * Check if connected to MPV
 */
export function getConnectionStatus(): boolean {
    return isConnected;
}

/**
 * Send a command to MPV and get response
 */
function sendCommand(command: (string | number)[]): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!socket || !isConnected) {
            reject(new Error("Not connected to MPV"));
            return;
        }

        const id = requestId++;
        const msg = `${JSON.stringify({ command, request_id: id })}\n`;

        pendingRequests.set(id, resolve);

        // Timeout after 2 seconds
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                resolve("N/A");
            }
        }, 2000);

        socket.write(msg);
    });
}

/**
 * Get a property from MPV
 */
async function getProperty(prop: string): Promise<any> {
    try {
        const result = await sendCommand(["get_property", prop]);
        return result ?? "N/A";
    } catch {
        return "N/A";
    }
}

/**
 * Set a property on MPV
 */
async function setProperty(prop: string, value: string): Promise<void> {
    try {
        await sendCommand(["set_property", prop, value]);
    } catch {
        // Ignore errors when setting properties
    }
}

/**
 * Sanitize media-title from MPV to remove tracker/subtitle metadata
 *
 * Stremio/Torrentio streams often include extra info in the title like:
 * "OSHI NO KO S03E10 ... ([Oshi no Ko] Multi-Subs)\n👤 153 💾 1.39 GB ⚙️ NyaaSi\nMulti Subs / 🇬🇧 / ..."
 *
 * This function strips everything after the actual filename.
 */
export function sanitizeMediaTitle(title: string): string {
    if (!title || title === "N/A") return title;

    // 1. Cut at first newline (tracker metadata is always on separate lines)
    const newlineIdx = title.indexOf("\n");
    if (newlineIdx > 0) {
        title = title.substring(0, newlineIdx);
    }

    // 2. Remove trailing parenthesized group info like "([Oshi no Ko] Multi-Subs)"
    //    or "(Multi Subs)" that appear after the release group
    title = title.replace(/\s*\((?:\[[^\]]*\]\s*)?Multi[- ]?Subs?\)[^)]*$/i, "");
    title = title.replace(/\s*\((?:\[[^\]]*\]\s*)?Multi[- ]?Audio\)[^)]*$/i, "");

    // 3. Remove tracker metadata indicators (emojis + stats)
    //    Patterns like: 👤 153 💾 1.39 GB ⚙️ NyaaSi
    title = title.replace(/\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}].*$/su, "");

    // 4. Remove subtitle language flags section
    //    Patterns like: Multi Subs / 🇬🇧 / 🇷🇺 / ...
    title = title.replace(/\s*Multi\s*Subs?\s*\/.*$/i, "");

    // 5. Remove regional indicator symbols (flag emojis) and what follows
    title = title.replace(/\s*[\u{1F1E0}-\u{1F1FF}].*$/su, "");

    // 6. Remove common tracker suffixes that might remain
    //    e.g. "◎ NyaaSi", "▌ [S3]", etc.
    title = title.replace(/\s*(?:◎|▌|⚙|️|💾|👤).*$/u, "");

    return title.trim();
}

/**
 * Get all MPV data needed for Discord presence
 */
export async function getMpvData(): Promise<MpvData | null> {
    if (!isConnected) {
        const connected = await connect();
        if (!connected) return null;
    }

    try {
        // Get primary identifiers from MPV
        const [filename, rawMediaTitle, currentPath] = await Promise.all([
            getProperty("filename/no-ext"),
            getProperty("media-title"),
            getProperty("path"),
        ]);

        // Sanitize media-title to remove tracker/subtitle metadata
        const mediaTitle = sanitizeMediaTitle(rawMediaTitle);

        if (!filename || filename === "N/A") {
            // MPV is connected but no media playing
            return {
                media_title: "N/A",
                series_title: "N/A",
                season: null,
                episode: null,
                episode_title: null,
                filename: "N/A",
                pause: false,
                percent_pos: 0,
                time_pos: 0,
                duration: 0,
                artist: "N/A",
                cover_image: null,
                mal_id: null,
                total_episodes: null,
                adjusted_episode: null,
                playlistPos: 0,
                playlistCount: 0,
            };
        }

        /**
         * Determine the best string for metadata parsing.
         * For streams, 'filename' is often a cryptic URL or hash.
         * 'media-title' populated via M3U #EXTINF is usually a clean filename.
         * However, after loading, MPV may switch to the MKV's embedded title tag,
         * which is often just the episode title without series/season info.
         */
        const isUrl = (s: string) => /^(https?|magnet):/i.test(s);
        const isPlaylist = (s: string) => /stremio-playlist-\d+/i.test(s);
        const hasEpisodeMarker = (s: string) => {
            return (
                /S\d{1,2}E\d{1,3}/i.test(s) ||
                /(?:^|[\s._-])[Ee][Pp]?(?:isode)?[\s._-]*\d{1,3}(?=[^\d]|$)/.test(s) ||
                /-\s*\d{1,3}(?=\s*(?:\[|\(|v\d|$))/i.test(s)
            );
        };

        let parseTarget = filename;

        // If filename is a playlist, try to use mediaTitle
        if (isPlaylist(filename)) {
            if (mediaTitle && mediaTitle !== "N/A" && !isPlaylist(mediaTitle)) {
                // Check if mediaTitle has episode info (SxxExx, E##, or trailing - ##)
                // If it doesn't, it might be the MKV's embedded title (just episode name)
                if (hasEpisodeMarker(mediaTitle)) {
                    parseTarget = mediaTitle;
                } else {
                    // mediaTitle is probably just the episode title from MKV metadata
                    // Wait for a better title or return null to skip this update
                    return null;
                }
            } else {
                // If we don't have a good title yet, don't parse anything
                return null;
            }
        } else if (isUrl(filename)) {
            // If filename is a URL, we depend on mediaTitle.
            if (mediaTitle && mediaTitle !== "N/A" && mediaTitle !== filename) {
                if (hasEpisodeMarker(mediaTitle)) {
                    parseTarget = mediaTitle;
                } else {
                    // URL filename + title without episode marker usually means embedded tag only.
                    return null;
                }
            } else {
                return null;
            }
        } else if (mediaTitle && mediaTitle !== "N/A" && mediaTitle !== filename) {
            // For non-URL files, prefer filename to avoid feedback loops caused by force-media-title.
            // Only use mediaTitle if filename has no episode marker but mediaTitle does.
            const filenameHasEpisodeMarker = hasEpisodeMarker(filename);
            const mediaTitleHasEpisodeMarker = hasEpisodeMarker(mediaTitle);

            if (!filenameHasEpisodeMarker && mediaTitleHasEpisodeMarker) {
                parseTarget = mediaTitle;
            }
        }

        // Parse the target string
        const parsed = await parseFilename(parseTarget);

        // Get other properties in parallel
        const [pause, percent_pos, time_pos, duration, artist, playlistPos, playlistCount] = await Promise.all([
            getProperty("pause"),
            getProperty("percent-pos"),
            getProperty("time-pos"),
            getProperty("duration"),
            getProperty("metadata/by-key/Artist"),
            getProperty("playlist-pos"),
            getProperty("playlist-count"),
        ]);

        // Fetch anime metadata
        let coverImage: string | null = null;
        let episodeTitle = parsed.episode_title;
        let seriesTitle = parsed.series_title;
        let malId: number | null = null;
        let totalEpisodes: number | null = null;
        let adjustedEpisode: number | null = null;
        let metadataSourceProvider: string | null = null;
        const originalTitle = parsed.series_title; // Keep original for episode lookup

        // Check for manual series name override (rename command)
        const renameOverride = checkSeriesNameOverride(filename);
        if (renameOverride) {
            seriesTitle = renameOverride.overrideName;
        }

        // Try to get anime info for any valid title
        // The API will return null if the title is not found, so we don't need to filter by media_type
        if (seriesTitle && seriesTitle !== "N/A") {
            try {
                // Try to get anime info with source provider for overflow resolution
                const animeResult = await getAnimeInfoWithProvider(seriesTitle, parsed.season);
                if (animeResult) {
                    const animeInfo = animeResult.animeInfo;
                    const sourceProvider = animeResult.sourceProvider;
                    metadataSourceProvider = sourceProvider;
                    coverImage = selectCoverImage(animeInfo);
                    malId = animeInfo.mal_id || null;
                    totalEpisodes = animeInfo.total_episodes || null;

                    // Resolve overflow for split cour anime
                    // When episode > total_episodes, find the correct cour
                    let overflowResolved = false;
                    const titlePref = config.settings.preferredTitleLanguage;
                    if (parsed.episode && animeInfo.total_episodes && parsed.episode > animeInfo.total_episodes) {
                        const overflowResult = await resolveOverflowEpisode(
                            animeInfo,
                            parsed.episode,
                            parsed.season,
                            sourceProvider,
                        );
                        if (overflowResult) {
                            overflowResolved = true;
                            // Use the resolved cour's info for display and MAL sync
                            malId = overflowResult.animeInfo.mal_id || null;
                            totalEpisodes = overflowResult.animeInfo.total_episodes || null;
                            adjustedEpisode = overflowResult.adjustedEpisode;
                            // Update display info to show the correct cour
                            coverImage = selectCoverImage(overflowResult.animeInfo, coverImage);
                            // Update series title to reflect the resolved cour
                            if (titlePref === "english") {
                                seriesTitle =
                                    overflowResult.animeInfo.title_english ||
                                    overflowResult.animeInfo.title_romaji ||
                                    seriesTitle;
                            } else {
                                seriesTitle =
                                    overflowResult.animeInfo.title_romaji ||
                                    overflowResult.animeInfo.title_english ||
                                    seriesTitle;
                            }
                        }
                    }

                    // Choose title based on preferred language setting
                    // Skip if overflow resolution already set the title to the correct cour
                    if (!overflowResolved && (titlePref !== "none" || renameOverride)) {
                        // When rename is active, always use API title (the whole point of rename
                        // is to correct the search, so the API result IS the desired title)
                        const englishTitle = animeInfo.title_english;
                        const romajiTitle = animeInfo.title_romaji;

                        if (titlePref === "english" || (titlePref === "none" && renameOverride)) {
                            // Prefer English, fallback to Romaji
                            seriesTitle = englishTitle || romajiTitle || seriesTitle;
                        } else {
                            // Prefer Romaji, fallback to English
                            seriesTitle = romajiTitle || englishTitle || seriesTitle;
                        }
                    }
                    // If "none" without rename, keep the original filename title
                }

                // Get episode title when it is missing, or refresh a parsed title
                // when TVDB is the metadata source and a localized language is configured.
                // Use override name when available, otherwise original title.
                if (parsed.episode !== null) {
                    const parsedEpisode = parsed.episode;
                    const episodeLookupTitle = renameOverride?.overrideName ?? originalTitle;
                    episodeTitle = await resolveRuntimeEpisodeTitle({
                        currentEpisodeTitle: episodeTitle,
                        episode: parsedEpisode,
                        metadataSourceProvider,
                        tvdbLanguage: config.tvdb.language,
                        fetchEpisodeTitle: () => getEpisodeTitle(episodeLookupTitle, parsed.season, parsedEpisode),
                    });
                }
            } catch (e) {
                console.error("[MPV] Error fetching anime metadata:", e);
            }
        }

        const mpvData: MpvData = {
            media_title: parsed.full_title,
            series_title: seriesTitle,
            season: parsed.season,
            episode: parsed.episode,
            episode_title: episodeTitle,
            filename: filename,
            path: typeof currentPath === "string" ? currentPath : undefined,
            pause: pause === true,
            percent_pos: typeof percent_pos === "number" ? percent_pos : 0,
            time_pos: typeof time_pos === "number" ? time_pos : 0,
            duration: typeof duration === "number" ? duration : 0,
            artist: typeof artist === "string" ? artist : "N/A",
            cover_image: coverImage,
            mal_id: malId,
            total_episodes: totalEpisodes,
            adjusted_episode: adjustedEpisode,
            playlistPos: typeof playlistPos === "number" ? playlistPos : 0,
            playlistCount: typeof playlistCount === "number" ? playlistCount : 0,
        };
        const stremioIdentity = readStremioPlaybackIdentity(mpvData);

        return {
            ...mpvData,
            imdb_id: stremioIdentity.imdbId,
            type: stremioIdentity.type,
        };
    } catch (e) {
        console.error("[MPV] Error getting data:", e);
        return null;
    }
}

/**
 * Build a clean display title and set it as force-media-title in MPV
 * This overrides the ugly embedded title like "Multi Subs / GB / RU / ..."
 */
export async function updateMpvTitle(data: MpvData): Promise<void> {
    if (!isConnected || !data || data.series_title === "N/A") return;

    let displayTitle = data.series_title;

    // Use adjusted episode for display when overflow is resolved
    const displayEpisode = data.adjusted_episode ?? data.episode;

    if (data.season !== null && displayEpisode !== null) {
        const s = String(data.season).padStart(2, "0");
        const e = String(displayEpisode).padStart(2, "0");
        displayTitle += ` S${s}E${e}`;
    } else if (displayEpisode !== null) {
        displayTitle += ` E${String(displayEpisode).padStart(2, "0")}`;
    }

    if (data.episode_title) {
        displayTitle += ` - ${data.episode_title}`;
    }

    try {
        await setProperty("force-media-title", displayTitle);
    } catch {
        // Silently ignore - some MPV versions may not support this
    }
}

/**
 * Clear the forced media title, restoring MPV's default title behavior
 */
export async function clearForcedTitle(): Promise<void> {
    if (!isConnected) return;
    try {
        await setProperty("force-media-title", "");
    } catch {
        // Silently ignore
    }
}
