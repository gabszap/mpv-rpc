/**
 * Configuration for MPV Discord RPC
 */

import * as dotenv from "dotenv";
import * as path from "path";

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
  updateInterval: 1000,

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

  // Jikan API settings
  jikan: {
    baseUrl: "https://api.jikan.moe/v4",
    minRequestInterval: 500,
  },

  // GuessIt API settings
  guessitApi: {
    enabled: getEnvBool("USE_GUESSIT_API", true),
    url: getEnv("GUESSIT_API_URL", ""),
    timeout: 10000,
  },

  // TheTVDB API settings
  tvdb: {
    apiKey: getEnv("TVDB_API_KEY", ""),
    language: getEnv("TVDB_LANG", "eng"),
  },

  // MyAnimeList sync settings
  mal: {
    enabled: getEnvBool("MAL_SYNC", false),
    clientId: getEnv("MAL_CLIENT_ID", ""),
    syncThreshold: parseInt(getEnv("MAL_SYNC_THRESHOLD", "90"), 10), // % watched to trigger sync
  },
};

export type Config = typeof config;
