/**
 * Configuration for MPV Discord RPC
 */

import * as fs from "fs";
import * as path from "path";

// Load .env file manually (no external dependency)
function loadEnv(): Record<string, string> {
    const envPath = path.join(process.cwd(), ".env");
    const env: Record<string, string> = {};

    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const [key, ...valueParts] = trimmed.split("=");
            if (key) {
                env[key.trim()] = valueParts.join("=").trim();
            }
        }
    }
    return env;
}

const env = loadEnv();

// Helper to get env value with fallback
function getEnv(key: string, fallback: string): string {
    return process.env[key] || env[key] || fallback;
}

function getEnvBool(key: string, fallback: boolean): boolean {
    const val = getEnv(key, String(fallback));
    return val === "true" || val === "1";
}

// Detect OS and set default IPC path
function getDefaultMpvPath(): string {
    if (process.platform === "win32") {
        return "\\\\.\\pipe\\mpv";
    }
    // Linux/macOS use Unix socket
    return "/tmp/mpv-socket";
}

export const config = {
    // Discord Application Client ID
    clientId: getEnv("DISCORD_CLIENT_ID", "1450169544701378570"),

    // MPV IPC path (auto-detected by OS if not set)
    mpvPipePath: getEnv("MPV_IPC_PATH", getDefaultMpvPath()),

    // Update interval in milliseconds
    updateInterval: 1000,

    // MPV icon URL
    mpvIcon: "https://i.imgur.com/gGwczqt.png",

    // User settings (can be configured via .env)
    settings: {
        showCover: getEnvBool("SHOW_COVER", true),
        privacyMode: getEnvBool("PRIVACY_MODE", false),
        hideIdling: getEnvBool("HIDE_IDLING", false),
        showTitleAsPresence: getEnvBool("SHOW_TITLE", true),
        preferredTitleLanguage: getEnv("TITLE_LANG", "none") as "english" | "romaji" | "none",
    },

    // Metadata provider (jikan, anilist, or kitsu)
    metadataProvider: getEnv("METADATA_PROVIDER", "jikan") as "jikan" | "anilist" | "kitsu",

    // Jikan API settings (hardcoded)
    jikan: {
        baseUrl: "https://api.jikan.moe/v4",
        minRequestInterval: 500,
    },

    // MyAnimeList sync settings
    mal: {
        enabled: getEnvBool("MAL_SYNC", false),
        clientId: getEnv("MAL_CLIENT_ID", ""),
        syncThreshold: parseInt(getEnv("MAL_SYNC_THRESHOLD", "90"), 10), // % watched to trigger sync
    },
};

export type Config = typeof config;
