const express = require("express");
const cors = require("cors");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
const { extractReleaseGroup, findBestStream: findBestStreamShared } = require("./shared/stream-selection");

// Load .env from project root (shared with mpv-rpc)
try {
    const envFile = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", ".env"), "utf-8");
    for (const line of envFile.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx > 0) {
                const key = trimmed.slice(0, eqIdx).trim();
                let val = trimmed.slice(eqIdx + 1).trim();
                // Strip surrounding quotes (single or double)
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (!process.env[key]) {
                    process.env[key] = val;
                }
            }
        }
    }
} catch (_) {
    // .env file is optional — no warning needed
}

const app = express();
const PORT = process.env.PORT || 9632;
const MPV_PATH = process.env.MPV_PATH || "mpv";

// MPV IPC pipe path — OS-specific default, overridable via env
function getDefaultMpvPipePath() {
    if (process.platform === "win32") {
        return "\\\\.\\pipe\\mpv";
    }
    return "/tmp/mpv-socket";
}

const MPV_IPC_PATH = process.env.MPV_IPC_PATH || getDefaultMpvPipePath();

app.use(express.json());
app.use(
    cors({
        origin: ["https://web.stremio.com", "http://localhost:8080"],
        methods: ["GET", "POST"],
        credentials: true,
    }),
);

app.get("/health", (_req, res) => {
    res.json({ status: "ok", mpvPath: MPV_PATH });
});

const CONFIG_DIR = path.resolve(process.env.STREMIO_MPV_CONFIG_DIR || path.resolve(__dirname, "..", ".config"));
const CONFIG_PATH = path.join(CONFIG_DIR, ".stremio-mpv-config.json");
const STREMIO_TOKEN_PATH = path.join(CONFIG_DIR, ".stremio_tokens.json");

// Bridge config schema version. Bumped whenever the on-disk shape changes.
// Migration logic lives below in `migrateV1ToV2` (mirrored from
// src/bridge-config-migration.ts to keep the bridge free of TypeScript at runtime).
const CURRENT_CONFIG_VERSION = 2;

const AUTO_FETCH_DEDUPE_TTL_MS = 10 * 60 * 1000;
// Negative cache for explicitly completed stream lookups with no playable result.
// Forty-five minutes is long enough to stop same-playback retry storms near the
// latest released episode, but short enough for newly released episodes to be
// retried later without a bridge restart.
const AUTO_FETCH_NOT_FOUND_TTL_MS = 45 * 60 * 1000;
// Release checks are cached separately from stream not-found results so future
// episode metadata can be rechecked soon without hammering addon meta endpoints.
const RELEASE_CHECK_TTL_MS = 10 * 60 * 1000;
const AUTO_FETCH_DEDUPE_MAX_ENTRIES = 500;
// Per-appended-item playback contexts expire sooner than the primary Stremio metadata.
const AUTO_FETCH_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
const AUTO_FETCH_CONTEXT_MAX_ENTRIES = 100;
const autoFetchEpisodeDedupe = new Map();
const releaseCheckCache = new Map();

function normalizeAutoFetchIdentity(imdbId, name) {
    if (typeof imdbId === "string" && imdbId.trim().length > 0) {
        return imdbId.trim().toLowerCase();
    }

    if (typeof name === "string" && name.trim().length > 0) {
        return name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
            .replace(/\s+/g, "-");
    }

    return "unknown";
}

