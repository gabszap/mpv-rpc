/**
 * Auto-fetch module - detects when playback is near the end of a playlist
 * and triggers the Stremio bridge to fetch the next episodes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCanonicalSplitPartEpisode } from "./canonical-episode";
import { config } from "./config";
import type { MpvData } from "./mpv";
import { readStremioPlaybackContext } from "./stremio-sync/context";
import { normalizeTitle } from "./trakt-sync/api";

// Shared config file path (same as bridge uses)
const CONFIG_PATH = path.resolve(__dirname, "..", ".config", ".stremio-mpv-config.json");

// Deduplication state
let lastTriggerKey: string | null = null;
let lastFilename: string | null = null;
let lastTriggerTime = 0;

// Single-flight: tracks in-flight requests keyed by current episode identity.
// Prevents two concurrent `update()` ticks from both passing the gate and
// POSTing to the bridge for the same episode, which would otherwise cause
// the bridge to append duplicates to the MPV playlist.
const autoFetchInFlight = new Set<string>();

// Cooldown between trigger attempts (success or failure) to prevent spam
const TRIGGER_COOLDOWN_MS = 30_000;

/**
 * Build a stable key identifying the current episode the user is watching.
 * Used by the in-flight Set to prevent duplicate concurrent auto-fetch
 * requests when two MPV update ticks both reach the trigger gate.
 *
 * Prefers `imdb_id` (stable across filename changes within the same show),
 * falls back to `series_title`. Null season/episode collapse to `00`.
 */
