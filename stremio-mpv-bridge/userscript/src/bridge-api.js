// HTTP communication with the local bridge server (config sync, /play, health).

import { CONFIG } from "./constants.js";
import { log } from "./logging.js";
import { settings } from "./settings.js";
import { isRealImdbId } from "./url-parser.js";

// Mirrors src/userscript-config-sync.ts — keep in sync.
// The userscript is the source of truth for user-facing configuration.
// The bridge is treated as a synchronized runtime cache. `pendingBridgeConfig`
// holds the most recent config that has not yet been acknowledged by the bridge
// and is flushed (re-posted to /config) before any /play call.
export const bridgeState = { pendingConfig: null };

export function postBridgeConfig(config) {
    return new Promise((resolve, reject) => {
        try {
            GM_xmlhttpRequest({
                method: "POST",
                url: "http://localhost:9632/config",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(config),
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) {
                        resolve();
                        return;
                    }

                    const responseBody = (r.responseText || "").trim();
                    const detail = responseBody ? `: ${responseBody}` : "";
                    reject(new Error(`Config sync failed (HTTP ${r.status})${detail}`));
                },
                onerror: () => reject(new Error("Config sync failed: connection failed")),
                ontimeout: () => reject(new Error("Config sync failed: request timed out")),
            });
        } catch (e) {
            reject(e);
        }
    });
}

async function flushPendingBridgeConfig() {
    const configToFlush = bridgeState.pendingConfig;
    if (!configToFlush) {
        return true;
    }
    try {
        await postBridgeConfig(configToFlush);
    } catch (_) {
        return false;
    }
    if (bridgeState.pendingConfig === configToFlush) {
        bridgeState.pendingConfig = null;
    }
    return true;
}

function getNonEmptyString(value) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
}

function getPositiveInteger(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
}

export function buildBridgeStremioMeta(content) {
    if (!content || typeof content !== "object") {
        return null;
    }

    const meta = {};
    const stringFields = ["seriesId", "libraryItemId", "videoId", "name", "episodeTitle", "type"];
    const numberFields = ["season", "episode", "episodesInSeason"];

    for (const field of stringFields) {
        const value = getNonEmptyString(content[field]);
        if (value) {
            meta[field] = value;
        }
    }

    const imdbId = getNonEmptyString(content.imdbId);
    if (imdbId && isRealImdbId(imdbId)) {
        meta.imdbId = imdbId;
    } else if (content.imdbId === null) {
        meta.imdbId = null;
    }

    for (const field of numberFields) {
        const value = getPositiveInteger(content[field]);
        if (value) {
            meta[field] = value;
        }
    }

    const hasIdentity = Boolean(meta.seriesId || meta.libraryItemId || meta.videoId || meta.imdbId || meta.name);
    return hasIdentity ? meta : null;
}

export async function checkServer() {
    return new Promise((r) =>
        GM_xmlhttpRequest({
            method: "GET",
            url: `${CONFIG.SERVER_URL}/health`,
            timeout: 5000,
            onload: (res) => r(res.status === 200),
            onerror: () => r(false),
            ontimeout: () => r(false),
        }),
    );
}

export function sendToMPV(playlist, title) {
    // Mirrors src/userscript-config-sync.ts — keep in sync.
    // Flush any pending config to the bridge before opening MPV
    // so the bridge runtime cache is never stale relative to /play.
    if (bridgeState.pendingConfig) {
        return flushPendingBridgeConfig().then((flushed) => {
            if (!flushed) {
                log("[Bridge] Pending config sync failed; aborting /play");
                return Promise.reject(new Error("Pending config sync failed"));
            }
            return sendToMPVInner(playlist, title);
        });
    }
    return sendToMPVInner(playlist, title);
}

function sendToMPVInner(playlist, title) {
    return new Promise((resolve, reject) => {
        const profile = JSON.parse(localStorage.getItem("profile") || "{}");
        const authKey = profile.auth?.key;
        const realImdbId = isRealImdbId(title.imdbId) ? title.imdbId : null;

        log(
            `Bridge: Sending payload with authKey: ${authKey ? "Found" : "MISSING"} | libraryItemId: ${title.libraryItemId || title.seriesId} | imdbId: ${realImdbId || "none"}`,
        );

        GM_xmlhttpRequest({
            method: "POST",
            url: `${CONFIG.SERVER_URL}/play`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                playlist,
                contentTitle: title.videoId || title.streamId || realImdbId || title.seriesId,
                args: settings.mpvArgsStr,
                stremioAuth: authKey,
                stremioContext: {
                    libraryItemId: title.libraryItemId || title.seriesId,
                    seriesId: title.seriesId,
                    imdbId: realImdbId,
                    videoId: title.videoId || null,
                    name: title.name,
                    episodeTitle: title.episodeTitle,
                    season: title.season,
                    episode: title.episode,
                    episodesInSeason: title.episodesInSeason || null,
                    type: title.type,
                },
            }),
            onload: (r) => (r.status === 200 ? resolve() : reject(new Error("Server error"))),
            onerror: () => reject(new Error("Connection failed")),
        });
    });
}