function buildAutoFetchEpisodeKey(imdbId, name, season, episode) {
    const identity = normalizeAutoFetchIdentity(imdbId, name);
    return `${identity}:S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function pruneAutoFetchDedupe(now = Date.now()) {
    for (const [key, entry] of autoFetchEpisodeDedupe) {
        if (entry.expiresAt <= now) {
            autoFetchEpisodeDedupe.delete(key);
        }
    }

    while (autoFetchEpisodeDedupe.size > AUTO_FETCH_DEDUPE_MAX_ENTRIES) {
        const oldestKey = autoFetchEpisodeDedupe.keys().next().value;
        if (!oldestKey) {
            return;
        }
        autoFetchEpisodeDedupe.delete(oldestKey);
    }
}

function getAutoFetchEpisodeStatus(key, now = Date.now()) {
    const entry = autoFetchEpisodeDedupe.get(key);
    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= now) {
        autoFetchEpisodeDedupe.delete(key);
        return null;
    }

    return entry.state;
}

function reserveAutoFetchEpisodeKey(key, now = Date.now()) {
    if (getAutoFetchEpisodeStatus(key, now)) {
        return false;
    }

    autoFetchEpisodeDedupe.set(key, {
        state: "in-flight",
        expiresAt: now + AUTO_FETCH_DEDUPE_TTL_MS,
    });
    pruneAutoFetchDedupe(now);
    return true;
}

function completeAutoFetchEpisodeKey(key, now = Date.now()) {
    autoFetchEpisodeDedupe.set(key, {
        state: "completed",
        expiresAt: now + AUTO_FETCH_DEDUPE_TTL_MS,
    });
    pruneAutoFetchDedupe(now);
}

function markAutoFetchEpisodeNotFound(key, now = Date.now()) {
    autoFetchEpisodeDedupe.set(key, {
        state: "not-found",
        expiresAt: now + AUTO_FETCH_NOT_FOUND_TTL_MS,
    });
    pruneAutoFetchDedupe(now);
}

function releaseAutoFetchEpisodeKey(key) {
    if (getAutoFetchEpisodeStatus(key) !== "in-flight") {
        return;
    }

    autoFetchEpisodeDedupe.delete(key);
}

function resetAutoFetchDedupeForTests() {
    autoFetchEpisodeDedupe.clear();
    releaseCheckCache.clear();
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
}

function readPositiveIntegerValue(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return null;
    }

    return value;
}

function normalizeAutoFetchedPlaybackIdentifier(value) {
    const identifier = readNonEmptyString(value);
    return identifier ? identifier : null;
}

function hashAutoFetchedPlaybackIdentifier(value) {
    const identifier = normalizeAutoFetchedPlaybackIdentifier(value);
    if (!identifier) {
        return null;
    }

    return crypto.createHash("sha256").update(identifier).digest("hex");
}

function normalizeAutoFetchedTitleKey(value) {
    const title = readNonEmptyString(value);
    if (!title) {
        return null;
    }

    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function buildAutoFetchedPlaybackMatchKeys(url, title) {
    const keys = new Set();
    const urlHash = hashAutoFetchedPlaybackIdentifier(url);
    if (urlHash) {
        keys.add(`url:${urlHash}`);
    }

    const urlValue = readNonEmptyString(url);
    if (urlValue) {
        try {
            const decodedUrlHash = hashAutoFetchedPlaybackIdentifier(decodeURIComponent(urlValue));
            if (decodedUrlHash) {
                keys.add(`url:${decodedUrlHash}`);
            }
        } catch (_) {
            // Invalid percent-encoding only means there is no decoded alias.
        }
    }

    const titleKey = normalizeAutoFetchedTitleKey(title);
    const titleHash = titleKey ? hashAutoFetchedPlaybackIdentifier(titleKey) : null;
    if (titleHash) {
        keys.add(`title:${titleHash}`);
    }

    return [...keys];
}

function readAutoFetchedContextSavedAtMs(entry) {
    if (!isPlainObject(entry)) {
        return null;
    }

    const savedAt = readNonEmptyString(entry.savedAt);
    if (!savedAt) {
        return null;
    }

    const savedAtMs = Date.parse(savedAt);
    return Number.isNaN(savedAtMs) ? null : savedAtMs;
}

function pruneAutoFetchedPlaybackContexts(rawContexts, now = Date.now()) {
    if (!isPlainObject(rawContexts)) {
        return {};
    }

    const freshEntries = Object.entries(rawContexts)
        .filter(([key, entry]) => {
            const savedAtMs = readAutoFetchedContextSavedAtMs(entry);
            return typeof key === "string" && savedAtMs !== null && now - savedAtMs <= AUTO_FETCH_CONTEXT_TTL_MS;
        })
        .sort(([, left], [, right]) => {
            const leftSavedAtMs = readAutoFetchedContextSavedAtMs(left) ?? 0;
            const rightSavedAtMs = readAutoFetchedContextSavedAtMs(right) ?? 0;
            return rightSavedAtMs - leftSavedAtMs;
        })
        .slice(0, AUTO_FETCH_CONTEXT_MAX_ENTRIES);

    return Object.fromEntries(freshEntries);
}

function parseCanonicalSeriesVideoId(value) {
    const videoId = readNonEmptyString(value);
    if (!videoId) {
        return null;
    }

    const match = videoId.match(/^(tt\d+):(\d+):(\d+)$/);
    if (!match) {
        return null;
    }

    const season = Number.parseInt(match[2], 10);
    const episode = Number.parseInt(match[3], 10);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
        return null;
    }

    return { imdbId: match[1], season, episode };
}

function buildTargetAutoFetchedVideoId(sourceContext, item, target) {
    const itemVideoId = readNonEmptyString(item.videoId);
    const itemCanonicalVideoId = parseCanonicalSeriesVideoId(itemVideoId);
    if (itemCanonicalVideoId) {
        const matchesTarget =
            itemCanonicalVideoId.season === target.season && itemCanonicalVideoId.episode === target.episode;
        const matchesImdb = !target.imdbId || itemCanonicalVideoId.imdbId === target.imdbId;
        if (matchesTarget && matchesImdb) {
            return itemVideoId;
        }

        if (target.imdbId && itemCanonicalVideoId.imdbId === target.imdbId) {
            return `${target.imdbId}:${target.season}:${target.episode}`;
        }

        return null;
    }

    const sourceType = readNonEmptyString(sourceContext.type) ?? "series";
    if (sourceType !== "series") {
        return itemVideoId ?? null;
    }

    if (target.imdbId) {
        return `${target.imdbId}:${target.season}:${target.episode}`;
    }

    const sourceVideoId = parseCanonicalSeriesVideoId(sourceContext.videoId);
    if (!sourceVideoId) {
        return itemVideoId ?? null;
    }

    return `${sourceVideoId.imdbId}:${target.season}:${target.episode}`;
}

function buildAutoFetchedPlaybackContext(sourceContext, item) {
    if (!isPlainObject(sourceContext) || !isPlainObject(item)) {
        return null;
    }

    const libraryItemId =
        readNonEmptyString(sourceContext.libraryItemId) ??
        readNonEmptyString(sourceContext.seriesId) ??
        readNonEmptyString(sourceContext.imdbId);
    if (!libraryItemId) {
        return null;
    }

    const season = readPositiveIntegerValue(item.season);
    const episode = readPositiveIntegerValue(item.episode);
    if (!season || !episode) {
        return null;
    }

    const imdbId = readNonEmptyString(sourceContext.imdbId);
    const realImdbId = imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null;
    const videoId = buildTargetAutoFetchedVideoId(sourceContext, item, {
        imdbId: realImdbId,
        season,
        episode,
    });
    const context = {
        libraryItemId,
        seriesId: readNonEmptyString(sourceContext.seriesId) ?? libraryItemId,
        imdbId: realImdbId,
        videoId,
        name: readNonEmptyString(sourceContext.name),
        episodeTitle: readNonEmptyString(item.title),
        type: readNonEmptyString(sourceContext.type) ?? "series",
        season,
        episode,
        episodesInSeason: readPositiveIntegerValue(sourceContext.episodesInSeason),
    };

    const sanitizedContext = sanitizeStremioContext(context);
    return sanitizedContext.error ? null : sanitizedContext.value;
}

function upsertAutoFetchedPlaybackContexts(config, sourceContext, items, now = Date.now()) {
    const nextConfig = isPlainObject(config) ? { ...config } : {};
    const contexts = pruneAutoFetchedPlaybackContexts(nextConfig.autoFetchedPlaybackContexts, now);

    if (!Array.isArray(items) || items.length === 0) {
        nextConfig.autoFetchedPlaybackContexts = contexts;
        return nextConfig;
    }

    for (const item of items) {
        const context = buildAutoFetchedPlaybackContext(sourceContext, item);
        if (!context) {
            continue;
        }

        const titleKey = normalizeAutoFetchedTitleKey(item.title);
        for (const matchKey of buildAutoFetchedPlaybackMatchKeys(item.url, item.title)) {
            contexts[matchKey] = {
                ...context,
                matchKey,
                titleKey,
            };
        }
    }

    nextConfig.autoFetchedPlaybackContexts = pruneAutoFetchedPlaybackContexts(contexts, now);
    return nextConfig;
}

function saveAutoFetchedPlaybackContexts(sourceContext, items) {
    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    const existing = readConfig();
    const updated = upsertAutoFetchedPlaybackContexts(existing, sourceContext, items);
    writeConfig(updated);
}

function readEpisodeKeyFromPlaylistValue(value) {
    if (typeof value !== "string") {
        return null;
    }

    const match = value.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (!match) {
        return null;
    }

    const season = Number.parseInt(match[1], 10);
    const episode = Number.parseInt(match[2], 10);
    if (!Number.isInteger(season) || !Number.isInteger(episode)) {
        return null;
    }

    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

const PLAYABLE_HTTP_EXTENSIONS = new Set([
    ".avi",
    ".flv",
    ".m2ts",
    ".m3u8",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpd",
    ".mpeg",
    ".mpg",
    ".ts",
    ".webm",
]);

const NON_PLAYABLE_HTTP_EXTENSIONS = new Set([
    ".css",
    ".gif",
    ".htm",
    ".html",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".md",
    ".pdf",
    ".png",
    ".svg",
    ".txt",
    ".xml",
]);

const NON_PLAYABLE_HOSTS = new Set([
    "bitbucket.org",
    "docs.github.com",
    "gist.github.com",
    "github.com",
    "gitlab.com",
    "www.github.com",
]);

const PLACEHOLDER_STREAM_TEXT = [
    "coming soon",
    "documentation",
    "episode not found",
    "not available",
    "not released",
    "no stream",
    "no streams",
    "placeholder",
    "readme",
];

function getStreamDisplayText(stream) {
    return [stream?.behaviorHints?.filename, stream?.title, stream?.description, stream?.name, stream?.id]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .join(" ")
        .toLowerCase();
}

function hasPlaceholderStreamText(stream) {
    const displayText = getStreamDisplayText(stream);
    if (!displayText) {
        return false;
    }

    return PLACEHOLDER_STREAM_TEXT.some((placeholderText) => displayText.includes(placeholderText));
}

function isLikelyPlayableHttpUrl(rawUrl, { allowGenericHttp }) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_) {
        return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (NON_PLAYABLE_HOSTS.has(hostname)) {
        return false;
    }

    const extension = path.extname(parsed.pathname).toLowerCase();
    if (NON_PLAYABLE_HTTP_EXTENSIONS.has(extension)) {
        return false;
    }

    if (PLAYABLE_HTTP_EXTENSIONS.has(extension)) {
        return true;
    }

    return allowGenericHttp;
}

function isPlayableStremioStream(stream) {
    if (!stream || typeof stream !== "object") {
        return false;
    }

    if (hasPlaceholderStreamText(stream)) {
        return false;
    }

    if (typeof stream.infoHash === "string" && stream.infoHash.trim().length > 0) {
        return true;
    }

    if (typeof stream.url === "string" && stream.url.trim().length > 0) {
        const url = stream.url.trim();
        if (url.startsWith("magnet:") || url.startsWith("stremio:")) {
            return true;
        }
        return isLikelyPlayableHttpUrl(url, { allowGenericHttp: true });
    }

    if (typeof stream.externalUrl !== "string" || stream.externalUrl.trim().length === 0) {
        return false;
    }

    const externalUrl = stream.externalUrl.trim();
    if (externalUrl.startsWith("magnet:") || externalUrl.startsWith("stremio:")) {
        return true;
    }

    // Stremio `externalUrl` entries are commonly documentation or web pages.
    // Only accept them when the URL itself looks like direct media/manifest content.
    return isLikelyPlayableHttpUrl(externalUrl, { allowGenericHttp: false });
}

/**
 * Best-stream selection shared with the userscript, using the server's stricter
 * playability predicate (placeholder text, non-playable hosts and extensions).
 */
function findBestStream(streams, config, targetSeason = null, targetEpisode = null) {
    return findBestStreamShared(
        streams,
        { ...config, isPlayable: isPlayableStremioStream },
        targetSeason,
        targetEpisode,
    );
}

/**
 * Derive the v2 `iconMode` enum from the legacy v1 booleans.
 * Mirrors `inferIconMode` in src/bridge-config-migration.ts.
 */
function inferIconMode(legacy) {
    if (!legacy || typeof legacy !== "object") {
        return "default";
    }
    const showMpvIcon = legacy.showMpvIcon;
    const showConfigIcon = legacy.showConfigIcon;
    const compactMode = legacy.compactMode;

    if (showMpvIcon === false && showConfigIcon === true && compactMode === true) {
        return "compact";
    }
    if (showMpvIcon === false && showConfigIcon === true) {
        return "config-only";
    }
    if (compactMode === true) {
        return "compact";
    }
    if (showMpvIcon === false && showConfigIcon === false) {
        return "disabled";
    }
    return "default";
}

function withoutSensitiveConfigFields(config) {
    if (!config || typeof config !== "object") {
        return config;
    }

    const sanitized = { ...config };
    delete sanitized.stremioAuth;
    return sanitized;
}

function normalizeBridgeConfig(config) {
    const sourceConfig = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const sanitized = withoutSensitiveConfigFields(sourceConfig);
    return {
        configVersion: CURRENT_CONFIG_VERSION,
        providers: Array.isArray(sanitized.providers) ? sanitized.providers : [],
        autoFetch:
            sanitized.autoFetch && typeof sanitized.autoFetch === "object"
                ? { enabled: sanitized.autoFetch.enabled !== false }
                : { enabled: true },
        extraEpisodes: typeof sanitized.extraEpisodes === "number" ? sanitized.extraEpisodes : 2,
        iconMode: typeof sanitized.iconMode === "string" ? sanitized.iconMode : "default",
        playlistMode: typeof sanitized.playlistMode === "string" ? sanitized.playlistMode : "batch",
        mpvShortcut: typeof sanitized.mpvShortcut === "string" ? sanitized.mpvShortcut : "v",
        preferredGroup: typeof sanitized.preferredGroup === "string" ? sanitized.preferredGroup : "",
        preferredQuality: typeof sanitized.preferredQuality === "string" ? sanitized.preferredQuality : "",
        mpvArgsStr: typeof sanitized.mpvArgsStr === "string" ? sanitized.mpvArgsStr : "",
        debug: typeof sanitized.debug === "boolean" ? sanitized.debug : false,
        ...(sanitized.stremioMeta && typeof sanitized.stremioMeta === "object"
            ? { stremioMeta: sanitized.stremioMeta }
            : {}),
        ...(() => {
            const contexts = pruneAutoFetchedPlaybackContexts(sanitized.autoFetchedPlaybackContexts);
            return Object.keys(contexts).length > 0 ? { autoFetchedPlaybackContexts: contexts } : {};
        })(),
    };
}

/**
 * Migrate a v1 (or unversioned) bridge config to the v2 shape.
 * Mirrors `migrateV1ToV2` in src/bridge-config-migration.ts.
 * Any change here MUST also be applied to the TS source.
 */
function migrateV1ToV2(config) {
    const sourceConfig = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const source = withoutSensitiveConfigFields(sourceConfig);
    return {
        ...source,
        configVersion: CURRENT_CONFIG_VERSION,
        autoFetch: { enabled: source.autoFetchEnabled !== false },
        extraEpisodes: typeof source.extraEpisodes === "number" ? source.extraEpisodes : 2,
        iconMode: inferIconMode(source),
    };
}

function ensureConfigDir() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(CONFIG_DIR, 0o700);
    } catch (_) {
        // Best effort only; Windows may not support POSIX permissions.
    }
}

function readConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        if (parsed.configVersion !== CURRENT_CONFIG_VERSION) {
            const migrated = migrateV1ToV2(parsed);
            // Write back to disk so subsequent reads are fast.
            try {
                writeConfig(migrated);
            } catch (_) {
                // Best effort only — fall through and return the in-memory migration.
            }
            return normalizeBridgeConfig(migrated);
        }
        return normalizeBridgeConfig(parsed);
    } catch (_) {
        return {};
    }
}

function writeConfig(config) {
    // CRITICAL: writeConfig must remain atomic (tmp + rename) to preserve
    // the existing config on failure. A non-atomic write could corrupt
    // .stremio-mpv-config.json on power loss, crash, or disk full, leaving
    // the bridge without a valid config and breaking all subsequent /play,
    // /auto-fetch, and /config requests. If you need to modify the write
    // path, preserve the tmp-file + renameSync pattern and the random hex
    // suffix to avoid collisions with concurrent writers.
    ensureConfigDir();
    const tmpPath = `${CONFIG_PATH}.tmp.${crypto.randomBytes(8).toString("hex")}`;
    const configToWrite = normalizeBridgeConfig(config);
    fs.writeFileSync(tmpPath, JSON.stringify(configToWrite, null, 4), "utf-8");
    fs.renameSync(tmpPath, CONFIG_PATH);
}

function saveStremioAuth(authKey) {
    if (typeof authKey !== "string" || authKey.trim().length === 0) {
        return false;
    }

    ensureConfigDir();

    const tokenPayload = {
        authKey: authKey.trim(),
        savedAt: new Date().toISOString(),
    };
    const tmpPath = `${STREMIO_TOKEN_PATH}.tmp.${crypto.randomBytes(8).toString("hex")}`;

    fs.writeFileSync(tmpPath, JSON.stringify(tokenPayload, null, 4), { encoding: "utf-8", mode: 0o600 });
    try {
        fs.chmodSync(tmpPath, 0o600);
    } catch (_) {
        // Best effort only; Windows may not support POSIX permissions.
    }

    fs.renameSync(tmpPath, STREMIO_TOKEN_PATH);
    try {
        fs.chmodSync(STREMIO_TOKEN_PATH, 0o600);
    } catch (_) {
        // Best effort only; Windows may not support POSIX permissions.
    }

    return true;
}

function getExistingStremioAuth() {
    try {
        const raw = fs.readFileSync(STREMIO_TOKEN_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        return typeof parsed.authKey === "string" ? parsed.authKey : null;
    } catch (_) {
        return null;
    }
}

function validateProvider(p) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
        return "each provider must be an object";
    }
    if (typeof p.id !== "string") return "provider.id must be a string";
    if (typeof p.name !== "string") return "provider.name must be a string";
    if (typeof p.url !== "string") return "provider.url must be a string";
    if (typeof p.enabled !== "boolean") return "provider.enabled must be a boolean";
    return null;
}

function readAutoFetchRequestProviders(body) {
    if (!Array.isArray(body.providers)) {
        return null;
    }

    const validProviders = body.providers.filter((provider) => validateProvider(provider) === null);
    const hasEnabledProvider = validProviders.some((provider) => provider.enabled && readNonEmptyString(provider.url));
    return hasEnabledProvider ? validProviders : null;
}

function mergeAutoFetchRequestConfig(savedConfig, body) {
    const normalizedConfig = normalizeBridgeConfig(savedConfig);
    const requestProviders = readAutoFetchRequestProviders(body);

    if (!requestProviders) {
        return normalizedConfig;
    }

    return {
        ...normalizedConfig,
        providers: requestProviders,
    };
}

function isConfigFieldType(value, expectedType) {
    if (expectedType === "array") {
        return Array.isArray(value);
    }
    if (expectedType === "object") {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    return typeof value === expectedType;
}

function validateStremioMeta(meta) {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
        return "stremioMeta must be an object";
    }
    const allowed = {
        seriesId: "string",
        imdbId: "string",
        libraryItemId: "string",
        videoId: "string",
        name: "string",
        episodeTitle: "string",
        season: "number",
        episode: "number",
        episodesInSeason: "number",
        type: "string",
        savedAt: "string",
    };
    for (const [key, expectedType] of Object.entries(allowed)) {
        if (key in meta && meta[key] !== null && meta[key] !== undefined && typeof meta[key] !== expectedType) {
            return `stremioMeta.${key} must be a ${expectedType}`;
        }
    }
    if (typeof meta.imdbId === "string" && !/^tt\d+$/.test(meta.imdbId)) {
        return "stremioMeta.imdbId must be a real IMDb id";
    }
    return null;
}

function sanitizeStremioContext(context) {
    const err = validateStremioMeta(context);
    if (err) {
        return { error: err, value: null };
    }

    const sanitized = {};
    const stringFields = ["seriesId", "imdbId", "libraryItemId", "videoId", "name", "episodeTitle", "type"];
    const numberFields = ["season", "episode", "episodesInSeason"];

    for (const field of stringFields) {
        if (typeof context[field] === "string") {
            const trimmedValue = context[field].trim();
            if (trimmedValue.length > 0) {
                sanitized[field] = trimmedValue;
            }
        }
    }

    for (const field of numberFields) {
        if (typeof context[field] === "number" && Number.isInteger(context[field]) && context[field] > 0) {
            sanitized[field] = context[field];
        }
    }

    if (context.imdbId === null) {
        sanitized.imdbId = null;
    }
    if (context.videoId === null) {
        sanitized.videoId = null;
    }
    if (context.episodesInSeason === null) {
        sanitized.episodesInSeason = null;
    }

    sanitized.savedAt = new Date().toISOString();

    return { error: null, value: sanitized };
}

app.post("/config", (req, res) => {
    const body = req.body;

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return res.status(400).json({ error: "Request body must be a valid JSON object" });
    }

    // Strict top-level key + type allowlist. Any unknown key is rejected so
    // the bridge never accepts arbitrary fields. `stremioMeta` may be null
    // (means clear); it is validated by validateStremioMeta below.
    const allowedTopLevel = {
        providers: "array",
        stremioMeta: "object",
        stremioAuth: "string",
        extraEpisodes: "number",
        autoFetch: "object",
        iconMode: "string",
        playlistMode: "string",
        mpvShortcut: "string",
        preferredGroup: "string",
        preferredQuality: "string",
        mpvArgsStr: "string",
        debug: "boolean",
        configVersion: "number",
    };
    for (const key of Object.keys(body)) {
        const expectedType = allowedTopLevel[key];
        if (expectedType === undefined) {
            return res.status(400).json({ error: `Unknown config field: ${key}` });
        }
        // stremioMeta allows `null` to mean "clear"; skip the type check for it
        // and let validateStremioMeta reject anything that is neither null nor
        // a plain object.
        if (key === "stremioMeta") continue;
        if (!isConfigFieldType(body[key], expectedType)) {
            const article = /^[aeiou]/i.test(expectedType) ? "an" : "a";
            return res.status(400).json({ error: `${key} must be ${article} ${expectedType}` });
        }
    }

    if (body.providers) {
        for (let i = 0; i < body.providers.length; i++) {
            const err = validateProvider(body.providers[i]);
            if (err) {
                return res.status(400).json({ error: `Invalid provider at index ${i}: ${err}` });
            }
        }
    }

    if (body.autoFetch !== undefined) {
        if (body.autoFetch === null) {
            return res.status(400).json({ error: "autoFetch must be an object" });
        }
        if (typeof body.autoFetch.enabled !== "boolean") {
            return res.status(400).json({ error: "autoFetch.enabled must be a boolean" });
        }
    }

    if (body.iconMode !== undefined) {
        const allowedIconModes = ["default", "config-only", "compact", "disabled"];
        if (!allowedIconModes.includes(body.iconMode)) {
            return res.status(400).json({ error: `iconMode must be one of: ${allowedIconModes.join(", ")}` });
        }
    }

    if (body.extraEpisodes !== undefined) {
        if (!Number.isInteger(body.extraEpisodes) || body.extraEpisodes < 1 || body.extraEpisodes > 25) {
            return res.status(400).json({ error: "extraEpisodes must be a positive integer between 1 and 25" });
        }
    }

    let sanitizedStremioMeta;
    if (body.stremioMeta !== undefined && body.stremioMeta !== null) {
        sanitizedStremioMeta = sanitizeStremioContext(body.stremioMeta);
        if (sanitizedStremioMeta.error) {
            return res.status(400).json({ error: sanitizedStremioMeta.error });
        }
    }

    if (body.stremioAuth !== undefined) {
        if (typeof body.stremioAuth !== "string" || body.stremioAuth.trim().length === 0) {
            return res.status(400).json({ error: "stremioAuth must be a non-empty string" });
        }
    }

    const existing = withoutSensitiveConfigFields(readConfig());
    const configBody = withoutSensitiveConfigFields(body);
    if (sanitizedStremioMeta) {
        configBody.stremioMeta = sanitizedStremioMeta.value;
    }
    const merged = normalizeBridgeConfig({ ...existing, ...configBody });

    // writeConfig uses a tmp file + rename (atomic on the same filesystem).
    // If the rename fails (disk full, permission denied, etc.) the original
    // config file is untouched. We surface a sanitized 500 — no path or token
    // detail in the response.
    try {
        writeConfig(merged);
    } catch (writeErr) {
        console.error("[MPV Bridge] Failed to write config:", writeErr.message);
        return res.status(500).json({ error: "Failed to save config" });
    }

    // Persist Stremio auth token if provided (consolidates /play auth handling).
    // The /play handler also persists it, so calling saveStremioAuth here is idempotent.
    if (typeof body.stremioAuth === "string" && body.stremioAuth.trim().length > 0) {
        const trimmedAuth = body.stremioAuth.trim();
        const existingAuth = getExistingStremioAuth();
        if (existingAuth !== trimmedAuth) {
            if (saveStremioAuth(trimmedAuth)) {
                console.log("[MPV Bridge] Synced Stremio auth token from /config");
            }
        }
    }

    if (process.env.DEBUG) {
        console.log(`[MPV Bridge] /config updated (v${merged.configVersion ?? 1})`);
    }

    res.json({ success: true, message: "Config updated" });
});

/** M3U titles are attached to queue entries before playback starts. */
function buildMpvPlaylist(items) {
    return [
        "#EXTM3U",
        ...items.map((item) => {
            const safeTitle = (item.title || "Stream").replace(/[\r\n]+/g, " - ");
            return `#EXTINF:-1,${safeTitle}\n${item.url}`;
        }),
    ].join("\n");
}

