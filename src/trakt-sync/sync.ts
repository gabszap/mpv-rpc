/**
 * Trakt.tv Sync Module
 * High-level scrobble logic with state machine, cooldown, dedup, and backlog
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../config";
import type { MpvData } from "../mpv";
import { readStremioPlaybackContext } from "../stremio-sync/context";
import { getCanonicalEpisodePosition } from "../stremio-sync/identity";
import {
    getHistory,
    getShowSeasons,
    logTraktDiagnostic,
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

/** Unresolved episode logs, keyed by "showId:season:episode" to avoid update-loop spam. */
const unresolvedEpisodeLogCache = new Set<string>();

// ---------------------------------------------------------------------------
// Cooldown / dedup state
// ---------------------------------------------------------------------------

const lastSuccess = new Map<string, { episode: number; season: number; timestamp: number }>();
const lastAttempted = new Map<string, { timestamp: number }>();
const syncInProgress = new Set<string>();
const COOLDOWN_MS = 60 * 1000; // 60 seconds per episode
const STOP_LOCK_WAIT_MS = 10_000;

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

function logUnresolvedEpisodeOnce(show: TraktShow, season: number | null, episode: number, message: string): void {
    const key = `${show.ids.trakt}:${season ?? "absolute"}:${episode}`;
    if (unresolvedEpisodeLogCache.has(key)) return;

    unresolvedEpisodeLogCache.add(key);
    logTraktDiagnostic(message);
    console.log(message);
}

function logResolutionDiagnostic(message: string): void {
    logTraktDiagnostic(message);
    console.log(message);
}

