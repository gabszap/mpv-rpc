const express = require("express");
const cors = require("cors");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");

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

const CONFIG_DIR = path.resolve(__dirname, "..", ".config");
const CONFIG_PATH = path.join(CONFIG_DIR, ".stremio-mpv-config.json");
const STREMIO_TOKEN_PATH = path.join(CONFIG_DIR, ".stremio_tokens.json");

// Bridge config schema version. Bumped whenever the on-disk shape changes.
// Migration logic lives below in `migrateV1ToV2` (mirrored from
// src/bridge-config-migration.ts to keep the bridge free of TypeScript at runtime).
const CURRENT_CONFIG_VERSION = 2;

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
            return migrated;
        }
        return parsed;
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
        if (typeof body[key] !== expectedType) {
            return res.status(400).json({ error: `${key} must be a ${expectedType}` });
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

    if (body.stremioMeta !== undefined && body.stremioMeta !== null) {
        const err = validateStremioMeta(body.stremioMeta);
        if (err) {
            return res.status(400).json({ error: err });
        }
    }

    if (body.stremioAuth !== undefined) {
        if (typeof body.stremioAuth !== "string" || body.stremioAuth.trim().length === 0) {
            return res.status(400).json({ error: "stremioAuth must be a non-empty string" });
        }
    }

    const existing = withoutSensitiveConfigFields(readConfig());
    const configBody = withoutSensitiveConfigFields(body);
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

        const m3uContent = [
            "#EXTM3U",
            ...items.map((item) => {
                const safeTitle = (item.title || "Stream").replace(/[\r\n]+/g, " - ");
                return `#EXTINF:-1,${safeTitle}\n${item.url}`;
            }),
        ].join("\n");
        const tmpPath = path.join(os.tmpdir(), `stremio-playlist-${crypto.randomBytes(8).toString("hex")}.m3u`);

        try {
            fs.writeFileSync(tmpPath, m3uContent);
        } catch (writeError) {
            console.error("[MPV Bridge] Failed to write playlist file:", writeError.message);
            return res.status(500).json({ error: "Failed to write playlist file" });
        }

        mpvArgs.push(tmpPath);

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

/**
 * Fetch streams from a Stremio addon provider for a given episode.
 * Handles Kitsu IDs (kitsu:{id}:{episode}) and standard IMDb IDs.
 */
async function fetchStreams(baseUrl, id, season, episode) {
    const isKitsu = typeof id === "string" && id.startsWith("kitsu:");
    const url = isKitsu
        ? `${baseUrl}/stream/series/${id}:${episode}.json`
        : `${baseUrl}/stream/series/${id}:${season}:${episode}.json`;

    const data = await httpGetWithRetry(url, { maxRetries: 2, delayMs: 1000, timeoutMs: 10000 });
    return data?.streams ? data.streams : [];
}

/**
 * Parse a single Stremio stream object into { url, title }.
 * Handles direct URLs, infoHash (magnet), and externalUrl.
 */
function parseSingleStream(stream) {
    let url = stream.url || stream.externalUrl;
    if (!url && stream.infoHash) {
        url = `magnet:?xt=urn:btih:${stream.infoHash}`;
        if (stream.sources) {
            stream.sources.forEach((s) => {
                url += `&tr=${encodeURIComponent(s)}`;
            });
        }
    }

    let title =
        stream.behaviorHints?.filename ||
        (stream.title ? stream.title.split("\n")[0].split("\\n")[0] : null) ||
        stream.name ||
        "Video";
    if (title.length > 200) {
        title = `${title.substring(0, 200)}...`;
    }

    return { url, title };
}

/**
 * Find the best stream from a list based on release group and quality preferences.
 * Returns { url, title } or null.
 */
function findBestStream(streams, config) {
    if (!streams || streams.length === 0) {
        return null;
    }

    const validStreams = streams.filter((s) => (s.url || s.externalUrl || "").startsWith("http") || s.infoHash);
    if (validStreams.length === 0) {
        return null;
    }

    const preferredGroups = (config.preferredGroup || "")
        .split(",")
        .map((g) => g.trim().toLowerCase())
        .filter((g) => g.length > 0);
    const selectedQualities = (config.preferredQuality || "")
        .split(",")
        .map((q) => q.trim().toLowerCase())
        .filter((q) => q.length > 0);

    if (preferredGroups.length > 0 || selectedQualities.length > 0) {
        let bestStream = validStreams[0];
        let bestScore = -1;

        for (const s of validStreams) {
            const t = (s.title || s.description || s.name || s.id || "").toLowerCase();
            const normalizedTitle = t.replace(/[[\]]/g, "");
            let score = 0;

            if (preferredGroups.length > 0) {
                if (preferredGroups.some((g) => normalizedTitle.includes(g.replace(/[[\]]/g, "")))) {
                    score += 2;
                }
            }

            if (selectedQualities.length > 0) {
                if (selectedQualities.some((q) => t.includes(q))) {
                    score += 1;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestStream = s;
            }
        }

        if (bestStream) {
            return parseSingleStream(bestStream);
        }
    }

    return parseSingleStream(validStreams[0]);
}

/**
 * Fetch series metadata (episode list) from a provider.
 * Returns array of { season, episode, title } or empty array.
 */
async function fetchSeriesMeta(baseUrl, imdbId) {
    const url = `${baseUrl}/meta/series/${imdbId}.json`;
    const data = await httpGetWithRetry(url, { maxRetries: 1, delayMs: 1000, timeoutMs: 15000 });

    if (!data?.meta?.videos) {
        return [];
    }

    const episodes = data.meta.videos
        .map((v) => {
            const match = v.id.match(/:(\d+):(\d+)$/);
            if (match) {
                return {
                    season: parseInt(match[1], 10),
                    episode: parseInt(match[2], 10),
                    title: v.title || null,
                };
            }
            return null;
        })
        .filter((ep) => ep !== null);

    return episodes;
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
 * Send a loadfile command to MPV via IPC to append a URL to the playlist.
 * Returns true if successfully sent, false on failure.
 */
async function appendToMpvPlaylist(url) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ path: MPV_IPC_PATH });
        let buffer = "";
        let resolved = false;

        socket.on("connect", () => {
            const cmd = JSON.stringify({
                command: ["loadfile", url, "append"],
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
                    if (!resolved) {
                        resolved = true;
                        socket.destroy();
                        if (msg.error !== "success") {
                            console.error(`[MPV Bridge] MPV rejected loadfile: ${msg.error}`);
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
async function collectNextEpisodes(config, imdbId, season, episode, extraEpisodes) {
    const providers = config.providers || [];
    const enabledProviders = providers.filter((p) => p.enabled && p.url);

    if (enabledProviders.length === 0) {
        console.log("[MPV Bridge] No enabled providers for auto-fetch");
        return [];
    }

    // Get current MPV playlist to skip already-present episodes
    const currentPlaylist = await getMpvPlaylist();
    const existingTitles = new Set();
    if (currentPlaylist && Array.isArray(currentPlaylist)) {
        for (const item of currentPlaylist) {
            if (item.filename) {
                existingTitles.add(item.filename);
            }
        }
    }

    // Try to discover episodes from provider metadata
    let discoveredEpisodes = [];
    for (const p of enabledProviders) {
        const episodes = await fetchSeriesMeta(p.url, imdbId);
        if (episodes.length > 0) {
            discoveredEpisodes = episodes;
            console.log(`[MPV Bridge] Discovered ${episodes.length} episodes from ${p.name || p.id} meta`);
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
    // Target dedupe: track SxxExx keys we've already added in THIS request so
    // that two concurrent auto-fetch calls (or a single call whose response
    // includes the same target twice) cannot both append the same episode.
    // This complements `existingTitles` which only dedupes by URL against
    // the MPV playlist already on disk.
    const seenEpisodeKeys = new Set();
    for (const ep of nextEpisodes) {
        const epKey = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
        // Skip targets we've already handled in this run.
        if (seenEpisodeKeys.has(epKey)) {
            console.log(`[MPV Bridge] Auto-fetch: Skipped duplicate target: ${epKey}`);
            continue;
        }
        let found = false;
        for (const p of enabledProviders) {
            console.log(`[MPV Bridge] Auto-fetch: Trying ${p.name || p.id} for ${epKey}...`);
            const streams = await fetchStreams(p.url, imdbId, ep.season, ep.episode);
            const streamItem = findBestStream(streams, config);
            if (streamItem) {
                // Check if already in MPV playlist
                if (existingTitles.has(streamItem.url)) {
                    console.log(`[MPV Bridge] Auto-fetch: ${epKey} already in playlist, skipping`);
                    found = true; // Mark as handled so we don't try other providers
                    seenEpisodeKeys.add(epKey);
                    break;
                }

                console.log(`[MPV Bridge] Auto-fetch: Found ${epKey} on ${p.name || p.id}`);
                items.push({
                    url: streamItem.url,
                    title: streamItem.title || epKey,
                    season: ep.season,
                    episode: ep.episode,
                });
                seenEpisodeKeys.add(epKey);
                found = true;
                break;
            }
        }

        if (!found) {
            console.log(`[MPV Bridge] Auto-fetch: ${epKey} not found on any provider`);
        }
    }

    return items;
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

    const config = readConfig();
    const { imdbId, name, season, episode } = body;

    console.log(`[MPV Bridge] Auto-fetch: ${name} S${season}E${episode} (+${extraEpisodes} episodes)`);

    // Collect next episodes
    const nextItems = await collectNextEpisodes(config, imdbId, season, episode, extraEpisodes);

    if (nextItems.length === 0) {
        console.log("[MPV Bridge] Auto-fetch: No additional episodes found");
        return res.json({ success: true, added: 0 });
    }

    // Append each episode to MPV via IPC
    let added = 0;
    for (const item of nextItems) {
        const success = await appendToMpvPlaylist(item.url);
        if (success) {
            console.log(`[MPV Bridge] Auto-fetch: Appended S${item.season}E${item.episode}`);
            added++;
        } else {
            console.log(`[MPV Bridge] Auto-fetch: Failed to append S${item.season}E${item.episode}`);
        }
        // Small delay between IPC calls to avoid overwhelming MPV
        if (added > 0 && added < nextItems.length) {
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    console.log(`[MPV Bridge] Auto-fetch: Successfully appended ${added}/${nextItems.length} episode(s)`);

    if (added > 0) {
        await showMpvMessage(`Auto-fetch: ${added} episode(s) added`, 5000);
    }

    res.json({ success: true, added });
});

const server = app.listen(PORT, "127.0.0.1", () => {
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
        console.log("[MPV Bridge] No stremioMeta in config yet — will sync when you open content via the extension.");
    }
});

function shutdown() {
    console.log("\n[MPV Bridge] Shutting down...");
    server.close(() => {
        console.log("[MPV Bridge] Server stopped.");
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