app.post("/play", (req, res) => {
    const { playlist, urls, contentTitle, args, stremioAuth, stremioContext } = req.body;
    const items = playlist || (urls ? urls.map((u) => ({ url: u, title: contentTitle })) : []);

    if (
        !items ||
        !Array.isArray(items) ||
        items.length === 0 ||
        !items.every((item) => item?.url && typeof item.url === "string" && item.url.trim().length > 0)
    ) {
        return res.status(400).json({ error: "Playlist or URLs array with valid urls is required" });
    }

    console.log(`[MPV Bridge] Opening ${items.length} item(s) in MPV...`);
    items.forEach((item, i) => {
        let displayTitle = item.title;

        if (displayTitle?.includes("%")) {
            try {
                displayTitle = decodeURIComponent(displayTitle);
            } catch (_e) {}
        }

        if (!displayTitle) {
            try {
                const decoded = decodeURIComponent(item.url);
                displayTitle = decoded.split("/").pop().split("?")[0];
            } catch (_e) {
                displayTitle = item.url.substring(0, 50);
            }
        }
        item.title = displayTitle; // Save it back so the M3U gets the clean title
        console.log(`  [${i + 1}] ${displayTitle}`);
    });

    try {
        const mpvArgs = ["--force-window=immediate", "--keep-open=yes"];

        if (args && typeof args === "string") {
            const parsedArgs = args.match(/(?:[^\s"]+|"[^"]*")+/g);
            if (parsedArgs) {
                mpvArgs.push(...parsedArgs.map((a) => a.replace(/^"|"$/g, "")));
            }
        } else if (args && Array.isArray(args)) {
            mpvArgs.push(...args);
        }

        const m3uContent = buildMpvPlaylist(items);
        const tmpPath = path.join(os.tmpdir(), `stremio-playlist-${crypto.randomBytes(8).toString("hex")}.m3u`);

        try {
            fs.writeFileSync(tmpPath, m3uContent);
        } catch (writeError) {
            console.error("[MPV Bridge] Failed to write playlist file:", writeError.message);
            return res.status(500).json({ error: "Failed to write playlist file" });
        }

        // The bridge supplies the complete playlist. Do not let MPV scan the temp directory
        // (a TypeScript .ts file there can be mistaken for a transport-stream video).
        // Keep this after custom arguments so directory autoload cannot override it.
        mpvArgs.push("--autocreate-playlist=no", "--osd-playlist-entry=title", tmpPath);

        const mpvProcess = spawn(MPV_PATH, mpvArgs, {
            detached: true,
            stdio: "ignore",
        });

        mpvProcess.once("error", (err) => {
            console.error(`[MPV Bridge] Failed to start MPV: ${err.message}`);
            // Clean up temporary playlist file on spawn failure
            try {
                fs.unlinkSync(tmpPath);
            } catch (_) {}
            // Note: response already sent if error fires after response
        });

        mpvProcess.unref();

        console.log(`[MPV Bridge] MPV started with PID: ${mpvProcess.pid}`);
        console.log(`[MPV Bridge] Playlist: ${tmpPath}`);

        if (stremioAuth !== undefined && typeof stremioAuth === "string" && stremioAuth.trim().length > 0) {
            try {
                const existingAuth = getExistingStremioAuth();
                if (existingAuth !== stremioAuth.trim()) {
                    if (saveStremioAuth(stremioAuth)) {
                        console.log("[MPV Bridge] Saved Stremio auth token to .config/.stremio_tokens.json");
                    }
                }
                // If token is the same, don't log anything — it's already saved
            } catch (tokenErr) {
                console.error("[MPV Bridge] Failed to save Stremio auth token:", tokenErr.message);
            }
        }

        // Replace stremioContext atomically so stale identity fields cannot survive between play requests.
        if (stremioContext && typeof stremioContext === "object" && !Array.isArray(stremioContext)) {
            try {
                const sanitizedContext = sanitizeStremioContext(stremioContext);
                if (sanitizedContext.error) {
                    console.error("[MPV Bridge] Ignoring invalid stremioContext:", sanitizedContext.error);
                } else {
                    const existing = readConfig();
                    existing.stremioMeta = sanitizedContext.value;
                    writeConfig(existing);
                }
            } catch (cfgErr) {
                console.error("[MPV Bridge] Failed to merge stremioContext into config:", cfgErr.message);
            }
        }

        res.json({
            success: true,
            message: `Opening ${items.length} item(s) in MPV`,
            pid: mpvProcess.pid,
        });
    } catch (error) {
        console.error("[MPV Bridge] Error opening MPV:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== AUTO-FETCH HELPERS ====================

/**
 * HTTP GET with retry logic (Node.js native fetch).
 * Retries up to maxRetries times with delayMs between attempts.
 */
async function httpGetWithRetry(url, { maxRetries = 2, delayMs = 1000, timeoutMs = 10000 } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            console.log(`[MPV Bridge] Retrying GET ${url} (attempt ${attempt + 1}/${maxRetries + 1})...`);
            await new Promise((r) => setTimeout(r, delayMs));
        }

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: "application/json" },
            });

            clearTimeout(timer);

            if (response.status !== 200) {
                console.log(`[MPV Bridge] GET ${url} returned status ${response.status}`);
                continue;
            }

            const data = await response.json();
            return data;
        } catch (err) {
            console.log(`[MPV Bridge] GET ${url} failed: ${err.message}`);
            if (attempt === maxRetries) {
                return null;
            }
        }
    }
    return null;
}

