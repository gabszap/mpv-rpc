/**
 * MPV IPC Module - Connects to MPV via Windows Named Pipes
 */

import * as net from "net";
import { config } from "./config";
import { parseFilename } from "./parser";
import { getAnimeInfo, getEpisodeTitle } from "./anime";

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
 * Get all MPV data needed for Discord presence
 */
export async function getMpvData(): Promise<MpvData | null> {
    if (!isConnected) {
        const connected = await connect();
        if (!connected) return null;
    }

    try {
        // Get filename first
        const filename = await getProperty("filename/no-ext");

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
            };
        }

        // Parse the filename
        const parsed = await parseFilename(filename);

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
        const originalTitle = parsed.series_title; // Keep original for episode lookup

        if (seriesTitle && seriesTitle !== "N/A") {
            try {
                // Try to get anime info
                const animeInfo = await getAnimeInfo(seriesTitle, parsed.season);
                if (animeInfo) {
                    coverImage = animeInfo.cover_url;

                    // Choose title based on preferred language setting
                    const titlePref = config.settings.preferredTitleLanguage;
                    if (titlePref !== "none") {
                        const englishTitle = animeInfo.title_english;
                        const romajiTitle = animeInfo.title_romaji;

                        if (titlePref === "english") {
                            // Prefer English, fallback to Romaji
                            seriesTitle = englishTitle || romajiTitle || seriesTitle;
                        } else {
                            // Prefer Romaji, fallback to English
                            seriesTitle = romajiTitle || englishTitle || seriesTitle;
                        }
                    }
                    // If "none", keep the original filename title
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
        };
    } catch (e) {
        console.error("[MPV] Error getting data:", e);
        return null;
    }
}
