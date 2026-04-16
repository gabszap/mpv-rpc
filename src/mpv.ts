/**
 * MPV IPC Module - Connects to MPV via IPC
 * Windows: Named Pipes (\\.\pipe\mpv)
 * Linux/macOS: Unix Sockets (/tmp/mpv-socket)
 */

import * as net from "net";
import { config } from "./config";
import { parseFilename } from "./parser";
import { getAnimeInfo, getEpisodeTitle } from "./anime";
import { checkSeriesNameOverride } from "./console";

export interface MpvData {
    media_title: string;
    series_title: string;
    season: number | null;
    episode: number | null;
    episode_title: string | null;
    filename: string;
    pause: boolean;
    percent_pos: number;
    time_pos: number;
    duration: number;
    artist: string;
    cover_image: string | null;
    mal_id: number | null;        // For MAL sync
    total_episodes: number | null; // For MAL sync (mark as completed)
    imdb_id?: string;            // For Stremio sync
    type?: string;               // For Stremio sync
}

let socket: net.Socket | null = null;
let requestId = 1;
let isConnected = false;
let pendingRequests: Map<number, (data: any) => void> = new Map();
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
                        const callback = pendingRequests.get(id)!;
                        pendingRequests.delete(id);
                        callback(response.data);
                    }
                } catch (e) {
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
        const msg = JSON.stringify({ command, request_id: id }) + "\n";

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
    title = title.replace(/\s*[◎▌⚙️💾👤].*$/u, "");

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
        const [filename, rawMediaTitle] = await Promise.all([
            getProperty("filename/no-ext"),
            getProperty("media-title")
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
            return /S\d{1,2}E\d{1,3}/i.test(s)
                || /(?:^|[\s._-])[Ee][Pp]?(?:isode)?[\s._-]*\d{1,3}(?=[^\d]|$)/.test(s)
                || /-\s*\d{1,3}(?=\s*(?:\[|\(|v\d|$))/i.test(s);
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
        const [pause, percent_pos, time_pos, duration, artist] = await Promise.all([
            getProperty("pause"),
            getProperty("percent-pos"),
            getProperty("time-pos"),
            getProperty("duration"),
            getProperty("metadata/by-key/Artist"),
        ]);

        // Fetch anime metadata
        let coverImage: string | null = null;
        let episodeTitle = parsed.episode_title;
        let seriesTitle = parsed.series_title;
        let malId: number | null = null;
        let totalEpisodes: number | null = null;
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
                // Try to get anime info
                const animeInfo = await getAnimeInfo(seriesTitle, parsed.season);
                if (animeInfo) {
                    coverImage = animeInfo.cover_url;
                    malId = animeInfo.mal_id || null;
                    totalEpisodes = animeInfo.total_episodes || null;

                    // Choose title based on preferred language setting
                    const titlePref = config.settings.preferredTitleLanguage;
                    if (titlePref !== "none" || renameOverride) {
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

                // Get episode title if not in filename
                // Use originalTitle to reuse the same cache key
                if (!episodeTitle && parsed.episode) {
                    const epTitle = await getEpisodeTitle(originalTitle, parsed.season, parsed.episode);
                    if (epTitle) {
                        episodeTitle = epTitle;
                    }
                }
            } catch (e) {
                console.error("[MPV] Error fetching anime metadata:", e);
            }
        }

        return {
            media_title: parsed.full_title,
            series_title: seriesTitle,
            season: parsed.season,
            episode: parsed.episode,
            episode_title: episodeTitle,
            filename: filename,
            pause: pause === true,
            percent_pos: typeof percent_pos === "number" ? percent_pos : 0,
            time_pos: typeof time_pos === "number" ? time_pos : 0,
            duration: typeof duration === "number" ? duration : 0,
            artist: typeof artist === "string" ? artist : "N/A",
            cover_image: coverImage,
            mal_id: malId,
            total_episodes: totalEpisodes,
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

    if (data.season !== null && data.episode !== null) {
        const s = String(data.season).padStart(2, "0");
        const e = String(data.episode).padStart(2, "0");
        displayTitle += ` S${s}E${e}`;
    } else if (data.episode !== null) {
        displayTitle += ` E${String(data.episode).padStart(2, "0")}`;
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