async function httpGetStreamPayload(url, { maxRetries = 2, delayMs = 1000, timeoutMs = 25000 } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            console.log(`[MPV Bridge] Retrying GET ${url} (attempt ${attempt + 1}/${maxRetries + 1})...`);
            await new Promise((r) => setTimeout(r, delayMs));
        }

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: "application/json" },
            });

            clearTimeout(timer);

            if (response.status === 200) {
                return { completed: true, data: await response.json() };
            }

            if (response.status === 404) {
                console.log(`[MPV Bridge] GET ${url} returned status 404`);
                return { completed: true, data: null };
            }

            console.log(`[MPV Bridge] GET ${url} returned status ${response.status}`);
        } catch (err) {
            console.log(`[MPV Bridge] GET ${url} failed: ${err.message}`);
            if (attempt === maxRetries) {
                return { completed: false, data: null };
            }
        }
    }

    return { completed: false, data: null };
}

/**
 * Fetch streams from a Stremio addon provider for a given episode.
 * Handles Kitsu IDs (kitsu:{id}:{episode}) and standard IMDb IDs.
 */
async function fetchStreams(baseUrl, id, season, episode) {
    const isKitsu = typeof id === "string" && id.startsWith("kitsu:");
    const url = isKitsu
        ? `${baseUrl}/stream/series/${id}:${episode}.json`
        : `${baseUrl}/stream/series/${id}:${season}:${episode}.json`;

    const result = await httpGetStreamPayload(url, { maxRetries: 2, delayMs: 1000, timeoutMs: 25000 });
    if (!result.completed) {
        return null;
    }

    const data = result.data;
    return data?.streams ? data.streams : [];
}

