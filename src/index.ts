/**
 * MPV Discord RPC - Main Entry Point
 * 
 * Connects MPV Media Player directly to Discord Rich Presence
 */

import { config } from "./config";
import * as mpv from "./mpv";
import * as discord from "./discord";
import { checkAvailability } from "./parser";
import { providerName } from "./anime";
import { syncEpisode, authorize, isAuthenticated, getUsername } from "./mal-sync/sync";
import axios from "axios";

let updateInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let isUpdating = false; // Mutex to prevent parallel updates
let lastScrobbledFile: string | null = null; // Prevent scrobble spam
let scrobbleRetryCount: number = 0; // Track retry attempts per file
let scrobbleRetryFile: string | null = null; // Track which file we're retrying
const MAX_SCROBBLE_RETRIES = 3; // Maximum retry attempts before giving up

/**
 * Main update loop - fetches MPV data and updates Discord
 */
async function update(): Promise<void> {
    // Skip if already updating (prevents parallel updates)
    if (isUpdating) return;

    isUpdating = true;
    try {
        // Get data from MPV
        const data = await mpv.getMpvData();

        if (!data) {
            // MPV not connected, clear Discord activity
            await discord.clearActivity();
            lastScrobbledFile = null; // Reset on disconnect
            return;
        }

        // Update Discord presence
        if (config.settings.discordRpc) {
            await discord.setActivity(data);
        }

        // MAL sync - if enabled and watching anime
        if (data.mal_id && data.episode && data.percent_pos >= config.mal.syncThreshold) {
            await syncEpisode(data.mal_id, data.episode, data.percent_pos, data.total_episodes ?? undefined);
        }

        // Bridge scrobble (Stremio sync) - notifies bridge of current progress
        // Only scrobble once per file when threshold reached
        if (data.percent_pos >= 90 && lastScrobbledFile !== data.filename) {
            // Reset retry count if this is a new file
            if (scrobbleRetryFile !== data.filename) {
                scrobbleRetryFile = data.filename;
                scrobbleRetryCount = 0;
            }

            // Only try if we haven't exceeded max retries
            if (scrobbleRetryCount < MAX_SCROBBLE_RETRIES) {
                console.log(`[Status] Sending scrobble request to bridge (${Math.round(data.percent_pos)}%)...`);
                try {
                    const res = await axios.post('http://127.0.0.1:9632/scrobble', {
                        percent: data.percent_pos,
                        imdbId: data.imdb_id,
                        season: data.season,
                        episode: data.episode,
                        type: data.type,
                        title: data.media_title // Send title for matching in server
                    });
                    if (res.data.success || res.status === 200) {
                        lastScrobbledFile = data.filename;
                        scrobbleRetryCount = 0; // Reset on success
                    }
                } catch (e) {
                    scrobbleRetryCount++;
                    if (scrobbleRetryCount >= MAX_SCROBBLE_RETRIES) {
                        console.log(`[Status] Bridge not reachable, giving up after ${MAX_SCROBBLE_RETRIES} attempts.`);
                    }
                }
            }
        }
    } catch (e) {
        console.error("[Main] Update error:", e);
    } finally {
        isUpdating = false;
    }
}

/**
 * Start the RPC service
 */
async function start(): Promise<void> {
    console.log("╔════════════════════════════════════════╗");
    console.log("║       MPV Discord Rich Presence        ║");
    console.log("╚════════════════════════════════════════╝");
    console.log("");

    isRunning = true;

    // Connect to Discord
    if (config.settings.discordRpc) {
        console.log("[Main] Connecting to Discord...");
        const discordConnected = await discord.connect();

        if (!discordConnected) {
            console.log("[Main] Failed to connect to Discord. Is Discord running?");
            console.log("[Main] Will retry in background...");
        } else {
            console.log("[Main] Discord connected!");
        }
    } else {
        console.log("[Discord] RPC Disabled");
    }

    // Check Parser availability
    console.log("[Main] Checking parser...");
    const guessitAvailable = await checkAvailability();
    if (guessitAvailable) {
        console.log("[Main] GuessIt found! Advanced parsing enabled.");
    } else {
        console.warn("[Main] WARNING: GuessIt not found. Using basic fallback parser.");
        console.warn("       Install Python and run 'pip install guessit' for better accuracy.");
    }

    // Show metadata provider
    console.log(`[Main] Metadata provider: ${providerName}`);

    // Show MAL sync status
    if (config.mal.enabled) {
        if (isAuthenticated()) {
            const username = await getUsername();
            console.log("[Main] MAL sync: enabled (authenticated)");
            if (username) {
                console.log(`[Main] MAL sync: logged in as ${username}`);
            }
        } else {
            console.log("[Main] MAL sync: enabled (not authenticated - run with 'mal-auth' to authorize)");
        }
    } else {
        console.log("[Main] MAL sync: disabled");
    }

    // Try to connect to MPV
    console.log("[Main] Looking for MPV...");
    const mpvConnected = await mpv.connect();

    if (!mpvConnected) {
        console.log("[Main] MPV not found. Make sure MPV is running with IPC enabled:");
        console.log("       mpv --input-ipc-server=\\\\.\\pipe\\mpv <file>");
        console.log("[Main] Will keep checking for MPV...");
    } else {
        console.log("[Main] MPV connected!");
    }

    console.log("");
    console.log("[Main] Service started. Press Ctrl+C to stop.");
    console.log("");

    // Start update loop
    updateInterval = setInterval(update, config.updateInterval);

    // Initial update
    await update();
}

/**
 * Stop the RPC service
 */
async function stop(): Promise<void> {
    console.log("\n[Main] Shutting down...");
    isRunning = false;

    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }

    if (config.settings.discordRpc) {
        await discord.clearActivity();
        await discord.disconnect();
    }
    mpv.disconnect();

    console.log("[Main] Goodbye!");
    process.exit(0);
}

// Handle graceful shutdown
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Check for CLI commands
const args = process.argv.slice(2);

if (args.includes("mal-auth")) {
    // MAL authorization mode
    console.log("[MAL] Starting authorization flow...");
    authorize().then((success) => {
        if (success) {
            console.log("[MAL] Authorization complete! You can now restart mpv-rpc.");
        } else {
            console.log("[MAL] Authorization failed or cancelled.");
        }
        process.exit(success ? 0 : 1);
    });
} else {
    // Normal mode - Start the service
    start().catch((e) => {
        console.error("[Main] Fatal error:", e);
        process.exit(1);
    });
}
