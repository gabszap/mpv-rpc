/**
 * Discord RPC Module - Handles Discord Rich Presence
 */

import { Client } from "@xhayper/discord-rpc";
import { config } from "./config";
import type { MpvData } from "./mpv";
import { ActivityType, Assets } from "./functions/types";

let client: Client | null = null;
let isConnected = false;
let lastStatusLog = ""; // Avoid duplicate status logs

/**
 * Initialize and connect to Discord
 */
export async function connect(): Promise<boolean> {
    if (isConnected && client) {
        return true;
    }

    try {
        client = new Client({ clientId: config.clientId });

        client.on("ready", () => {
            console.log("[Discord] Connected as", client?.user?.username);
            isConnected = true;
        });

        client.on("disconnected", () => {
            console.log("[Discord] Disconnected");
            isConnected = false;
        });

        await client.login();

        // Wait a bit for connection
        await new Promise(resolve => setTimeout(resolve, 500));

        return isConnected;
    } catch (e) {
        console.error("[Discord] Connection error:", e);
        isConnected = false;
        return false;
    }
}

/**
 * Disconnect from Discord
 */
export async function disconnect(): Promise<void> {
    if (client) {
        try {
            await client.destroy();
        } catch (e) {
            // Ignore errors on disconnect
        }
        client = null;
        isConnected = false;
    }
}

/**
 * Check connection status
 */
export function getConnectionStatus(): boolean {
    return isConnected;
}

/**
 * Clear the Discord activity
 */
export async function clearActivity(): Promise<void> {
    if (!client || !isConnected) return;

    try {
        await client.user?.clearActivity();
    } catch (e) {
        console.error("[Discord] Error clearing activity:", e);
    }
}

/**
 * Log status to terminal (avoids duplicates, ignores pause state changes)
 */
function logStatus(data: MpvData, options: { privacyMode?: boolean } = {}): void {
    const title = data.series_title !== "N/A" ? data.series_title : data.media_title;
    // Clean title (remove "- Season X" suffix)
    const cleanTitle = title.replace(/\s*[-–]\s*Season\s*\d+$/i, "").trim();

    let statusLog = `Watching "${cleanTitle}`;
    if (data.season !== null && data.episode !== null) {
        statusLog += ` S${String(data.season).padStart(2, "0")}E${String(data.episode).padStart(2, "0")}`;
    }
    if (data.episode_title) {
        statusLog += ` - ${data.episode_title}`;
    }
    statusLog += `"`;
    if (options.privacyMode) statusLog += " (Privacy Mode)";

    // Only log when content changes (ignore pause state changes)
    if (statusLog !== lastStatusLog) {
        console.log(`[Status] ${statusLog}`);
        lastStatusLog = statusLog;
    }
}

/**
 * Update Discord Rich Presence with MPV data
 */
export async function setActivity(data: MpvData): Promise<void> {
    if (!client || !isConnected) {
        const connected = await connect();
        if (!connected) return;
    }

    // Privacy Mode
    if (config.settings.privacyMode) {
        try {
            await client!.user?.setActivity({
                type: ActivityType.Playing,
                details: "Watching something",
                largeImageKey: config.mpvIcon,
                largeImageText: "MPV Media Player",
            });
            logStatus(data, { privacyMode: true });
        } catch (e) {
            console.error("[Discord] Error setting activity:", e);
        }
        return;
    }

    // Check for idle state
    if (data.media_title === "N/A" || data.filename === "N/A" || !data.filename) {
        if (config.settings.hideIdling) {
            await clearActivity();
            return;
        }

        try {
            await client!.user?.setActivity({
                type: ActivityType.Playing,
                details: "Idling...",
                state: "No media playing",
                largeImageKey: config.mpvIcon,
                largeImageText: "MPV Media Player",
            });
        } catch (e) {
            console.error("[Discord] Error setting activity:", e);
        }
        return;
    }

    const isPaused = data.pause;
    const fullTitle = data.series_title !== "N/A" ? data.series_title : data.media_title;

    // Clean title (remove "- Season X" suffix for activity name)
    const cleanTitle = fullTitle.replace(/\s*[-–]\s*Season\s*\d+$/i, "").trim();

    // Build state string
    let state = "";
    let details = fullTitle; // Default: show full title in details

    // When showTitleAsPresence is active, avoid duplicating title (it's already in activity name)
    if (config.settings.showTitleAsPresence) {
        if (data.season !== null && data.episode !== null) {
            // SxEx format
            details = data.episode_title || `Episode ${data.episode}`;
            state = "on MPV";
        } else if (data.episode !== null) {
            // Episode only (no season)
            details = data.episode_title
                ? `Episode ${data.episode} - ${data.episode_title}`
                : `Episode ${data.episode}`;
            state = "on MPV";
        } else if (data.episode_title) {
            details = data.episode_title;
            state = "on MPV";
        } else {
            details = "on MPV";
            state = "";
        }
    } else if (data.season !== null && data.episode !== null) {
        // Discord already shows badge with season/episode, so just show title
        state = data.episode_title || "";
    } else if (data.episode !== null) {
        // Episode only (no season) - show episode info in state
        if (data.episode_title) {
            state = `Episode ${data.episode} - ${data.episode_title}`;
        } else {
            state = `Episode ${data.episode}`;
        }
    } else if (data.episode_title) {
        // Only have episode title (no episode number) - show title as state
        state = data.episode_title;
    } else if (data.artist !== "N/A") {
        state = `by ${data.artist}`;
    } else {
        state = isPaused ? "Paused" : `Playing - ${data.percent_pos.toFixed(1)}%`;
    }

    // Determine image
    const largeImage = config.settings.showCover && data.cover_image ? data.cover_image : config.mpvIcon;

    // Format large image text for Season/Episode badge
    let largeText = "MPV Media Player";
    if (config.settings.showCover && data.cover_image && data.season !== null && data.episode !== null) {
        largeText = `Season ${data.season}, Episode ${data.episode}`;
    }

    // Calculate timestamps for progress bar
    const now = Date.now();
    const startTimestamp = isPaused ? undefined : Math.floor((now - data.time_pos * 1000) / 1000);
    const endTimestamp = isPaused ? undefined : Math.floor((now + (data.duration - data.time_pos) * 1000) / 1000);

    // Activity name - use clean title or "MPV" based on setting
    const activityName = config.settings.showTitleAsPresence ? cleanTitle : undefined;

    try {
        await client!.user?.setActivity({
            type: ActivityType.Watching,
            name: activityName,
            details,
            state: state || undefined,
            startTimestamp,
            endTimestamp,
            largeImageKey: largeImage,
            largeImageText: largeText,
            smallImageKey: isPaused ? Assets.Pause : Assets.Play,
            smallImageText: isPaused ? "Paused" : "Watching",
        });
        logStatus(data);
    } catch (e) {
        console.error("[Discord] Error setting activity:", e);
    }
}
