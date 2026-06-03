/**
 * Trakt.tv Sync Module
 * High-level scrobble logic with state machine, cooldown, dedup, and backlog
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../config";
import type { MpvData } from "../mpv";
import {
    getHistory,
    getShowSeasons,
    lookupById,
    normalizeTitle,
    scrobblePause,
    scrobbleStart,
    scrobbleStop,
    searchByTitle,
} from "./api";
import { isAuthenticated } from "./auth";
import type { TraktEpisode, TraktSeasonEpisode, TraktShow } from "./types";

// ---------------------------------------------------------------------------
// Stremio config reader
// ---------------------------------------------------------------------------

/**
 * Read imdbId from the Stremio bridge config file if it exists.
 */
function getStremioImdbId(): string | null {
    try {
        const configPath = path.join(process.cwd(), ".config", ".stremio-mpv-config.json");
        if (!fs.existsSync(configPath)) return null;
        const raw = fs.readFileSync(configPath, "utf-8");
        const cfg = JSON.parse(raw) as Record<string, unknown>;
        const meta = cfg.stremioMeta as Record<string, unknown> | undefined;
        return (meta?.imdbId as string) ?? null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

/** Cache for resolved Trakt shows, keyed by imdb:ID, tvdb:ID, or title:NORMALIZED */
const showCache = new Map<string, { show: TraktShow; imdbId?: string }>();

/** Cache for season/episode data, keyed by Trakt show ID */
const seasonCache = new Map<number, TraktSeasonEpisode[]>();

/** Cache for history checks, keyed by "showId:season:episode" */
const historyCache = new Map<string, boolean | null>();

// ---------------------------------------------------------------------------
// Cooldown / dedup state
// ---------------------------------------------------------------------------

const lastSuccess = new Map<string, { episode: number; season: number; timestamp: number }>();
const lastAttempted = new Map<string, { timestamp: number }>();
const syncInProgress = new Set<string>();
const COOLDOWN_MS = 60 * 1000; // 60 seconds per episode

type SyncGateDecision = "allow" | "in_progress" | "already_success" | "cooldown";

/**
 * Determine whether a scrobble call is allowed right now.
 */
function getSyncGateDecision(showId: number, episode: number, season: number, isStop: boolean): SyncGateDecision {
    const key = `${showId}:${season}:${episode}`;

    if (syncInProgress.has(key)) {
        return "in_progress";
    }

    if (isStop) {
        const success = lastSuccess.get(key);
        if (success && success.episode === episode && success.season === season) {
            return "already_success";
        }
    }

    const attempted = lastAttempted.get(key);
    if (attempted && Date.now() - attempted.timestamp < COOLDOWN_MS) {
        return "cooldown";
    }

    return "allow";
}

function recordSyncAttempt(showId: number, episode: number, season: number): void {
    const key = `${showId}:${season}:${episode}`;
    lastAttempted.set(key, { timestamp: Date.now() });
}

function recordSyncSuccess(showId: number, episode: number, season: number): void {
    const key = `${showId}:${season}:${episode}`;
    lastSuccess.set(key, { episode, season, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Backlog for failed scrobbles
// ---------------------------------------------------------------------------

interface BacklogEntry {
    action: "start" | "stop" | "pause";
    episode: TraktEpisode;
    show: TraktShow;
    progress: number;
    queuedAt: number;
}

const backlog: BacklogEntry[] = [];
let lastBacklogAttempt = 0;
const BACKLOG_COOLDOWN_MS = 30 * 1000; // 30 seconds

/**
 * Retry queued backlog entries. Stops at the first failure so we don't
 * hammer the API when it is down. Respects a 30-second cooldown between attempts.
 */
async function processBacklog(): Promise<void> {
    if (backlog.length === 0) return;
    if (Date.now() - lastBacklogAttempt < BACKLOG_COOLDOWN_MS) return;
    lastBacklogAttempt = Date.now();

    while (backlog.length > 0) {
        const entry = backlog[0];
        let success = false;

        switch (entry.action) {
            case "start":
                success = await scrobbleStart(entry.episode, entry.show, entry.progress);
                break;
            case "pause":
                success = await scrobblePause(entry.episode, entry.show, entry.progress);
                break;
            case "stop":
                success = await scrobbleStop(entry.episode, entry.show, entry.progress);
                break;
        }

        if (success) {
            backlog.shift();
        } else {
            break;
        }
    }
}

/**
 * Queue a failed scrobble for retry on the next successful API call.
 */
function queueBacklog(
    action: "start" | "stop" | "pause",
    episode: TraktEpisode,
    show: TraktShow,
    progress: number,
): void {
    backlog.push({ action, episode, show, progress, queuedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Scrobble state machine
// ---------------------------------------------------------------------------

type ScrobbleState = "idle" | "playing" | "paused" | "stopped";

let currentMetadataKey: string | null = null;
let currentState: ScrobbleState = "idle";
let currentShow: TraktShow | null = null;
let currentEpisode: TraktEpisode | null = null;
let lastKnownProgress = 0;

// ---------------------------------------------------------------------------
// Media resolution chain (4.3)
// ---------------------------------------------------------------------------

/**
 * Resolve an MpvData payload to a Trakt show.
 *
 * Priority:
 * 1. imdb_id from MpvData or Stremio config → lookupById("imdb", …)
 * 2. tvdb_id (if available on MpvData) → lookupById("tvdb", …)
 * 3. Search by series_title → pick highest-score match
 *
 * Results are cached in-memory for the session.
 */
export async function resolveTraktShow(data: MpvData): Promise<{ show: TraktShow; imdbId?: string } | null> {
    // Extract expected title early for validation against ID lookups
    // Treat "N/A" as empty so ID-based resolution isn't discarded
    const title = data.series_title;
    const expectedTitle = title && title !== "N/A" ? normalizeTitle(title) : "";

    // 1. Try imdb_id from MpvData or Stremio bridge config
    const imdbId = data.imdb_id || getStremioImdbId();
    if (imdbId) {
        const cacheKey = `imdb:${imdbId}`;
        const cached = showCache.get(cacheKey);
        if (cached) return cached;

        const result = await lookupById("imdb", imdbId);
        if (result?.show) {
            const resolvedTitle = normalizeTitle(result.show.title);
            const titlesMismatch =
                resolvedTitle &&
                expectedTitle &&
                (resolvedTitle.length >= 4 && expectedTitle.length >= 4
                    ? !resolvedTitle.includes(expectedTitle) && !expectedTitle.includes(resolvedTitle)
                    : resolvedTitle !== expectedTitle);
            if (titlesMismatch) {
                console.log(
                    `[Trakt] IMDB ID ${imdbId} resolved to "${result.show.title}" but expected "${title}" — falling back to title search`,
                );
            } else {
                const entry: { show: TraktShow; imdbId?: string } = { show: result.show, imdbId };
                showCache.set(cacheKey, entry);
                console.log(`[Trakt] Resolved show via imdb_id: ${result.show.title}`);
                return entry;
            }
        }
    }

    // 2. Try tvdb_id (available when TVDB provider populates it on MpvData)
    const tvdbId = (data as unknown as Record<string, number | undefined>).tvdb_id;
    if (tvdbId) {
        const cacheKey = `tvdb:${tvdbId}`;
        const cached = showCache.get(cacheKey);
        if (cached) return cached;

        const result = await lookupById("tvdb", String(tvdbId));
        if (result?.show) {
            const resolvedTitle = normalizeTitle(result.show.title);
            const titlesMismatch =
                resolvedTitle &&
                expectedTitle &&
                (resolvedTitle.length >= 4 && expectedTitle.length >= 4
                    ? !resolvedTitle.includes(expectedTitle) && !expectedTitle.includes(resolvedTitle)
                    : resolvedTitle !== expectedTitle);
            if (titlesMismatch) {
                console.log(
                    `[Trakt] TVDB ID ${tvdbId} resolved to "${result.show.title}" but expected "${title}" — falling back to title search`,
                );
            } else {
                const entry: { show: TraktShow; imdbId?: string } = { show: result.show };
                showCache.set(cacheKey, entry);
                console.log(`[Trakt] Resolved show via tvdb_id: ${result.show.title}`);
                return entry;
            }
        }
    }

    // 3. Fallback: search by title
    if (!title || title === "N/A") return null;

    const normalized = normalizeTitle(title);
    const cacheKey = `title:${normalized}`;
    const cached = showCache.get(cacheKey);
    if (cached) return cached;

    const results = await searchByTitle(title, "show");
    if (results.length === 0) return null;

    // Results are already sorted by score → year → title similarity in api.ts
    const best = results[0];
    const entry: { show: TraktShow; imdbId?: string } = {
        show: best.show,
        imdbId: best.show.ids.imdb,
    };
    showCache.set(cacheKey, entry);
    console.log(`[Trakt] Resolved show via search: ${best.show.title} (score: ${best.score})`);
    return entry;
}

// ---------------------------------------------------------------------------
// Episode ID resolution with season-null handling (4.4)
// ---------------------------------------------------------------------------

/** Pad a non-negative integer to two digits (used for SxxExx labels). */
function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

/** A parsed season/episode target. */
export type SeasonEpisode = { season: number; episode: number };

/** Minimal season metadata required to compute absolute episode positions. */
export type SeasonInfo = { season: number; episodeCount: number };

/**
 * Map a season/episode pair to its absolute episode position across a sequence
 * of consecutive seasons.
 *
 * Returns `null` when the mapping is not safe — for example when one or more
 * prior seasons are missing from the input. In that case the caller must skip
 * the scrobble instead of guessing the absolute position.
 *
 * @param current The parsed season/episode target.
 * @param seasons Season metadata in any order. Will be sorted by season ascending.
 * @returns The absolute episode number plus an informational SxxExx label, or null.
 */
export function mapSeasonEpisodeToAbsolute(
    current: SeasonEpisode,
    seasons: SeasonInfo[],
): { absoluteEpisode: number; seasonEpisode: string } | null {
    const sorted = [...seasons].sort((a, b) => a.season - b.season);
    const previousSeasons = sorted.filter((s) => s.season < current.season);
    if (previousSeasons.length !== current.season - 1) return null;

    const sum = previousSeasons.reduce((acc, s) => acc + s.episodeCount, 0);
    return {
        absoluteEpisode: sum + current.episode,
        seasonEpisode: `S${pad2(current.season)}E${pad2(current.episode)}`,
    };
}

/**
 * Resolve a season + episode pair to a Trakt episode object.
 *
 * When the exact season/episode match fails AND a season was provided,
 * attempts a safe absolute mapping across consecutive seasons. If prior
 * seasons are missing the mapping is refused (returns null) so the caller
 * skips the scrobble rather than marking the wrong episode.
 *
 * When season is null (common for anime), falls back to absolute
 * episode-number matching across all seasons — the position counter is
 * the same loop, just seeded with the raw episode number.
 *
 * Season data is cached in-memory per session.
 */
export async function resolveEpisode(
    show: TraktShow,
    season: number | null,
    episode: number,
): Promise<TraktEpisode | null> {
    if (episode == null) return null;

    const showId = show.ids.trakt;

    // Fetch and cache season data if not already cached
    if (!seasonCache.has(showId)) {
        const seasons = await getShowSeasons(showId);
        if (seasons.length === 0) {
            console.log(`[Trakt] No season data for show: ${show.title}`);
            return null;
        }
        seasonCache.set(showId, seasons);
    }

    const seasons = seasonCache.get(showId);
    if (!seasons) return null;

    // Default to season 1 when season is null (common for anime)
    const targetSeason = season ?? 1;

    // Try exact season + episode match
    const targetSeasonData = seasons.find((s) => s.number === targetSeason);
    if (targetSeasonData && targetSeasonData.episodes.length > 0) {
        const ep = targetSeasonData.episodes.find((e) => e.number === episode);
        if (ep) return ep;
    }

    // Determine the absolute position to look up. When a season was provided,
    // use the safe consecutive-season mapping; when not, treat `episode` as
    // the absolute position directly.
    let targetPosition: number;
    if (season != null) {
        const seasonInfos: SeasonInfo[] = seasons.map((s) => ({
            season: s.number,
            episodeCount: s.episodes.length,
        }));
        const mapping = mapSeasonEpisodeToAbsolute({ season, episode }, seasonInfos);
        if (!mapping) {
            console.log(
                `[Trakt] Skipped scrobble: could not safely map ${show.title} S${pad2(season)}E${pad2(episode)} to Trakt absolute episode.`,
            );
            return null;
        }
        console.log(
            `[Trakt] Absolute mapping: ${show.title} ${mapping.seasonEpisode} → absolute ${mapping.absoluteEpisode}`,
        );
        targetPosition = mapping.absoluteEpisode;
    } else {
        targetPosition = episode;
    }

    // Fallback: locate the TraktEpisode at `targetPosition` across all seasons
    let absoluteCount = 0;
    const sortedSeasons = [...seasons].sort((a, b) => a.number - b.number);
    for (const seasonData of sortedSeasons) {
        for (const ep of seasonData.episodes) {
            absoluteCount++;
            if (absoluteCount === targetPosition) {
                console.log(
                    `[Trakt] Absolute episode match: ep ${targetPosition} → S${String(ep.season).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`,
                );
                return ep;
            }
        }
    }

    console.log(`[Trakt] Could not resolve episode ${episode} for ${show.title}`);
    return null;
}

// ---------------------------------------------------------------------------
// History check
// ---------------------------------------------------------------------------

/**
 * Check whether an episode is already in the user's Trakt history.
 * Results are cached for the session to avoid repeated API calls.
 * Returns null when the history check fails (not cached).
 */
async function isAlreadyInHistory(showId: number, season: number, episode: number): Promise<boolean | null> {
    const key = `${showId}:${season}:${episode}`;
    if (historyCache.has(key)) return historyCache.get(key) ?? null;

    const history = await getHistory(showId, season, episode);
    if (history === null) return null; // Don't cache errors

    const isInHistory = history.length > 0;
    historyCache.set(key, isInHistory);
    return isInHistory;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * High-level scrobble entry point called from the main update loop.
 *
 * Flow:
 * 1. Check if Trakt sync is enabled
 * 2. Check authentication
 * 3. Anime-only gate (mal_id must be non-null)
 * 4. Resolve Trakt show
 * 5. Resolve episode
 * 6. State machine → appropriate scrobble call
 * 7. Cooldown/dedup checks
 */
export async function tryScrobble(data: MpvData): Promise<void> {
    // 1. Trakt sync enabled?
    if (!config.trakt.enabled) return;

    // 2. Authenticated?
    if (!isAuthenticated()) return;

    // 3. Anime-only gate
    if (!data.mal_id) {
        console.log("[Trakt] Skipping non-anime content (mal_id is null)");
        return;
    }

    // 4. Must have an episode number
    const episodeNum = data.episode;
    if (episodeNum == null) return;

    // 5. Detect metadata change (filename, title, season, or episode) → reset state machine
    const metadataKey = `${data.filename}:${data.series_title}:${data.season}:${data.episode}`;
    if (metadataKey !== currentMetadataKey) {
        // If we were actively playing, scrobble stop with last known progress
        if (
            (currentState === "playing" || currentState === "paused") &&
            currentShow &&
            currentEpisode &&
            lastKnownProgress >= 1
        ) {
            const gate = getSyncGateDecision(currentShow.ids.trakt, currentEpisode.number, currentEpisode.season, true);
            if (gate === "allow") {
                const success = await scrobbleStop(currentEpisode, currentShow, lastKnownProgress);
                if (!success) {
                    queueBacklog("stop", currentEpisode, currentShow, lastKnownProgress);
                } else {
                    recordSyncSuccess(currentShow.ids.trakt, currentEpisode.number, currentEpisode.season);
                }
            }
        }

        currentMetadataKey = metadataKey;
        currentState = "idle";
        currentShow = null;
        currentEpisode = null;
        lastKnownProgress = 0;
    }

    // Track progress for potential stop-on-file-change
    lastKnownProgress = data.percent_pos;

    // 6. Resolve Trakt show (cached)
    if (!currentShow) {
        const resolved = await resolveTraktShow(data);
        if (!resolved) {
            console.log("[Trakt] Could not resolve show for:", data.series_title);
            return;
        }
        currentShow = resolved.show;
    }

    // 7. Resolve episode (cached)
    if (!currentEpisode) {
        const resolvedEp = await resolveEpisode(currentShow, data.season, episodeNum);
        if (!resolvedEp) {
            console.log(`[Trakt] Could not resolve episode ${episodeNum} for ${currentShow.title}`);
            return;
        }
        currentEpisode = resolvedEp;
    }

    // 8. Process any queued backlog from previous failures
    await processBacklog();

    // 9. Trakt requires progress >= 1% for any scrobble action
    const progress = data.percent_pos;
    if (progress < 1) return;

    // 10. State machine transitions
    const isPaused = data.pause;
    const threshold = config.trakt.syncThreshold;
    const showId = currentShow.ids.trakt;
    const epSeason = currentEpisode.season;
    const epNumber = currentEpisode.number;
    const lockKey = `${showId}:${epSeason}:${epNumber}`;

    switch (currentState) {
        case "idle": {
            if (!isPaused) {
                // If already past threshold, skip start and go straight to stop
                if (progress >= threshold) {
                    const gate = getSyncGateDecision(showId, epNumber, epSeason, true);
                    if (gate === "already_success") {
                        currentState = "stopped";
                        return;
                    }

                    syncInProgress.add(lockKey);
                    try {
                        recordSyncAttempt(showId, epNumber, epSeason);
                        const success = await scrobbleStop(currentEpisode, currentShow, progress);
                        if (success) {
                            recordSyncSuccess(showId, epNumber, epSeason);
                        } else {
                            queueBacklog("stop", currentEpisode, currentShow, progress);
                        }
                    } finally {
                        syncInProgress.delete(lockKey);
                    }
                    currentState = "stopped";
                    return;
                }

                // idle → playing: scrobble start
                const gate = getSyncGateDecision(showId, epNumber, epSeason, false);
                if (gate !== "allow") return;

                // Check history to avoid re-scrobbling
                const inHistory = await isAlreadyInHistory(showId, epSeason, epNumber);
                if (inHistory === true) {
                    recordSyncSuccess(showId, epNumber, epSeason);
                    currentState = "playing";
                    return;
                }

                syncInProgress.add(lockKey);
                try {
                    recordSyncAttempt(showId, epNumber, epSeason);
                    const success = await scrobbleStart(currentEpisode, currentShow, progress);
                    if (!success) {
                        queueBacklog("start", currentEpisode, currentShow, progress);
                    }
                } finally {
                    syncInProgress.delete(lockKey);
                }
                currentState = "playing";
            }
            break;
        }

        case "playing": {
            // If already past threshold, mark as watched regardless of pause state
            if (progress >= threshold) {
                const gate = getSyncGateDecision(showId, epNumber, epSeason, true);
                if (gate === "already_success") {
                    currentState = "stopped";
                    return;
                }

                syncInProgress.add(lockKey);
                try {
                    const success = await scrobbleStop(currentEpisode, currentShow, progress);
                    if (success) {
                        recordSyncSuccess(showId, epNumber, epSeason);
                    } else {
                        queueBacklog("stop", currentEpisode, currentShow, progress);
                    }
                } finally {
                    syncInProgress.delete(lockKey);
                }
                currentState = "stopped";
            } else if (isPaused) {
                // playing → paused: scrobble pause
                const success = await scrobblePause(currentEpisode, currentShow, progress);
                if (!success) {
                    queueBacklog("pause", currentEpisode, currentShow, progress);
                }
                currentState = "paused";
            }
            break;
        }

        case "paused": {
            // If already past threshold, mark as watched instead of resuming
            if (progress >= threshold) {
                const gate = getSyncGateDecision(showId, epNumber, epSeason, true);
                if (gate === "already_success") {
                    currentState = "stopped";
                    return;
                }

                syncInProgress.add(lockKey);
                try {
                    const success = await scrobbleStop(currentEpisode, currentShow, progress);
                    if (success) {
                        recordSyncSuccess(showId, epNumber, epSeason);
                    } else {
                        queueBacklog("stop", currentEpisode, currentShow, progress);
                    }
                } finally {
                    syncInProgress.delete(lockKey);
                }
                currentState = "stopped";
            } else if (!isPaused) {
                // paused → playing: scrobble start (resume)
                const success = await scrobbleStart(currentEpisode, currentShow, progress);
                if (!success) {
                    queueBacklog("start", currentEpisode, currentShow, progress);
                }
                currentState = "playing";
            }
            break;
        }

        case "stopped":
            // Stay stopped until filename changes (handled above)
            break;
    }
}

/**
 * Stop the current scrobble when MPV disconnects or the app shuts down.
 */
export async function stopCurrentScrobble(): Promise<void> {
    if ((currentState !== "playing" && currentState !== "paused") || !currentShow || !currentEpisode) return;
    if (lastKnownProgress < 1) return;

    const gate = getSyncGateDecision(currentShow.ids.trakt, currentEpisode.number, currentEpisode.season, true);
    if (gate === "already_success") {
        // Already synced, just reset state
        currentState = "idle";
        currentShow = null;
        currentEpisode = null;
        currentMetadataKey = null;
        lastKnownProgress = 0;
        return;
    }
    // Only block on "in_progress", allow through "cooldown" for disconnect/shutdown stops
    if (gate === "in_progress") return;

    syncInProgress.add(`${currentShow.ids.trakt}:${currentEpisode.season}:${currentEpisode.number}`);
    try {
        const success = await scrobbleStop(currentEpisode, currentShow, lastKnownProgress);
        if (success) {
            recordSyncSuccess(currentShow.ids.trakt, currentEpisode.number, currentEpisode.season);

            // Warn user if progress is below threshold
            const threshold = config.trakt.syncThreshold;
            if (lastKnownProgress < threshold) {
                console.log(
                    `[Trakt] MPV closed at ${Math.round(lastKnownProgress)}% progress. ` +
                        `Trakt only marks episodes as watched at >=${threshold}%. ` +
                        `Progress saved (paused state).`,
                );
            }
        } else {
            // Queue failed stop for retry on next reconnect
            queueBacklog("stop", currentEpisode, currentShow, lastKnownProgress);
        }
    } finally {
        syncInProgress.delete(`${currentShow.ids.trakt}:${currentEpisode.season}:${currentEpisode.number}`);
    }

    currentState = "idle";
    currentShow = null;
    currentEpisode = null;
    currentMetadataKey = null;
    lastKnownProgress = 0;
}