/**
 * Read a release status directly stated by addon metadata.
 * Unknown means the addon did not provide enough information; auto-fetch must
 * keep the existing stream-lookup fallback in that case.
 */
function readExplicitReleaseStatus(video) {
    if (!isPlainObject(video)) {
        return "unknown";
    }

    for (const field of ["released", "isReleased", "available", "isAvailable"]) {
        if (typeof video[field] === "boolean") {
            return video[field] ? "released" : "unreleased";
        }
    }

    for (const field of ["upcoming", "future", "isUpcoming"]) {
        if (video[field] === true) {
            return "unreleased";
        }
    }

    return "unknown";
}

function readReleaseTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 10_000_000_000 ? value : value * 1000;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
        return null;
    }

    const parsedMs = Date.parse(value);
    return Number.isNaN(parsedMs) ? null : parsedMs;
}

function readReleaseDateStatus(video, now = Date.now()) {
    if (!isPlainObject(video)) {
        return "unknown";
    }

    for (const field of [
        "released",
        "releaseDate",
        "airDate",
        "aired",
        "firstAired",
        "premiered",
        "publishedAt",
        "availableAt",
    ]) {
        const releaseTimestamp = readReleaseTimestamp(video[field]);
        if (releaseTimestamp === null) {
            continue;
        }

        return releaseTimestamp <= now ? "released" : "unreleased";
    }

    return "unknown";
}

function readVideoReleaseStatus(video, now = Date.now()) {
    const explicitStatus = readExplicitReleaseStatus(video);
    if (explicitStatus === "unreleased") {
        return explicitStatus;
    }

    const dateStatus = readReleaseDateStatus(video, now);
    if (dateStatus !== "unknown") {
        return dateStatus;
    }

    return explicitStatus;
}

function readSeriesMetaEpisode(video, now = Date.now()) {
    if (!isPlainObject(video) || typeof video.id !== "string") {
        return null;
    }

    const match = video.id.match(/:(\d+):(\d+)$/);
    if (!match) {
        return null;
    }

    return {
        season: Number.parseInt(match[1], 10),
        episode: Number.parseInt(match[2], 10),
        title: readNonEmptyString(video.title),
        releaseStatus: readVideoReleaseStatus(video, now),
    };
}

function buildSeriesMetaCacheKey(provider, seriesMetaId) {
    return `${readNonEmptyString(provider.url) ?? "unknown"}|${readNonEmptyString(provider.id) ?? "unknown"}|${seriesMetaId}`;
}

function buildReleaseMetaCandidateIds(imdbId, sourceContext = {}) {
    const context = isPlainObject(sourceContext) ? sourceContext : {};
    const candidateIds = [];
    const seenIds = new Set();
    const addCandidateId = (value) => {
        const candidateId = readNonEmptyString(value);
        if (!candidateId || seenIds.has(candidateId)) {
            return;
        }

        seenIds.add(candidateId);
        candidateIds.push(candidateId);
    };

    addCandidateId(context.seriesId);
    addCandidateId(context.libraryItemId);
    addCandidateId(context.imdbId);
    addCandidateId(imdbId);

    return candidateIds;
}

function pruneReleaseCheckCache(now = Date.now()) {
    for (const [key, entry] of releaseCheckCache) {
        if (entry.expiresAt <= now) {
            releaseCheckCache.delete(key);
        }
    }

    while (releaseCheckCache.size > AUTO_FETCH_DEDUPE_MAX_ENTRIES) {
        const oldestKey = releaseCheckCache.keys().next().value;
        if (!oldestKey) {
            return;
        }
        releaseCheckCache.delete(oldestKey);
    }
}

/**
 * Fetch series metadata (episode list) from a provider.
 * Returns array of { season, episode, title, releaseStatus } or empty array.
 */
async function fetchSeriesMeta(provider, seriesMetaId, now = Date.now()) {
    const baseUrl = readNonEmptyString(provider.url);
    if (!baseUrl) {
        return [];
    }

    const cacheKey = buildSeriesMetaCacheKey(provider, seriesMetaId);
    const cachedMeta = releaseCheckCache.get(cacheKey);
    if (cachedMeta && cachedMeta.expiresAt > now) {
        return cachedMeta.episodes;
    }

    const url = `${baseUrl}/meta/series/${seriesMetaId}.json`;
    const data = await httpGetWithRetry(url, { maxRetries: 1, delayMs: 1000, timeoutMs: 15000 });

    if (!Array.isArray(data?.meta?.videos)) {
        releaseCheckCache.set(cacheKey, { episodes: [], expiresAt: now + RELEASE_CHECK_TTL_MS });
        pruneReleaseCheckCache(now);
        return [];
    }

    const episodes = data.meta.videos.map((video) => readSeriesMetaEpisode(video, now)).filter((ep) => ep !== null);

    releaseCheckCache.set(cacheKey, { episodes, expiresAt: now + RELEASE_CHECK_TTL_MS });
    pruneReleaseCheckCache(now);
    return episodes;
}

