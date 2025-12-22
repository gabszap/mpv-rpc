/**
 * MPV Discord RPC - Main Entry Point
 * 
 * Connects MPV Media Player directly to Discord Rich Presence
 */

import { config } from "./config";
import * as mpv from "./mpv";
import * as discord from "./discord";
import { checkAvailability } from "./parser";

let updateInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let isUpdating = false; // Mutex to prevent parallel updates

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
            return;
        }

        // Update Discord presence
        await discord.setActivity(data);
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
    console.log("[Main] Connecting to Discord...");
    const discordConnected = await discord.connect();

    if (!discordConnected) {
        console.log("[Main] Failed to connect to Discord. Is Discord running?");
        console.log("[Main] Will retry in background...");
    } else {
        console.log("[Main] Discord connected!");
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

    await discord.clearActivity();
    await discord.disconnect();
    mpv.disconnect();

    console.log("[Main] Goodbye!");
    process.exit(0);
}

// Handle graceful shutdown
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Start the service
start().catch((e) => {
    console.error("[Main] Fatal error:", e);
    process.exit(1);
});