export function buildCurrentEpisodeKey(data: MpvData): string {
    const idPart = data.imdb_id || data.series_title || "unknown";
    const s = data.season ?? 0;
    const e = data.episode ?? 0;
    return `${idPart}:S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
}

interface StremioMeta {
    imdbId?: string | null;
    seriesId?: string | null;
    name?: string | null;
    season?: number | null;
    episode?: number | null;
    type?: string | null;
    libraryItemId?: string | null;
    videoId?: string | null;
    episodesInSeason?: number | null;
}

interface SharedConfig {
    stremioMeta?: StremioMeta;
    autoFetch?: { enabled?: boolean };
    extraEpisodes?: number;
    providers?: unknown[];
    [key: string]: unknown;
}

type EpisodePosition = {
    season: number | null;
    episode: number | null;
};

type CompleteEpisodePosition = {
    season: number;
    episode: number;
};

type AutoFetchBridgeResponse = {
    success?: boolean;
    status?: "completed" | "in_progress" | "no_new_episodes_recently" | "no_released_episodes";
    added?: number;
    skippedInFlight?: number;
    skippedCompleted?: number;
    skippedNotFound?: number;
    skippedPlaylist?: number;
    newlyNotFound?: number;
    error?: string;
    message?: string;
};

function isAutoFetchEnabled(sharedConfig: SharedConfig): boolean {
    return sharedConfig.autoFetch?.enabled !== false;
}

/**
 * Token-based title matching with minimum overlap threshold.
 * Prevents substring false positives like "Naruto" matching "Boruto: Naruto Next Generations".
 */
function titlesMatch(configTitle: string, watchingTitle: string): boolean {
    const configTokens = configTitle.split(/\s+/).filter((t) => t.length > 0);
    const watchTokens = watchingTitle.split(/\s+/).filter((t) => t.length > 0);

    if (configTokens.length === 0 || watchTokens.length === 0) return false;

    // Check if at least 80% of the shorter title's tokens are in the longer title
    const shorter = configTokens.length <= watchTokens.length ? configTokens : watchTokens;
    const longer = configTokens.length <= watchTokens.length ? watchTokens : configTokens;

    const matches = shorter.filter((t) => longer.includes(t)).length;
    return matches / shorter.length >= 0.8;
}

/**
 * Parse season and episode numbers from an MPV filename.
 * Returns { season: null, episode: null } when no pattern matches.
 */
function parseFilenameEpisode(filename: string): { season: number | null; episode: number | null } {
    // Remove file extension
    const base = filename.replace(/\.[^.]+$/, "");

    // Try S04E25 pattern (case-insensitive)
    const seMatch = base.match(/[Ss](\d+)[Ee](\d+)/);
    if (seMatch) {
        return { season: parseInt(seMatch[1], 10), episode: parseInt(seMatch[2], 10) };
    }

    // Try 4x25 pattern (constrained to realistic season/episode values)
    const xMatch = base.match(/(?<!\d)(\d{1,2})x(\d{1,3})(?!\d)/);
    if (xMatch) {
        const s = parseInt(xMatch[1], 10);
        const e = parseInt(xMatch[2], 10);
        if (s >= 1 && s <= 99 && e >= 1 && e <= 999) {
            return { season: s, episode: e };
        }
    }

    // Try Episode 25 or Ep 25 or E25 pattern
    const epMatch = base.match(/(?:Episode|Ep|E)\s*(\d+)/i);
    if (epMatch) {
        return { season: null, episode: parseInt(epMatch[1], 10) };
    }

    return { season: null, episode: null };
}

function hasCompleteEpisodePosition(position: EpisodePosition): position is CompleteEpisodePosition {
    return position.season !== null && position.episode !== null;
}

function readPositiveInteger(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return null;
    }

    return value;
}

function readStremioEpisodePosition(stremioMeta: StremioMeta): CompleteEpisodePosition | null {
    const position = {
        season: readPositiveInteger(stremioMeta.season),
        episode: readPositiveInteger(stremioMeta.episode),
    };

    if (!hasCompleteEpisodePosition(position)) {
        return null;
    }

    return position;
}

function resolveAutoFetchEpisodePosition(
    parsed: EpisodePosition,
    data: MpvData,
    stremioMeta: StremioMeta,
): EpisodePosition {
    if (hasCompleteEpisodePosition(parsed)) {
        return parsed;
    }

    const canonicalPosition = resolveCanonicalSplitPartEpisode(data);
    if (canonicalPosition) {
        return {
            season: canonicalPosition.season,
            episode: canonicalPosition.episode,
        };
    }

    const stremioPosition = readStremioEpisodePosition(stremioMeta);
    if (stremioPosition) {
        return stremioPosition;
    }

    return parsed;
}

function readSharedConfig(): SharedConfig | null {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        return JSON.parse(raw) as SharedConfig;
    } catch {
        return null;
    }
}

export async function checkAndTriggerAutoFetch(data: MpvData): Promise<void> {
    // Guard: playlist data unavailable
    if (data.playlistCount <= 0) {
        return;
    }

    // Guard: not on last episode or not near end
    if (data.playlistPos !== data.playlistCount - 1 || data.percent_pos < 80) {
        return;
    }

    // Guard: feature disabled
    if (!config.autoFetch.enabled) {
        return;
    }

    // Reset deduplication when filename changes.
    // A new filename means a new show, so all in-flight requests for the
    // previous show should be forgotten (they're for a different identity now).
    if (lastFilename !== data.filename) {
        lastTriggerKey = null;
        autoFetchInFlight.clear();
        lastFilename = data.filename;
    }

    // Single-flight guard: if a request for this exact episode identity is
    // already in flight, the other concurrent tick will handle it. This
    // closes the race that the 30s cooldown cannot (cooldown only blocks
    // sequential calls, not two ticks that arrive within the same window).
    const currentKey = buildCurrentEpisodeKey(data);
    if (autoFetchInFlight.has(currentKey)) {
        console.debug?.(`[AutoFetch] Skipped duplicate in-flight request: ${currentKey}`);
        return;
    }

    // Guard: cooldown active (prevents spam when bridge is down)
    if (Date.now() - lastTriggerTime < TRIGGER_COOLDOWN_MS) {
        return;
    }

    // Mark attempt started to prevent spam from any subsequent failure
    lastTriggerTime = Date.now();

    // Deduplication: skip if already triggered for this episode position
    const triggerKey = `${data.filename}:${data.playlistPos}`;
    if (lastTriggerKey === triggerKey) {
        return;
    }

    // Reserve the in-flight slot. The try/finally below guarantees the
    // Set is cleaned up even if readSharedConfig / the fetch throws.
    autoFetchInFlight.add(currentKey);

    try {
        // Read shared config
        const sharedConfig = readSharedConfig();
        if (!sharedConfig) {
            console.warn("[AutoFetch] Shared config file not found or invalid JSON. Skipping auto-fetch.");
            return;
        }

        if (!isAutoFetchEnabled(sharedConfig)) {
            console.log("[AutoFetch] Disabled by bridge config. Skipping auto-fetch.");
            return;
        }

        const playbackContext = readStremioPlaybackContext(data);
        const stremioMeta = playbackContext ?? sharedConfig.stremioMeta;
        if (!stremioMeta?.imdbId || !stremioMeta.name) {
            console.warn("[AutoFetch] No Stremio metadata in shared config. Skipping auto-fetch.");
            return;
        }

        const parsed = parseFilenameEpisode(data.filename);
        const position = resolveAutoFetchEpisodePosition(parsed, data, stremioMeta);
        const { season, episode } = position;

        // Guard: couldn't determine episode number
        if (episode == null) {
            console.warn("[AutoFetch] Could not determine episode number from filename or config. Skipping.");
            return;
        }

        // Validate that Stremio metadata matches what's being watched
        const configName = stremioMeta.name;
        const watchingTitle = data.series_title;

        if (configName && watchingTitle && watchingTitle !== "N/A") {
            const normalizedConfig = normalizeTitle(configName);
            const normalizedWatching = normalizeTitle(watchingTitle);

            // Guard: empty normalized strings (e.g. non-Latin titles that failed normalization)
            if (!normalizedConfig || !normalizedWatching) {
                console.log(
                    `[AutoFetch] Title normalization failed for "${configName}" or "${watchingTitle}". Skipping auto-fetch.`,
                );
                return;
            }

            // Token-based matching to prevent substring false positives
            if (!titlesMatch(normalizedConfig, normalizedWatching)) {
                console.log(
                    `[AutoFetch] Stremio config name "${configName}" doesn't match "${watchingTitle}". Skipping auto-fetch.`,
                );
                return;
            }
        }

        // Validate IMDB ID if available from both sources
        if (data.imdb_id && stremioMeta.imdbId && data.imdb_id !== stremioMeta.imdbId) {
            console.log(
                `[AutoFetch] Stremio config IMDB ID "${stremioMeta.imdbId}" doesn't match "${data.imdb_id}". Skipping auto-fetch.`,
            );
            return;
        }

        // Check bridge health
        try {
            const healthRes = await fetch("http://localhost:9632/health", { signal: AbortSignal.timeout(3000) });
            if (!healthRes.ok) {
                console.error("[AutoFetch] Bridge health check failed. Skipping auto-fetch.");
                return;
            }
        } catch {
            console.error("[AutoFetch] Bridge unreachable. Skipping auto-fetch.");
            return;
        }

        // Trigger auto-fetch
        const extraEpisodes = sharedConfig.extraEpisodes ?? 2;
        const configuredProviders = Array.isArray(sharedConfig.providers) ? sharedConfig.providers : undefined;
        const requestBody = {
            imdbId: stremioMeta.imdbId,
            name: stremioMeta.name,
            season,
            episode,
            type: stremioMeta.type || "series",
            libraryItemId: stremioMeta.libraryItemId,
            seriesId: stremioMeta.seriesId,
            videoId: stremioMeta.videoId,
            episodesInSeason: stremioMeta.episodesInSeason,
            extraEpisodes,
            ...(configuredProviders ? { providers: configuredProviders } : {}),
        };

        if (config.syncDryRun) {
            const targets: string[] = [];
            const startEp = (episode ?? 0) + 1;
            const safeSeason = season ?? 0;
            for (let i = 0; i < extraEpisodes; i++) {
                targets.push(`S${String(safeSeason).padStart(2, "0")}E${String(startEp + i).padStart(2, "0")}`);
            }
            const target = targets.join(", ");
            console.log(`[AutoFetch][dry-run] Would POST /auto-fetch: ${extraEpisodes} episode(s) (${target})`);
            // Still mark dedupe so we don't keep retrying
            lastTriggerKey = triggerKey;
            return;
        }

        const res = await fetch("http://localhost:9632/auto-fetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(30000),
        });

        const result = (await res.json()) as AutoFetchBridgeResponse;
        if (result.success) {
            if (result.status === "in_progress") {
                const skippedCount = result.skippedInFlight ?? 0;
                console.log(`[AutoFetch] Auto-fetch already in progress for ${skippedCount} target episode(s).`);
                lastTriggerKey = triggerKey;
            } else if (result.status === "no_new_episodes_recently") {
                const skippedCount = result.skippedNotFound ?? 0;
                console.log(
                    `[AutoFetch] No new released episodes recently; bridge skipped ${skippedCount} cached missing target(s).`,
                );
            } else if (result.status === "no_released_episodes") {
                const missingCount = result.newlyNotFound ?? result.skippedNotFound ?? 0;
                console.log(
                    `[AutoFetch] No released episodes found on enabled providers; cached ${missingCount} missing target(s) for retry later.`,
                );
            } else if ((result.added ?? 0) > 0) {
                console.log(`[AutoFetch] Added ${result.added ?? 0} episode(s) to playlist.`);
                lastTriggerKey = triggerKey;
            } else {
                console.log(
                    result.message ? `[AutoFetch] ${result.message}` : "[AutoFetch] No new episodes were added.",
                );
                lastTriggerKey = triggerKey;
            }
        } else {
            console.error(`[AutoFetch] Bridge returned error: ${result.error}`);
        }
    } catch (e) {
        console.error("[AutoFetch] Failed to trigger auto-fetch:", e instanceof Error ? e.message : String(e));
    } finally {
        // Always release the in-flight slot, even if the fetch threw.
        autoFetchInFlight.delete(currentKey);
    }
}
