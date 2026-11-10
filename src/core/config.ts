/**
 * Configuration for MPV Discord RPC
 */

import * as path from "node:path";
import * as dotenv from "dotenv";

export const METADATA_PROVIDERS = ["jikan", "anilist", "kitsu", "tvdb"] as const;
export type MetadataProvider = (typeof METADATA_PROVIDERS)[number];

const envPath = path.join(process.cwd(), ".env");
const dotenvResult = dotenv.config({ path: envPath });

if (dotenvResult.error) {
    const maybeErrno = dotenvResult.error as NodeJS.ErrnoException;
    if (maybeErrno.code !== "ENOENT") {
        console.warn(`[Config] Failed to load .env file at ${envPath}: ${dotenvResult.error.message}`);
    }
}

const selectedMetadataProvider = parseMetadataProvider(getEnv("METADATA_PROVIDER", "jikan"));

// Helper to get env value with fallback
function getEnv(key: string, fallback: string): string {
    return process.env[key] || fallback;
}

function getEnvBool(key: string, fallback: boolean): boolean {
    const val = getEnv(key, String(fallback));
    return val === "true" || val === "1";
}

function isMetadataProvider(value: string): value is MetadataProvider {
    return METADATA_PROVIDERS.includes(value as MetadataProvider);
}

function parseMetadataProvider(rawProvider: string): MetadataProvider {
    const normalizedProvider = rawProvider.trim().toLowerCase();

    if (isMetadataProvider(normalizedProvider)) {
        return normalizedProvider;
    }

    if (normalizedProvider) {
        console.warn(`[Config] Invalid METADATA_PROVIDER "${rawProvider}". Falling back to "jikan".`);
    }

    return "jikan";
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
    updateInterval: parseInt(getEnv("UPDATE_INTERVAL", "1000"), 10) || 1000,

    // Debug mode (enables detailed provider error logs)
    debug: getEnvBool("DEBUG", false),

    // MPV icon URL
    mpvIcon: "https://i.imgur.com/gGwczqt.png",

    // User settings (can be configured via .env)
    settings: {
        showCover: getEnvBool("SHOW_COVER", true),
        privacyMode: getEnvBool("PRIVACY_MODE", false),
        hideIdling: getEnvBool("HIDE_IDLING", false),
        showTitleAsPresence: getEnvBool("SHOW_TITLE", true),
        preferredTitleLanguage: (() => {
            const val = getEnv("TITLE_LANG", "none").toLowerCase();
            if (val === "english" || val === "eng") return "english";
            if (val === "romaji") return "romaji";
            return "none";
        })(),
        discordRpc: getEnvBool("DISCORD_RPC", true),
    },

    // Metadata provider (jikan, anilist, kitsu, or tvdb)
    metadataProvider: selectedMetadataProvider,

    // Jikan API settings (jikan-edge)
    jikan: {
        baseUrl: "https://jikan.lucashdo.com/v1",
        minRequestInterval: 500,
    },

    // TheTVDB API settings
    tvdb: {
        apiKey: getEnv("TVDB_API_KEY", ""),
        language: getEnv("TVDB_LANG", "eng"),
    },

    // TMDb settings (movies and non-anime series metadata)
    tmdb: {
        apiKey: getEnv("TMDB_API_KEY", ""),
        language: getEnv("TMDB_LANG", "en-US"),
    },

    // MyAnimeList sync settings
    mal: {
        enabled: getEnvBool("MAL_SYNC", false),
        clientId: getEnv("MAL_CLIENT_ID", ""),
        syncThreshold: parseInt(getEnv("MAL_SYNC_THRESHOLD", "90"), 10), // % watched to trigger sync
    },

    // Simkl scrobbling (independent from MAL/Trakt; completion only on stop).
    simkl: {
        enabled: getEnvBool("SIMKL_SYNC", false),
        clientId: getEnv("SIMKL_CLIENT_ID", ""),
        syncThreshold: Math.max(50, Math.min(100, parseInt(getEnv("SIMKL_SYNC_THRESHOLD", "80"), 10) || 80)),
    },

    // Trakt.tv sync settings
    trakt: {
        enabled: getEnvBool("TRAKT_SYNC", false),
        clientId: getEnv("TRAKT_CLIENT_ID", ""),
        clientSecret: getEnv("TRAKT_CLIENT_SECRET", ""),
        syncThreshold: Math.max(1, Math.min(100, parseInt(getEnv("TRAKT_SYNC_THRESHOLD", "81"), 10) || 81)), // % watched to trigger scrobble
        useTor: getEnvBool("TRAKT_USE_TOR", false),
        torProxy: getEnv("TRAKT_TOR_PROXY", "socks5://127.0.0.1:9050"),
    },

    // Stremio sync settings
    stremio: {
        enabled: getEnvBool("STREMIO_SYNC", false),
        syncThreshold: Math.max(1, Math.min(100, parseInt(getEnv("STREMIO_SYNC_THRESHOLD", "85"), 10) || 85)),
        progressIntervalMs: Math.max(30000, parseInt(getEnv("STREMIO_PROGRESS_INTERVAL_MS", "90000"), 10) || 90000),
    },

    // Auto-fetch settings (automatically fetch next episodes near playlist end).
    // This is the fallback default consulted only when the bridge config is missing
    // `autoFetch.enabled`. Runtime state is owned by the bridge config + extraEpisodes.
    autoFetch: {
        enabled: getEnvBool("AUTO_FETCH", true),
    },

    // Sync dry-run (logs would-be MAL updates, Trakt scrobbles, Stremio writes,
    // and Auto-Fetch POSTs without actually executing them).
    syncDryRun: getEnvBool("SYNC_DRY_RUN", false),
};