async function fetchSeriesMetaForCandidates(provider, candidateIds, now = Date.now()) {
    for (const candidateId of candidateIds) {
        const episodes = await fetchSeriesMeta(provider, candidateId, now);
        if (episodes.length > 0) {
            return { episodes, candidateId };
        }
    }

    return { episodes: [], candidateId: null };
}

async function findConfirmedEpisodeReleaseStatus(provider, candidateIds, target, now = Date.now()) {
    for (const candidateId of candidateIds) {
        const episodes = await fetchSeriesMeta(provider, candidateId, now);
        const matchingEpisode = episodes.find(
            (episode) => episode.season === target.season && episode.episode === target.episode,
        );
        if (!matchingEpisode || matchingEpisode.releaseStatus === "unknown") {
            continue;
        }

        return { status: matchingEpisode.releaseStatus, candidateId };
    }

    return { status: "unknown", candidateId: null };
}

function isAioStreamsProvider(provider) {
    const haystack =
        `${readNonEmptyString(provider.name) ?? ""} ${readNonEmptyString(provider.id) ?? ""}`.toLowerCase();
    return haystack.includes("aiostreams") || haystack.includes("aio streams");
}

function getReleaseCheckProviderOrder(enabledProviders) {
    const orderedProviders = [];
    const seenProviders = new Set();
    const addProvider = (provider) => {
        const key = readNonEmptyString(provider.url) ?? readNonEmptyString(provider.id) ?? provider.name;
        if (!key || seenProviders.has(key)) {
            return;
        }

        seenProviders.add(key);
        orderedProviders.push(provider);
    };

    if (enabledProviders[0]) {
        addProvider(enabledProviders[0]);
    }

    for (const provider of enabledProviders.filter(isAioStreamsProvider)) {
        addProvider(provider);
    }

    for (const provider of enabledProviders) {
        addProvider(provider);
    }

    return orderedProviders;
}

async function checkEpisodeReleaseStatus(enabledProviders, imdbId, target, now = Date.now(), sourceContext = {}) {
    const candidateIds = buildReleaseMetaCandidateIds(imdbId, sourceContext);
    for (const provider of getReleaseCheckProviderOrder(enabledProviders)) {
        const releaseCheck = await findConfirmedEpisodeReleaseStatus(provider, candidateIds, target, now);
        if (releaseCheck.status === "unknown") {
            continue;
        }

        return {
            status: releaseCheck.status,
            source: `${provider.name || provider.id || provider.url} meta ${releaseCheck.candidateId}`,
        };
    }

    return { status: "unknown", source: null };
}

/**
 * Get the current MPV playlist via IPC.
 * Returns array of filenames currently in the playlist, or null on failure.
 */
async function getMpvPlaylist() {
    return new Promise((resolve) => {
        const socket = net.createConnection({ path: MPV_IPC_PATH });
        let buffer = "";
        let resolved = false;

        socket.on("data", (chunk) => {
            buffer += chunk.toString();

            // MPV IPC responses are JSON lines
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.trim().length === 0) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.error === "success" && msg.data !== undefined) {
                        if (!resolved) {
                            resolved = true;
                            socket.end();
                            resolve(msg.data);
                        }
                    }
                } catch (_) {
                    // Not JSON, skip
                }
            }
        });

        socket.on("connect", () => {
            // Send get_property command for playlist
            const cmd = JSON.stringify({
                command: ["get_property", "playlist"],
            });
            socket.write(`${cmd}\n`);
        });

        socket.on("error", () => {
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        });

        socket.on("end", () => {
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        });

        // Timeout after 5 seconds
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                socket.end();
                resolve(null);
            }
        }, 5000);
    });
}

/**
 * Append a titled M3U entry via loadlist so the queued item has a display name immediately.
 * Returns true if successfully sent, false on failure.
 */
async function appendToMpvPlaylist(url, title) {
    const tmpPath = path.join(os.tmpdir(), `stremio-auto-fetch-${crypto.randomBytes(8).toString("hex")}.m3u`);
    try {
        fs.writeFileSync(tmpPath, buildMpvPlaylist([{ url, title }]));
        return await new Promise((resolve) => {
            const socket = net.createConnection({ path: MPV_IPC_PATH });
            let buffer = "";
            let resolved = false;

            socket.on("connect", () => {
                const cmd = JSON.stringify({
                    command: ["loadlist", tmpPath, "append"],
                    request_id: 1,
                });
                socket.write(`${cmd}\n`);
            });

            socket.on("data", (chunk) => {
                buffer += chunk.toString();

                // MPV IPC responses are JSON lines
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (line.trim().length === 0) continue;
                    try {
                        const msg = JSON.parse(line);
                        if (msg.request_id === 1 && !resolved) {
                            resolved = true;
                            socket.destroy();
                            if (msg.error !== "success") {
                                console.error(`[MPV Bridge] MPV rejected playlist append: ${msg.error}`);
                            }
                            resolve(msg.error === "success");
                        }
                    } catch (_) {
                        // Not JSON, skip
                    }
                }
            });

            socket.on("error", (err) => {
                if (!resolved) {
                    resolved = true;
                    console.error(`[MPV Bridge] IPC socket error appending to playlist: ${err.message}`);
                    resolve(false);
                }
            });

            socket.on("end", () => {
                if (!resolved) {
                    resolved = true;
                    console.error("[MPV Bridge] IPC socket closed unexpectedly while appending to playlist");
                    resolve(false);
                }
            });

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    console.error("[MPV Bridge] IPC timeout while appending to playlist (5s)");
                    socket.destroy();
                    resolve(false);
                }
            }, 5000);
        });
    } catch (error) {
        console.error(`[MPV Bridge] Failed to append titled playlist: ${error.message}`);
        return false;
    } finally {
        try {
            fs.unlinkSync(tmpPath);
        } catch (_) {
            // Playlist parsing finishes before loadlist responds; the temporary file is no longer needed.
        }
    }
}

/**
 * Show an on-screen message in MPV via IPC.
 * Returns true if successfully sent, false on failure.
 */
async function showMpvMessage(text, duration = 3000) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ path: MPV_IPC_PATH });
        let resolved = false;

        socket.on("connect", () => {
            const cmd = JSON.stringify({
                command: ["show-text", text, String(duration)],
            });
            socket.write(`${cmd}\n`);
        });

        socket.on("data", () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(true);
            }
        });

        socket.on("error", () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(false);
            }
        });

        socket.on("end", () => {
            if (!resolved) {
                resolved = true;
                resolve(false);
            }
        });

        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(false);
            }
        }, 2000);
    });
}

/**
 * Collect next episodes after the current one.
 * Fetches metadata from providers to discover episode list,
 * then tries to find streams for each next episode.
 */