async function waitForSyncLockRelease(lockKey: string): Promise<void> {
    const startTime = Date.now();
    while (syncInProgress.has(lockKey) && Date.now() - startTime < STOP_LOCK_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
let stopCurrentScrobblePromise: Promise<void> | null = null;

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
                logResolutionDiagnostic(
                    `[Trakt] IMDB ID ${imdbId} resolved to "${result.show.title}" but expected "${title}" — falling back to title search`,
                );
            } else {
                const entry: { show: TraktShow; imdbId?: string } = { show: result.show, imdbId };
                showCache.set(cacheKey, entry);
                logResolutionDiagnostic(`[Trakt] Resolved show via imdb_id: ${result.show.title}`);
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
                logResolutionDiagnostic(
                    `[Trakt] TVDB ID ${tvdbId} resolved to "${result.show.title}" but expected "${title}" — falling back to title search`,
                );
            } else {
                const entry: { show: TraktShow; imdbId?: string } = { show: result.show };
                showCache.set(cacheKey, entry);
                logResolutionDiagnostic(`[Trakt] Resolved show via tvdb_id: ${result.show.title}`);
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
    logResolutionDiagnostic(`[Trakt] Resolved show via search: ${best.show.title} (score: ${best.score})`);
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

type AbsoluteSeasonCountRule = {
    normalizedTitleIncludes: string;
    seasonEpisodeCounts: readonly number[];
};

const ABSOLUTE_SEASON_COUNT_RULES: AbsoluteSeasonCountRule[] = [
    {
        normalizedTitleIncludes: "jujutsu kaisen",
        seasonEpisodeCounts: [24, 23, 24],
    },
];

function hasRegularEpisodeNumber(traktEpisode: TraktEpisode): boolean {
    return traktEpisode.season > 0 && Number.isInteger(traktEpisode.number) && traktEpisode.number > 0;
}

function readPositiveEpisodeCount(value: unknown): number | null {
    return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : null;
}

/**
 * Map a season/episode pair to its absolute episode position across a sequence
 * of consecutive seasons.
 *
 * Returns `null` when the mapping is not safe — for example when one or more
 * prior regular seasons are missing from the input. In that case the caller
 * must skip the scrobble instead of guessing the absolute position.
 *
 * Season 0 (specials/OVAs) is treated as "outside the main series": it does
 * not count toward the consecutiveness check and is excluded from the
 * cumulative episode count. Mapping a target that lives in season 0 itself
 * returns `null` — this helper is only meaningful for regular seasons.
 *
 * @param current The parsed season/episode target.
 * @param seasons Season metadata in any order. Will be sorted by season ascending.
 * @returns The absolute episode number plus an informational SxxExx label, or null.
 */
export function mapSeasonEpisodeToAbsolute(
    current: SeasonEpisode,
    seasons: SeasonInfo[],
): { absoluteEpisode: number; seasonEpisode: string } | null {
    // Specials (season 0) live outside the main series; the helper is
    // not useful for them.
    if (current.season <= 0) return null;
    if (current.episode <= 0) return null;

    const episodeCountBySeason = new Map<number, number>();
    for (const seasonInfo of seasons) {
        if (seasonInfo.season <= 0) continue;
        if (!Number.isInteger(seasonInfo.episodeCount) || seasonInfo.episodeCount < 1) return null;
        if (episodeCountBySeason.has(seasonInfo.season)) return null;

        episodeCountBySeason.set(seasonInfo.season, seasonInfo.episodeCount);
    }

    let priorEpisodeCount = 0;
    for (let seasonNumber = 1; seasonNumber < current.season; seasonNumber++) {
        const episodeCount = episodeCountBySeason.get(seasonNumber);
        if (!episodeCount) return null;

        priorEpisodeCount += episodeCount;
    }

    const currentSeasonEpisodeCount = episodeCountBySeason.get(current.season);
    if (currentSeasonEpisodeCount !== undefined && current.episode > currentSeasonEpisodeCount) {
        return null;
    }

    return {
        absoluteEpisode: priorEpisodeCount + current.episode,
        seasonEpisode: `S${pad2(current.season)}E${pad2(current.episode)}`,
    };
}

function readTopLevelSeasonInfos(seasons: TraktSeasonEpisode[]): SeasonInfo[] {
    const seasonInfos: SeasonInfo[] = [];

    for (const seasonData of seasons) {
        if (seasonData.number <= 0) continue;

        if (Array.isArray(seasonData.episodes)) {
            const listedEpisodeCount = seasonData.episodes.filter(hasRegularEpisodeNumber).length;
            if (listedEpisodeCount > 0) {
                seasonInfos.push({ season: seasonData.number, episodeCount: listedEpisodeCount });
            }
            continue;
        }

        const fallbackEpisodeCount =
            readPositiveEpisodeCount(seasonData.episode_count) ?? readPositiveEpisodeCount(seasonData.aired_episodes);
        if (fallbackEpisodeCount) {
            seasonInfos.push({ season: seasonData.number, episodeCount: fallbackEpisodeCount });
        }
    }

    return seasonInfos;
}

function readNestedEpisodeSeasonInfos(seasons: TraktSeasonEpisode[]): SeasonInfo[] {
    const episodeCountBySeason = new Map<number, number>();

    for (const seasonData of seasons) {
        for (const traktEpisode of seasonData.episodes ?? []) {
            if (traktEpisode.season <= 0) continue;
            if (!hasRegularEpisodeNumber(traktEpisode)) continue;

            const currentCount = episodeCountBySeason.get(traktEpisode.season) ?? 0;
            episodeCountBySeason.set(traktEpisode.season, currentCount + 1);
        }
    }

    return [...episodeCountBySeason.entries()].map(([seasonNumber, episodeCount]) => ({
        season: seasonNumber,
        episodeCount,
    }));
}

function mapSeasonEpisodeToSafeAbsolute(
    seasons: TraktSeasonEpisode[],
    current: SeasonEpisode,
): { absoluteEpisode: number; seasonEpisode: string } | null {
    return (
        mapSeasonEpisodeToAbsolute(current, readTopLevelSeasonInfos(seasons)) ??
        mapSeasonEpisodeToAbsolute(current, readNestedEpisodeSeasonInfos(seasons))
    );
}

function mapKnownAbsoluteSeasonEpisode(
    show: TraktShow,
    current: SeasonEpisode,
): { absoluteEpisode: number; seasonEpisode: string } | null {
    const normalizedTitle = normalizeTitle(show.title);
    const rule = ABSOLUTE_SEASON_COUNT_RULES.find((candidate) =>
        normalizedTitle.includes(candidate.normalizedTitleIncludes),
    );
    if (!rule) return null;

    const seasonInfos = rule.seasonEpisodeCounts.map((episodeCount, index) => ({
        season: index + 1,
        episodeCount,
    }));
    return mapSeasonEpisodeToAbsolute(current, seasonInfos);
}

function hasSingleRegularSeasonBucket(seasons: TraktSeasonEpisode[]): boolean {
    const regularSeasonNumbers = seasons
        .map((seasonData) => seasonData.number)
        .filter((seasonNumber) => seasonNumber > 0);

    return regularSeasonNumbers.length === 1 && regularSeasonNumbers[0] === 1;
}

function findDirectSeasonEpisode(seasons: TraktSeasonEpisode[], season: number, episode: number): TraktEpisode | null {
    for (const seasonData of seasons) {
        for (const traktEpisode of seasonData.episodes ?? []) {
            if (traktEpisode.season === season && traktEpisode.number === episode) {
                return traktEpisode;
            }
        }
    }

    const targetSeasonData = seasons.find((seasonData) => seasonData.number === season);
    return targetSeasonData?.episodes?.find((traktEpisode) => traktEpisode.number === episode) ?? null;
}

function resolveAbsoluteEpisode(seasons: TraktSeasonEpisode[], absoluteEpisode: number): TraktEpisode | null {
    if (absoluteEpisode < 1) return null;

    let expectedSeason = 1;
    let absoluteCount = 0;
    const sortedRegularSeasons = [...seasons]
        .filter((seasonData) => seasonData.number > 0)
        .sort((a, b) => a.number - b.number);

    for (const seasonData of sortedRegularSeasons) {
        if (seasonData.number !== expectedSeason) {
            return null;
        }

        expectedSeason++;

        for (const traktEpisode of seasonData.episodes ?? []) {
            if (!hasRegularEpisodeNumber(traktEpisode)) continue;

            absoluteCount++;
            if (absoluteCount === absoluteEpisode) {
                return traktEpisode;
            }
        }
    }

    return null;
}

function findEpisodeByNumberAcrossRegularSeasons(
    seasons: TraktSeasonEpisode[],
    episodeNumber: number,
): TraktEpisode | null {
    if (episodeNumber < 1) return null;

    const sortedRegularSeasons = [...seasons]
        .filter((seasonData) => seasonData.number > 0)
        .sort((a, b) => a.number - b.number);

    for (const seasonData of sortedRegularSeasons) {
        const match = seasonData.episodes?.find(
            (traktEpisode) => hasRegularEpisodeNumber(traktEpisode) && traktEpisode.number === episodeNumber,
        );
        if (match) return match;
    }

    return null;
}

function resolveCumulativeAbsoluteEpisode(seasons: TraktSeasonEpisode[], absoluteEpisode: number): TraktEpisode | null {
    return (
        findEpisodeByNumberAcrossRegularSeasons(seasons, absoluteEpisode) ??
        resolveAbsoluteEpisode(seasons, absoluteEpisode)
    );
}

/**
 * Resolve a season + episode pair to a Trakt episode object.
 *
 * When a season was provided, direct season/episode matches are preferred.
 * If that direct lookup fails, a cumulative absolute episode is only attempted
 * when prior regular season counts are consecutive and therefore safe.
 *
 * When season is null (common for anime-local numbering), falls back to
 * absolute episode-number matching across consecutive regular seasons.
 *
 * Season data is cached in-memory per session.
 */
export async function resolveEpisode(
    show: TraktShow,
    season: number | null,
    episode: number,
    options: { allowKnownAbsoluteSeasonMapping?: boolean } = {},
): Promise<TraktEpisode | null> {
    if (episode == null) return null;

    const showId = show.ids.trakt;

    // Fetch and cache season data if not already cached
    if (!seasonCache.has(showId)) {
        const seasons = await getShowSeasons(showId);
        if (seasons.length === 0) {
            logResolutionDiagnostic(`[Trakt] No season data for show: ${show.title}`);
            return null;
        }
        seasonCache.set(showId, seasons);
    }

    const seasons = seasonCache.get(showId);
    if (!seasons) return null;

    if (season != null) {
        const directEpisode = findDirectSeasonEpisode(seasons, season, episode);
        if (directEpisode) return directEpisode;

        const absoluteMapping =
            mapSeasonEpisodeToSafeAbsolute(seasons, { season, episode }) ??
            (options.allowKnownAbsoluteSeasonMapping === false || !hasSingleRegularSeasonBucket(seasons)
                ? null
                : mapKnownAbsoluteSeasonEpisode(show, { season, episode }));
        if (absoluteMapping) {
            const cumulativeEpisode = resolveCumulativeAbsoluteEpisode(seasons, absoluteMapping.absoluteEpisode);
            if (cumulativeEpisode) {
                logResolutionDiagnostic(
                    `[Trakt] Cumulative episode match: ${absoluteMapping.seasonEpisode} → absolute ep ${absoluteMapping.absoluteEpisode} → S${pad2(cumulativeEpisode.season)}E${pad2(cumulativeEpisode.number)}`,
                );
                return cumulativeEpisode;
            }
        }

        logUnresolvedEpisodeOnce(
            show,
            season,
            episode,
            `[Trakt] Could not resolve ${show.title} S${pad2(season)}E${pad2(episode)} directly in Trakt seasons.`,
        );
        return null;
    }

    const absoluteMatch = resolveAbsoluteEpisode(seasons, episode);
    if (absoluteMatch) {
        logResolutionDiagnostic(
            `[Trakt] Absolute episode match: ep ${episode} → S${String(absoluteMatch.season).padStart(2, "0")}E${String(absoluteMatch.number).padStart(2, "0")}`,
        );
        return absoluteMatch;
    }

    logUnresolvedEpisodeOnce(show, season, episode, `[Trakt] Could not resolve episode ${episode} for ${show.title}`);
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

    const canonicalPosition = getCanonicalEpisodePosition(readStremioPlaybackContext(), data);

    // 4. Must have an episode number
    const episodeNum = canonicalPosition.episode;
    if (episodeNum == null) return;
    const seasonNum = canonicalPosition.season;

    // 5. Detect metadata change (filename, title, season, or episode) → reset state machine
    const metadataKey = `${data.filename}:${data.series_title}:${seasonNum}:${episodeNum}`;
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
                    if (!config.syncDryRun) {
                        console.log(
                            `[Trakt] Marked as watched: ${currentShow.title} S${String(currentEpisode.season).padStart(2, "0")}E${String(currentEpisode.number).padStart(2, "0")}`,
                        );
                    }
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
        const resolvedEp = await resolveEpisode(currentShow, seasonNum, episodeNum, {
            allowKnownAbsoluteSeasonMapping: canonicalPosition.source !== "playback",
        });
        if (!resolvedEp) {
            logUnresolvedEpisodeOnce(
                currentShow,
                seasonNum,
                episodeNum,
                `[Trakt] Could not resolve episode ${episodeNum} for ${currentShow.title}`,
            );
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
                            if (!config.syncDryRun) {
                                console.log(
                                    `[Trakt] Marked as watched: ${currentShow.title} S${String(epSeason).padStart(2, "0")}E${String(epNumber).padStart(2, "0")}`,
                                );
                            }
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
                        if (!config.syncDryRun) {
                            console.log(
                                `[Trakt] Marked as watched: ${currentShow.title} S${String(epSeason).padStart(2, "0")}E${String(epNumber).padStart(2, "0")}`,
                            );
                        }
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
                        if (!config.syncDryRun) {
                            console.log(
                                `[Trakt] Marked as watched: ${currentShow.title} S${String(epSeason).padStart(2, "0")}E${String(epNumber).padStart(2, "0")}`,
                            );
                        }
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
    if (stopCurrentScrobblePromise) {
        return stopCurrentScrobblePromise;
    }

    stopCurrentScrobblePromise = stopCurrentScrobbleOnce().finally(() => {
        stopCurrentScrobblePromise = null;
    });

    return stopCurrentScrobblePromise;
}

async function stopCurrentScrobbleOnce(): Promise<void> {
    if ((currentState !== "playing" && currentState !== "paused") || !currentShow || !currentEpisode) return;
    if (lastKnownProgress < 1) return;

    const show = currentShow;
    const episode = currentEpisode;
    const progress = lastKnownProgress;
    const lockKey = `${show.ids.trakt}:${episode.season}:${episode.number}`;

    await waitForSyncLockRelease(lockKey);

    const gate = getSyncGateDecision(show.ids.trakt, episode.number, episode.season, true);
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

    syncInProgress.add(lockKey);
    try {
        const success = await scrobbleStop(episode, show, progress);
        if (success) {
            // Warn user if progress is below threshold
            const threshold = config.trakt.syncThreshold;
            if (progress >= threshold) {
                recordSyncSuccess(show.ids.trakt, episode.number, episode.season);
            } else {
                if (config.syncDryRun) {
                    console.log(
                        `[Trakt][Dry-run] MPV closed at ${Math.round(progress)}% progress. ` +
                            `Would save paused progress; Trakt only marks episodes as watched at >=${threshold}%.`,
                    );
                } else {
                    console.log(
                        `[Trakt] MPV closed at ${Math.round(progress)}% progress. ` +
                            `Trakt only marks episodes as watched at >=${threshold}%. ` +
                            `Progress saved (paused state).`,
                    );
                }
            }
        } else {
            // Queue failed stop for retry on next reconnect
            queueBacklog("stop", episode, show, progress);
        }
    } finally {
        syncInProgress.delete(lockKey);
    }

    currentState = "idle";
    currentShow = null;
    currentEpisode = null;
    currentMetadataKey = null;
    lastKnownProgress = 0;
}