export type Config = typeof config;

/**
 * Re-read .env and update the config object in-place.
 * Returns the list of changed keys (for logging).
 */
export function reloadConfig(): string[] {
    const changes: string[] = [];

    // Re-read .env
    const reloadResult = dotenv.config({ path: envPath, override: true });
    if (reloadResult.error) {
        const maybeErrno = reloadResult.error as NodeJS.ErrnoException;
        if (maybeErrno.code !== "ENOENT") {
            console.warn(`[Config] Failed to reload .env: ${reloadResult.error.message}`);
        }
    }

    // Core fields
    const newInterval = parseInt(getEnv("UPDATE_INTERVAL", "1000"), 10) || 1000;
    if (config.updateInterval !== newInterval) {
        changes.push(`UPDATE_INTERVAL: ${JSON.stringify(config.updateInterval)} -> ${JSON.stringify(newInterval)}`);
        config.updateInterval = newInterval;
    }

    const newDebug = getEnvBool("DEBUG", false);
    if (config.debug !== newDebug) {
        changes.push(`DEBUG: ${JSON.stringify(config.debug)} -> ${JSON.stringify(newDebug)}`);
        config.debug = newDebug;
    }

    const newClientId = getEnv("DISCORD_CLIENT_ID", "1450169544701378570");
    if (config.clientId !== newClientId) {
        changes.push("DISCORD_CLIENT_ID changed");
        config.clientId = newClientId;
    }

    const newMpvPath = getEnv("MPV_IPC_PATH", getDefaultMpvPath());
    if (config.mpvPipePath !== newMpvPath) {
        changes.push(`MPV_IPC_PATH: ${config.mpvPipePath} -> ${newMpvPath}`);
        config.mpvPipePath = newMpvPath;
    }

    const newProvider = parseMetadataProvider(getEnv("METADATA_PROVIDER", "jikan"));
    if (config.metadataProvider !== newProvider) {
        changes.push(`METADATA_PROVIDER: ${config.metadataProvider} -> ${newProvider}`);
        config.metadataProvider = newProvider;
    }

    // Settings
    const newShowCover = getEnvBool("SHOW_COVER", true);
    if (config.settings.showCover !== newShowCover) {
        changes.push(`SHOW_COVER: ${config.settings.showCover} -> ${newShowCover}`);
        config.settings.showCover = newShowCover;
    }

    const newPrivacy = getEnvBool("PRIVACY_MODE", false);
    if (config.settings.privacyMode !== newPrivacy) {
        changes.push(`PRIVACY_MODE: ${config.settings.privacyMode} -> ${newPrivacy}`);
        config.settings.privacyMode = newPrivacy;
    }

    const newHideIdling = getEnvBool("HIDE_IDLING", false);
    if (config.settings.hideIdling !== newHideIdling) {
        changes.push(`HIDE_IDLING: ${config.settings.hideIdling} -> ${newHideIdling}`);
        config.settings.hideIdling = newHideIdling;
    }

    const newShowTitle = getEnvBool("SHOW_TITLE", true);
    if (config.settings.showTitleAsPresence !== newShowTitle) {
        changes.push(`SHOW_TITLE: ${config.settings.showTitleAsPresence} -> ${newShowTitle}`);
        config.settings.showTitleAsPresence = newShowTitle;
    }

    const newDiscordRpc = getEnvBool("DISCORD_RPC", true);
    if (config.settings.discordRpc !== newDiscordRpc) {
        changes.push(`DISCORD_RPC: ${config.settings.discordRpc} -> ${newDiscordRpc}`);
        config.settings.discordRpc = newDiscordRpc;
    }

    // TITLE_LANG
    const newTitleLang = (() => {
        const val = getEnv("TITLE_LANG", "none").toLowerCase();
        if (val === "english" || val === "eng") return "english";
        if (val === "romaji") return "romaji";
        return "none";
    })();
    if (config.settings.preferredTitleLanguage !== newTitleLang) {
        changes.push(`TITLE_LANG: ${config.settings.preferredTitleLanguage} -> ${newTitleLang}`);
        (config.settings as Record<string, unknown>).preferredTitleLanguage = newTitleLang;
    }

    // TVDB
    const newTvdbKey = getEnv("TVDB_API_KEY", "");
    if (config.tvdb.apiKey !== newTvdbKey) {
        changes.push("TVDB_API_KEY changed");
        config.tvdb.apiKey = newTvdbKey;
    }

    const newTvdbLang = getEnv("TVDB_LANG", "eng");
    if (config.tvdb.language !== newTvdbLang) {
        changes.push(`TVDB_LANG: ${config.tvdb.language} -> ${newTvdbLang}`);
        config.tvdb.language = newTvdbLang;
    }

    // TMDb
    const newTmdbKey = getEnv("TMDB_API_KEY", "");
    if (config.tmdb.apiKey !== newTmdbKey) {
        changes.push("TMDB_API_KEY changed");
        config.tmdb.apiKey = newTmdbKey;
    }

    const newTmdbLang = getEnv("TMDB_LANG", "en-US");
    if (config.tmdb.language !== newTmdbLang) {
        changes.push(`TMDB_LANG: ${config.tmdb.language} -> ${newTmdbLang}`);
        config.tmdb.language = newTmdbLang;
    }

    // MAL
    const newMalEnabled = getEnvBool("MAL_SYNC", false);
    if (config.mal.enabled !== newMalEnabled) {
        changes.push(`MAL_SYNC: ${config.mal.enabled} -> ${newMalEnabled}`);
        config.mal.enabled = newMalEnabled;
    }

    const newMalClientId = getEnv("MAL_CLIENT_ID", "");
    if (config.mal.clientId !== newMalClientId) {
        changes.push("MAL_CLIENT_ID changed");
        config.mal.clientId = newMalClientId;
    }

    const newMalThreshold = parseInt(getEnv("MAL_SYNC_THRESHOLD", "90"), 10);
    if (config.mal.syncThreshold !== newMalThreshold) {
        changes.push(`MAL_SYNC_THRESHOLD: ${config.mal.syncThreshold} -> ${newMalThreshold}`);
        config.mal.syncThreshold = newMalThreshold;
    }

    // Simkl
    const simklEnabled = getEnvBool("SIMKL_SYNC", false);
    const simklClient = getEnv("SIMKL_CLIENT_ID", "");
    const simklThreshold = Math.max(50, Math.min(100, parseInt(getEnv("SIMKL_SYNC_THRESHOLD", "80"), 10) || 80));
    if (config.simkl.enabled !== simklEnabled) {
        changes.push(`SIMKL_SYNC: ${config.simkl.enabled} -> ${simklEnabled}`);
        config.simkl.enabled = simklEnabled;
    }
    if (config.simkl.clientId !== simklClient) {
        changes.push("SIMKL_CLIENT_ID changed");
        config.simkl.clientId = simklClient;
    }
    if (config.simkl.syncThreshold !== simklThreshold) {
        changes.push(`SIMKL_SYNC_THRESHOLD: ${config.simkl.syncThreshold} -> ${simklThreshold}`);
        config.simkl.syncThreshold = simklThreshold;
    }

    // Trakt
    const newTraktEnabled = getEnvBool("TRAKT_SYNC", false);
    if (config.trakt.enabled !== newTraktEnabled) {
        changes.push(`TRAKT_SYNC: ${config.trakt.enabled} -> ${newTraktEnabled}`);
        config.trakt.enabled = newTraktEnabled;
    }

    const newTraktClientId = getEnv("TRAKT_CLIENT_ID", "");
    if (config.trakt.clientId !== newTraktClientId) {
        changes.push("TRAKT_CLIENT_ID changed");
        config.trakt.clientId = newTraktClientId;
    }

    const newTraktSecret = getEnv("TRAKT_CLIENT_SECRET", "");
    if (config.trakt.clientSecret !== newTraktSecret) {
        changes.push("TRAKT_CLIENT_SECRET changed");
        config.trakt.clientSecret = newTraktSecret;
    }

    const newTraktThreshold = Math.max(1, Math.min(100, parseInt(getEnv("TRAKT_SYNC_THRESHOLD", "81"), 10) || 81));
    if (config.trakt.syncThreshold !== newTraktThreshold) {
        changes.push(`TRAKT_SYNC_THRESHOLD: ${config.trakt.syncThreshold} -> ${newTraktThreshold}`);
        config.trakt.syncThreshold = newTraktThreshold;
    }

    const newUseTor = getEnvBool("TRAKT_USE_TOR", false);
    if (config.trakt.useTor !== newUseTor) {
        changes.push(`TRAKT_USE_TOR: ${config.trakt.useTor} -> ${newUseTor}`);
        config.trakt.useTor = newUseTor;
    }

    const newTorProxy = getEnv("TRAKT_TOR_PROXY", "socks5://127.0.0.1:9050");
    if (config.trakt.torProxy !== newTorProxy) {
        changes.push("TRAKT_TOR_PROXY changed");
        config.trakt.torProxy = newTorProxy;
    }

    // Stremio
    const newStremioEnabled = getEnvBool("STREMIO_SYNC", false);
    if (config.stremio.enabled !== newStremioEnabled) {
        changes.push(`STREMIO_SYNC: ${config.stremio.enabled} -> ${newStremioEnabled}`);
        config.stremio.enabled = newStremioEnabled;
    }

    const newStremioThreshold = Math.max(1, Math.min(100, parseInt(getEnv("STREMIO_SYNC_THRESHOLD", "85"), 10) || 85));
    if (config.stremio.syncThreshold !== newStremioThreshold) {
        changes.push(`STREMIO_SYNC_THRESHOLD: ${config.stremio.syncThreshold} -> ${newStremioThreshold}`);
        config.stremio.syncThreshold = newStremioThreshold;
    }

    const newStremioInterval = Math.max(30000, parseInt(getEnv("STREMIO_PROGRESS_INTERVAL_MS", "90000"), 10) || 90000);
    if (config.stremio.progressIntervalMs !== newStremioInterval) {
        changes.push(`STREMIO_PROGRESS_INTERVAL_MS: ${config.stremio.progressIntervalMs} -> ${newStremioInterval}`);
        config.stremio.progressIntervalMs = newStremioInterval;
    }

    // Auto-fetch
    const newAutoFetch = getEnvBool("AUTO_FETCH", true);
    if (config.autoFetch.enabled !== newAutoFetch) {
        changes.push(`AUTO_FETCH: ${config.autoFetch.enabled} -> ${newAutoFetch}`);
        config.autoFetch.enabled = newAutoFetch;
    }

    // Sync dry-run
    const newDryRun = getEnvBool("SYNC_DRY_RUN", false);
    if (config.syncDryRun !== newDryRun) {
        changes.push(`SYNC_DRY_RUN: ${config.syncDryRun} -> ${newDryRun}`);
        config.syncDryRun = newDryRun;
    }

    return changes;
}