async function collectNextEpisodes(
    config,
    imdbId,
    name,
    season,
    episode,
    extraEpisodes,
    currentPlaylistOverride = undefined,
    releaseMetaContext = {},
) {
    const providers = config.providers || [];
    const enabledProviders = providers.filter((p) => p.enabled && p.url);

    if (enabledProviders.length === 0) {
        console.log("[MPV Bridge] No enabled providers for auto-fetch");
        return {
            items: [],
            skippedInFlight: 0,
            skippedCompleted: 0,
            skippedNotFound: 0,
            skippedPlaylist: 0,
            skippedUnreleased: 0,
            newlyNotFound: 0,
        };
    }

    const releaseMetaCandidateIds = buildReleaseMetaCandidateIds(imdbId, releaseMetaContext);

    // Get current MPV playlist to skip already-present episodes
    const currentPlaylist = currentPlaylistOverride ?? (await getMpvPlaylist());
    const existingTitles = new Set();
    const existingEpisodeKeys = new Set();
    let inferredGroup = null;
    if (currentPlaylist && Array.isArray(currentPlaylist)) {
        for (const item of currentPlaylist) {
            if (item.filename) {
                existingTitles.add(item.filename);
                const episodeKey = readEpisodeKeyFromPlaylistValue(item.filename);
                if (episodeKey) {
                    existingEpisodeKeys.add(episodeKey);
                }
                if (!inferredGroup) {
                    inferredGroup = extractReleaseGroup(item.filename);
                }
            }

            if (item.title) {
                const episodeKey = readEpisodeKeyFromPlaylistValue(item.title);
                if (episodeKey) {
                    existingEpisodeKeys.add(episodeKey);
                }
                if (!inferredGroup) {
                    inferredGroup = extractReleaseGroup(item.title);
                }
            }
        }
    }

    // Try to discover episodes from provider metadata
    let discoveredEpisodes = [];
    for (const p of enabledProviders) {
        const { episodes, candidateId } = await fetchSeriesMetaForCandidates(p, releaseMetaCandidateIds);
        if (episodes.length > 0) {
            discoveredEpisodes = episodes;
            console.log(
                `[MPV Bridge] Discovered ${episodes.length} episodes from ${p.name || p.id} meta ${candidateId}`,
            );
            break;
        }
    }

    let nextEpisodes = [];
    if (discoveredEpisodes.length > 0) {
        // Filter to episodes after current one, sorted by season/episode
        nextEpisodes = discoveredEpisodes
            .filter((ep) => {
                if (ep.season == null || ep.episode == null) return false;
                if (ep.season > season) return true;
                if (ep.season === season && ep.episode > episode) return true;
                return false;
            })
            .sort((a, b) => {
                if (a.season !== b.season) return a.season - b.season;
                return a.episode - b.episode;
            })
            .slice(0, extraEpisodes);
    } else {
        // Fallback: sequential episode increment
        console.log("[MPV Bridge] No series meta available, falling back to sequential episode increment");
        for (let i = 1; i <= extraEpisodes; i++) {
            nextEpisodes.push({
                season: season,
                episode: episode + i,
                title: null,
            });
        }
    }

    // Fetch streams for each next episode
    const items = [];
    let skippedInFlight = 0;
    let skippedCompleted = 0;
    let skippedNotFound = 0;
    let skippedPlaylist = 0;
    let skippedUnreleased = 0;
    let newlyNotFound = 0;
    // Target dedupe: track SxxExx keys we've already added in THIS request so
    // that two concurrent auto-fetch calls (or a single call whose response
    // includes the same target twice) cannot both append the same episode.
    // This complements `existingTitles` which only dedupes by URL against
    // the MPV playlist already on disk.
    const seenEpisodeKeys = new Set();
    for (const ep of nextEpisodes) {
        const epKey = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
        const dedupeKey = buildAutoFetchEpisodeKey(imdbId, name, ep.season, ep.episode);
        // Skip targets we've already handled in this run.
        if (seenEpisodeKeys.has(epKey)) {
            console.log(`[MPV Bridge] Auto-fetch: Skipped duplicate target: ${epKey}`);
            continue;
        }

        if (existingEpisodeKeys.has(epKey)) {
            console.log(`[MPV Bridge] Auto-fetch: ${epKey} already in playlist, skipping`);
            completeAutoFetchEpisodeKey(dedupeKey);
            seenEpisodeKeys.add(epKey);
            skippedPlaylist++;
            continue;
        }

        const status = getAutoFetchEpisodeStatus(dedupeKey);
        if (status) {
            console.log(`[MPV Bridge] Auto-fetch: ${epKey} already ${status}, skipping`);
            seenEpisodeKeys.add(epKey);
            if (status === "in-flight") {
                skippedInFlight++;
            } else if (status === "completed") {
                skippedCompleted++;
            } else if (status === "not-found") {
                skippedNotFound++;
            }
            continue;
        }

        const releaseCheck = await checkEpisodeReleaseStatus(
            enabledProviders,
            imdbId,
            ep,
            Date.now(),
            releaseMetaContext,
        );
        if (releaseCheck.status === "unreleased") {
            const sourceDetail = releaseCheck.source ? ` (${releaseCheck.source})` : "";
            console.log(`[DETAIL] target not released, skipping auto-fetch: ${epKey}${sourceDetail}`);
            seenEpisodeKeys.add(epKey);
            skippedUnreleased++;
            continue;
        }

        if (!reserveAutoFetchEpisodeKey(dedupeKey)) {
            console.log(`[MPV Bridge] Auto-fetch: ${epKey} already in-flight, skipping`);
            seenEpisodeKeys.add(epKey);
            skippedInFlight++;
            continue;
        }

        let found = false;
        let completedProviderLookups = 0;
        let failedProviderLookups = 0;
        for (const p of enabledProviders) {
            console.log(`[MPV Bridge] Auto-fetch: Trying ${p.name || p.id} for ${epKey}...`);
            const streams = await fetchStreams(p.url, imdbId, ep.season, ep.episode);
            if (streams === null) {
                failedProviderLookups++;
                console.log(
                    `[MPV Bridge] Auto-fetch: ${epKey} lookup failed on ${p.name || p.id}; target remains retryable`,
                );
                continue;
            }

            completedProviderLookups++;
            const effectiveConfig = {
                ...config,
                ...(inferredGroup && !config.preferredGroup ? { inferredGroup } : {}),
                ...(name ? { seriesName: name } : {}),
            };
            const streamItem = findBestStream(streams, effectiveConfig, ep.season, ep.episode);
            if (streamItem) {
                if (!inferredGroup && streamItem.title) {
                    inferredGroup = extractReleaseGroup(streamItem.title);
                }
                // Check if already in MPV playlist
                if (existingTitles.has(streamItem.url)) {
                    console.log(`[MPV Bridge] Auto-fetch: ${epKey} already in playlist, skipping`);
                    completeAutoFetchEpisodeKey(dedupeKey);
                    found = true; // Mark as handled so we don't try other providers
                    seenEpisodeKeys.add(epKey);
                    skippedPlaylist++;
                    break;
                }

                console.log(`[MPV Bridge] Auto-fetch: Found ${epKey} on ${p.name || p.id}`);
                items.push({
                    url: streamItem.url,
                    title: streamItem.title || epKey,
                    displayTitle:
                        `${readNonEmptyString(name) || ""} ${epKey}${ep.title ? ` - ${ep.title}` : ""}`.trim(),
                    season: ep.season,
                    episode: ep.episode,
                    dedupeKey,
                });
                seenEpisodeKeys.add(epKey);
                found = true;
                break;
            }
        }

        if (!found) {
            if (completedProviderLookups > 0 && failedProviderLookups === 0) {
                markAutoFetchEpisodeNotFound(dedupeKey);
                newlyNotFound++;
                console.log(`[MPV Bridge] Auto-fetch: ${epKey} not found on any provider; cached for retry later`);
            } else {
                releaseAutoFetchEpisodeKey(dedupeKey);
                console.log(`[MPV Bridge] Auto-fetch: ${epKey} lookup incomplete; target remains retryable`);
            }
        }
    }

    return {
        items,
        skippedInFlight,
        skippedCompleted,
        skippedNotFound,
        skippedPlaylist,
        skippedUnreleased,
        newlyNotFound,
    };
}

/**
 * POST /auto-fetch endpoint
 * Fetches the current episode + next episodes and appends them to the running MPV instance.
 */
