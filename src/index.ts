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
import { syncEpisodeDetailed, authorize, isAuthenticated, getUsername } from "./mal-sync/sync";
import { ConsoleRepl, createEpisodeContext } from "./console";

let consoleRepl: ConsoleRepl | null = null;

let updateInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let isUpdating = false; // Mutex to prevent parallel updates
let lastMalDiagnosticKey: string | null = null; // Avoid repeating MAL diagnostic logs
let lastMalSyncSuccessKey: string | null = null; // Avoid repeated MAL success logs

function logMalDiagnostic(key: string, message: string): void {
    if (lastMalDiagnosticKey === key) {
        return;
    }

    lastMalDiagnosticKey = key;
    console.log(message);
}

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
            lastMalDiagnosticKey = null;
            lastMalSyncSuccessKey = null;
            return;
        }

        // Update episode context for the REPL (for manual override tracking)
        if (consoleRepl) {
            const context = createEpisodeContext(
                data.filename,
                data.series_title,
                data.season,
                data.episode
            );
            consoleRepl.updateContext(context, data.filename);
        }

        // Update Discord presence (if enabled)
        if (config.settings.discordRpc) {
            await discord.setActivity(data);
        } else {
            // Still log status to terminal even with RPC off
            discord.logStatus(data);
        }

        // Force a clean title in MPV (replaces ugly embedded titles like "Multi Subs / GB / RU...")
        await mpv.updateMpvTitle(data);

        // MAL sync - diagnostics + sync attempt once threshold is reached
        const malThresholdReached = data.percent_pos >= config.mal.syncThreshold;
        if (config.mal.enabled && isAuthenticated() && malThresholdReached) {
            if (!data.episode) {
                logMalDiagnostic(
                    `${data.filename}:missing-episode`,
                    `[MAL] Skipped sync at ${Math.round(data.percent_pos)}%: episode number not detected (title may be missing episode marker like E02 or - 02).`
                );
            }

            if (!data.mal_id) {
                logMalDiagnostic(
                    `${data.filename}:missing-mal-id`,
                    `[MAL] Skipped sync at ${Math.round(data.percent_pos)}%: MAL ID not found for "${data.series_title}".`
                );
            }

            if (data.mal_id && data.episode) {
                const syncEpisode = data.adjusted_episode ?? data.episode;
                const syncStatus = await syncEpisodeDetailed(
                    data.mal_id,
                    syncEpisode,
                    data.percent_pos,
                    data.total_episodes ?? undefined
                );

                const syncKey = `${data.filename}:${data.mal_id}:${syncEpisode}`;
                const progressLabel = data.total_episodes
                    ? `${syncEpisode}/${data.total_episodes}`
                    : `${syncEpisode}`;

                if (syncStatus === "updated") {
                    if (lastMalSyncSuccessKey !== syncKey) {
                        console.log(`[MAL] Synced progress: ${data.series_title} - EP ${progressLabel} (MAL ID: ${data.mal_id})`);
                        lastMalSyncSuccessKey = syncKey;
                    }
                    lastMalDiagnosticKey = null;
                } else if (syncStatus === "already_synced") {
                    if (lastMalSyncSuccessKey !== syncKey) {
                        console.log(`[MAL] Already synced: ${data.series_title} - EP ${progressLabel} (MAL ID: ${data.mal_id})`);
                        lastMalSyncSuccessKey = syncKey;
                    }
                    lastMalDiagnosticKey = null;
                } else if (syncStatus === "failed") {
                    logMalDiagnostic(
                        `${data.filename}:sync-failed`,
                        `[MAL] Sync request failed (API/network/auth issue).`
                    );
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
    if (config.guessitApi.enabled && config.guessitApi.url) {
        console.log(`[Main] GuessIt API enabled: ${config.guessitApi.url}`);
    } else {
        const guessitAvailable = await checkAvailability();
        if (guessitAvailable) {
            console.log("[Main] GuessIt CLI found! Advanced parsing enabled.");
        } else {
            console.warn("[Main] WARNING: No GuessIt available. Using basic fallback parser.");
            console.warn("       Set GUESSIT_API_URL in .env for cloud-based parsing (no Python needed).");
            console.warn("       See guessit-api/README.md for deployment instructions.");
        }
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
        const ipcPath = process.platform === "win32" ? "\\\\.\\pipe\\mpv" : "/tmp/mpv-socket";
        console.log("[Main] MPV not found. Make sure MPV is running with IPC enabled:");
        console.log(`       mpv --input-ipc-server=${ipcPath} <file>`);
        console.log("[Main] Will keep checking for MPV...");
    } else {
        console.log("[Main] MPV connected!");
    }

    console.log("");
    console.log("[Main] Service started. Press Ctrl+C to stop.");
    console.log("[Main] Type 'help' for available commands.");
    console.log("");

    // Initialize console REPL for manual title override
    consoleRepl = new ConsoleRepl();
    consoleRepl.on('overrideSet', () => {
        // Trigger immediate presence update when override is set
        update();
    });
    consoleRepl.on('overrideCleared', () => {
        // Trigger immediate presence update when override is cleared
        update();
    });
    consoleRepl.on('renameSet', () => {
        // Trigger immediate re-fetch when series name is overridden
        update();
    });
    consoleRepl.on('renameCleared', () => {
        // Trigger immediate re-fetch when series name override is cleared
        update();
    });
    consoleRepl.on('exit', () => {
        stop();
    });

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

    if (consoleRepl) {
        consoleRepl.close();
        consoleRepl = null;
    }

    if (config.settings.discordRpc) {
        await discord.clearActivity();
        await discord.disconnect();
    }
    // Clear forced title before disconnecting so MPV returns to normal titles
    await mpv.clearForcedTitle();
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