app.post("/auto-fetch", async (req, res) => {
    const body = req.body;

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return res.status(400).json({ error: "Request body must be a valid JSON object" });
    }

    // Validate required fields
    const requiredFields = ["imdbId", "name", "season", "episode", "type"];
    for (const field of requiredFields) {
        if (!(field in body) || body[field] === undefined || body[field] === null) {
            return res.status(400).json({ error: `Missing required field: ${field}` });
        }
    }

    // Validate types
    if (typeof body.imdbId !== "string") {
        return res.status(400).json({ error: "imdbId must be a string" });
    }
    if (typeof body.name !== "string") {
        return res.status(400).json({ error: "name must be a string" });
    }
    if (typeof body.season !== "number" || !Number.isInteger(body.season) || body.season < 1) {
        return res.status(400).json({ error: "season must be a positive integer" });
    }
    if (typeof body.episode !== "number" || !Number.isInteger(body.episode) || body.episode < 1) {
        return res.status(400).json({ error: "episode must be a positive integer" });
    }
    if (typeof body.type !== "string") {
        return res.status(400).json({ error: "type must be a string" });
    }

    // Validate optional extraEpisodes (default 2 — unified with userscript + RPC)
    let extraEpisodes = 2;
    if (body.extraEpisodes !== undefined) {
        if (typeof body.extraEpisodes !== "number" || !Number.isInteger(body.extraEpisodes)) {
            return res.status(400).json({ error: "extraEpisodes must be an integer" });
        }
        extraEpisodes = Math.max(1, Math.min(25, body.extraEpisodes));
    }

    const savedConfig = readConfig();
    if (savedConfig.autoFetch?.enabled === false) {
        console.log("[MPV Bridge] Auto-fetch disabled by config");
        return res.json({ success: true, added: 0, message: "Auto-fetch disabled by config" });
    }

    const config = mergeAutoFetchRequestConfig(savedConfig, body);
    const { imdbId, name, season, episode } = body;
    const sourceStremioContext = {
        ...(isPlainObject(savedConfig.stremioMeta) ? savedConfig.stremioMeta : {}),
        libraryItemId:
            readNonEmptyString(body.libraryItemId) ?? readNonEmptyString(savedConfig.stremioMeta?.libraryItemId),
        seriesId: readNonEmptyString(body.seriesId) ?? readNonEmptyString(savedConfig.stremioMeta?.seriesId),
        imdbId,
        name,
        type: body.type,
        episodesInSeason:
            readPositiveIntegerValue(body.episodesInSeason) ??
            readPositiveIntegerValue(savedConfig.stremioMeta?.episodesInSeason),
    };

    console.log(`[MPV Bridge] Auto-fetch: ${name} S${season}E${episode} (+${extraEpisodes} episodes)`);

    // Collect next episodes
    const autoFetchResult = await collectNextEpisodes(
        config,
        imdbId,
        name,
        season,
        episode,
        extraEpisodes,
        undefined,
        sourceStremioContext,
    );
    const nextItems = autoFetchResult.items;

    if (nextItems.length === 0) {
        if (autoFetchResult.skippedInFlight > 0) {
            console.log("[MPV Bridge] Auto-fetch: Target episodes are already being fetched");
            return res.json({
                success: true,
                status: "in_progress",
                added: 0,
                skippedInFlight: autoFetchResult.skippedInFlight,
                skippedCompleted: autoFetchResult.skippedCompleted,
                skippedNotFound: autoFetchResult.skippedNotFound,
                skippedPlaylist: autoFetchResult.skippedPlaylist,
                skippedUnreleased: autoFetchResult.skippedUnreleased,
            });
        }

        if (autoFetchResult.skippedNotFound > 0 && autoFetchResult.newlyNotFound === 0) {
            console.log("[MPV Bridge] Auto-fetch: Target episodes were recently confirmed unavailable");
            return res.json({
                success: true,
                status: "no_new_episodes_recently",
                added: 0,
                message: "Target episodes were recently confirmed unavailable; retry after negative-cache expiry",
                skippedInFlight: 0,
                skippedCompleted: autoFetchResult.skippedCompleted,
                skippedNotFound: autoFetchResult.skippedNotFound,
                skippedPlaylist: autoFetchResult.skippedPlaylist,
                skippedUnreleased: autoFetchResult.skippedUnreleased,
                retryAfterMs: AUTO_FETCH_NOT_FOUND_TTL_MS,
            });
        }

        if (autoFetchResult.skippedUnreleased > 0 && autoFetchResult.newlyNotFound === 0) {
            console.log("[MPV Bridge] Auto-fetch: Target episodes are not released yet");
            return res.json({
                success: true,
                status: "no_released_episodes",
                added: 0,
                message: "Target episodes are not released yet; skipped auto-fetch until release-check cache expires",
                skippedInFlight: 0,
                skippedCompleted: autoFetchResult.skippedCompleted,
                skippedNotFound: autoFetchResult.skippedNotFound,
                skippedPlaylist: autoFetchResult.skippedPlaylist,
                skippedUnreleased: autoFetchResult.skippedUnreleased,
                retryAfterMs: RELEASE_CHECK_TTL_MS,
            });
        }

        if (autoFetchResult.newlyNotFound > 0) {
            console.log("[MPV Bridge] Auto-fetch: No released episodes found");
            return res.json({
                success: true,
                status: "no_released_episodes",
                added: 0,
                message: "No released episodes found on enabled providers; cached for retry later",
                skippedInFlight: 0,
                skippedCompleted: autoFetchResult.skippedCompleted,
                skippedNotFound: autoFetchResult.skippedNotFound,
                skippedPlaylist: autoFetchResult.skippedPlaylist,
                skippedUnreleased: autoFetchResult.skippedUnreleased,
                newlyNotFound: autoFetchResult.newlyNotFound,
                retryAfterMs: AUTO_FETCH_NOT_FOUND_TTL_MS,
            });
        }

        console.log("[MPV Bridge] Auto-fetch: No additional episodes found");
        return res.json({
            success: true,
            status: "completed",
            added: 0,
            skippedInFlight: 0,
            skippedCompleted: autoFetchResult.skippedCompleted,
            skippedNotFound: autoFetchResult.skippedNotFound,
            skippedPlaylist: autoFetchResult.skippedPlaylist,
            skippedUnreleased: autoFetchResult.skippedUnreleased,
        });
    }

    // Append each episode to MPV via IPC
    let added = 0;
    const appendedItems = [];
    for (const item of nextItems) {
        const success = await appendToMpvPlaylist(item.url, item.displayTitle);
        if (success) {
            console.log(`[MPV Bridge] Auto-fetch: Appended S${item.season}E${item.episode}`);
            completeAutoFetchEpisodeKey(item.dedupeKey);
            appendedItems.push(item);
            added++;
        } else {
            console.log(`[MPV Bridge] Auto-fetch: Failed to append S${item.season}E${item.episode}`);
            releaseAutoFetchEpisodeKey(item.dedupeKey);
        }
        // Small delay between IPC calls to avoid overwhelming MPV
        if (added > 0 && added < nextItems.length) {
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    console.log(`[MPV Bridge] Auto-fetch: Successfully appended ${added}/${nextItems.length} episode(s)`);

    if (added > 0) {
        try {
            saveAutoFetchedPlaybackContexts(sourceStremioContext, appendedItems);
        } catch (contextErr) {
            console.error("[MPV Bridge] Failed to save auto-fetched playback context:", contextErr.message);
        }
        await showMpvMessage(`Auto-fetch: ${added} episode(s) added`, 5000);
    }

    res.json({ success: true, status: "completed", added });
});

module.exports = {
    app,
    _autoFetchDedupeForTests: {
        AUTO_FETCH_NOT_FOUND_TTL_MS,
        RELEASE_CHECK_TTL_MS,
        buildAutoFetchEpisodeKey,
        buildReleaseMetaCandidateIds,
        checkEpisodeReleaseStatus,
        collectNextEpisodes,
        completeAutoFetchEpisodeKey,
        fetchSeriesMeta,
        getAutoFetchEpisodeStatus,
        isPlayableStremioStream,
        findBestStream,
        markAutoFetchEpisodeNotFound,
        readEpisodeKeyFromPlaylistValue,
        releaseAutoFetchEpisodeKey,
        reserveAutoFetchEpisodeKey,
        resetAutoFetchDedupeForTests,
        AUTO_FETCH_CONTEXT_MAX_ENTRIES,
        AUTO_FETCH_CONTEXT_TTL_MS,
        buildAutoFetchedPlaybackMatchKeys,
        pruneAutoFetchedPlaybackContexts,
        upsertAutoFetchedPlaybackContexts,
        mergeAutoFetchRequestConfig,
    },
};

let server = null;

function startServer() {
    return app.listen(PORT, "127.0.0.1", () => {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║               Stremio MPV Bridge - Local Server           ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(51)}║
║  Bind: 127.0.0.1 (localhost only)                        ║
║  MPV:  ${MPV_PATH.padEnd(51).substring(0, 51)}║
║  IPC:  ${MPV_IPC_PATH.padEnd(51).substring(0, 51)}║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /health      - Server status check                ║
║    POST /play        - Open URLs in MPV                   ║
║    POST /config      - Update bridge config               ║
║    POST /auto-fetch  - Auto-fetch next episodes           ║
╚═══════════════════════════════════════════════════════════╝
`);

        // Check if config exists on startup
        const startupConfig = readConfig();
        if (startupConfig.stremioMeta) {
            console.log("[MPV Bridge] Found existing stremioMeta in config — ready for sync.");
        } else {
            console.log(
                "[MPV Bridge] No stremioMeta in config yet — will sync when you open content via the extension.",
            );
        }
    });
}

if (process.env.NODE_ENV !== "test") {
    server = startServer();
}

function shutdown() {
    console.log("\n[MPV Bridge] Shutting down...");
    if (!server) {
        process.exit(0);
    }

    server.close(() => {
        console.log("[MPV Bridge] Server stopped.");
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
