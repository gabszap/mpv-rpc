import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../config";
import type { MpvData } from "../mpv";
import { getLibraryItem, type LibraryItem, type LibraryItemState, nowTimestamp, putLibraryItem } from "./api";
import { getStremioAuthKey } from "./auth";
import { isEpisodeWatched, markEpisodeWatched } from "./bitset";
import { readStremioPlaybackContext, type StremioPlaybackContext } from "./context";
import { fetchVideoIds } from "./meta";

const SYNC_LOG_PATH = path.join(process.cwd(), ".anime_cache", "stremio_sync_log.txt");

export function appendSyncLog(entry: Record<string, unknown>): void {
    if (!config.debug) {
        return;
    }
    try {
        const dir = path.dirname(SYNC_LOG_PATH);
        fs.mkdirSync(dir, { recursive: true });
        const timestamp = nowTimestamp();
        const block = `--- ${timestamp} ---\n${JSON.stringify({ ...entry, timestamp }, null, 2)}\n`;
        fs.appendFileSync(SYNC_LOG_PATH, block, "utf-8");
    } catch {
        // Best effort only — logging should never crash the app
    }
}

export type StremioSyncResult =
    | { status: "skipped"; reason: string }
    | { status: "synced"; libraryItemId: string }
    | { status: "error"; reason: string };

const lastProgressSyncByLibraryItem = new Map<string, number>();
const MIN_CONTINUE_WATCHING_PERCENT = 1;
const MIN_CONTINUE_WATCHING_SECONDS = 5;

type EpisodePosition = {
    season: number | null;
    episode: number | null;
};

function buildVideoIdWhenSafe(context: StremioPlaybackContext): string | null {
    if (context.videoId) {
        return context.videoId;
    }

    if (context.type === "movie" && context.imdbId) {
        return context.imdbId;
    }

    if (context.type === "series" && context.imdbId && context.season && context.episode) {
        return `${context.imdbId}:${context.season}:${context.episode}`;
    }

    return null;
}

function shouldSyncProgress(libraryItemId: string, nowMs: number): boolean {
    const lastSyncMs = lastProgressSyncByLibraryItem.get(libraryItemId);
    if (lastSyncMs !== undefined && nowMs - lastSyncMs < config.stremio.progressIntervalMs) {
        return false;
    }

    return true;
}

function parseEpisodePositionFromFilename(filename: string): EpisodePosition {
    const seasonEpisodeMatch = filename.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,4})/);
    if (seasonEpisodeMatch) {
        return {
            season: Number.parseInt(seasonEpisodeMatch[1], 10),
            episode: Number.parseInt(seasonEpisodeMatch[2], 10),
        };
    }

    return { season: null, episode: null };
}

function getCurrentEpisodePosition(data: MpvData): EpisodePosition {
    const filenamePosition = parseEpisodePositionFromFilename(data.filename);

    return {
        season: data.season ?? filenamePosition.season,
        episode: data.episode ?? filenamePosition.episode,
    };
}

function normalizeTitleForMatch(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function stripEpisodeMarkersFromFilename(filename: string): string {
    return filename
        .replace(/\.[^.\\/]+$/, "")
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/[Ss]\d{1,2}[\s._-]*[Ee]\d{1,4}.*/g, " ")
        .replace(/\b[Ee][Pp]?\s*\d{1,4}.*/g, " ")
        .replace(/\s+-\s+\d{1,4}.*/g, " ");
}

function getSafePlaybackTitleCandidates(data: MpvData): string[] {
    return [data.series_title, data.media_title, stripEpisodeMarkersFromFilename(data.filename)]
        .map(normalizeTitleForMatch)
        .filter((title) => title.length > 0);
}

function tokenizeNormalizedTitle(normalizedTitle: string): Set<string> {
    return new Set(normalizedTitle.split(" ").filter((token) => token.length >= 3));
}

function hasSafeTokenOverlap(normalizedContextName: string, normalizedPlaybackTitle: string): boolean {
    const contextTokens = tokenizeNormalizedTitle(normalizedContextName);
    const playbackTokens = tokenizeNormalizedTitle(normalizedPlaybackTitle);

    if (contextTokens.size < 2 || playbackTokens.size < 2) {
        return false;
    }

    const sharedTokenCount = Array.from(contextTokens).filter((token) => playbackTokens.has(token)).length;
    const contextOverlapRatio = sharedTokenCount / contextTokens.size;
    const playbackOverlapRatio = sharedTokenCount / playbackTokens.size;

    return contextOverlapRatio >= 0.8 && playbackOverlapRatio >= 0.6;
}

function doesContextNameMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    if (!context.name) {
        return false;
    }

    const normalizedContextName = normalizeTitleForMatch(context.name);
    if (!normalizedContextName) {
        return false;
    }

    const playbackTitleCandidates = getSafePlaybackTitleCandidates(data);

    return playbackTitleCandidates.some(
        (playbackTitle) =>
            playbackTitle === normalizedContextName || hasSafeTokenOverlap(normalizedContextName, playbackTitle),
    );
}

function doesContextIdMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    return Boolean(context.imdbId && data.imdb_id && context.imdbId === data.imdb_id);
}

function isSeriesContextMatchingPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    const currentPosition = getCurrentEpisodePosition(data);

    if (context.season === null || context.episode === null) {
        return false;
    }

    if (currentPosition.season === null || currentPosition.episode === null) {
        return false;
    }

    if (currentPosition.season !== context.season) {
        return false;
    }

    if (currentPosition.episode !== context.episode) {
        return false;
    }

    if (doesContextIdMatchPlayback(context, data)) {
        return true;
    }

    return doesContextNameMatchPlayback(context, data);
}

function isPlaybackContextMatchingData(context: StremioPlaybackContext, data: MpvData): boolean {
    if (context.imdbId && data.imdb_id && context.imdbId !== data.imdb_id) {
        return false;
    }

    if (context.type === "series" || context.season !== null || context.episode !== null) {
        return isSeriesContextMatchingPlayback(context, data);
    }

    if (context.type === "movie") {
        return doesContextIdMatchPlayback(context, data) || doesContextNameMatchPlayback(context, data);
    }

    return doesContextNameMatchPlayback(context, data);
}

function cloneLibraryItemWithProgress(
    item: LibraryItem,
    data: MpvData,
    context: StremioPlaybackContext,
    videoId: string,
    videoIds: string[] | null,
    now: Date,
    syncThreshold: number,
): LibraryItem {
    const existingState =
        typeof item.state === "object" && item.state !== null && !Array.isArray(item.state) ? item.state : {};

    const nextState: LibraryItemState = {
        ...existingState,
        timeOffset: Math.max(0, Math.floor(data.time_pos * 1000)),
        duration: Math.max(0, Math.floor(data.duration * 1000)),
        video_id: videoId,
        lastWatched: now.toISOString(),
    };

    if (context.type === "series" && context.season !== null && context.episode !== null) {
        nextState.season = context.season;
        nextState.episode = context.episode;
    }

    // Mark watched if conditions are met
    const shouldMarkWatched =
        context.type === "series" &&
        context.season != null &&
        context.episode != null &&
        nextState.video_id &&
        videoIds &&
        videoIds.length > 0 &&
        data.percent_pos >= syncThreshold;

    if (shouldMarkWatched) {
        try {
            const existingWatched = existingState.watched;
            const hasExistingWatched = typeof existingWatched === "string" && existingWatched.length > 0;
            const confirmedVideoIds = videoIds as string[];
            const confirmedVideoId = nextState.video_id as string;

            // Only mark if not already watched
            if (
                !hasExistingWatched ||
                !isEpisodeWatched(
                    existingWatched as string,
                    confirmedVideoIds.length,
                    confirmedVideoId,
                    confirmedVideoIds,
                )
            ) {
                const result = markEpisodeWatched(
                    hasExistingWatched ? (existingWatched as string) : null,
                    confirmedVideoIds.length,
                    confirmedVideoId,
                    confirmedVideoIds,
                );
                if (result.changed) {
                    nextState.watched = result.watched;
                    if (typeof existingState.flagged_watched === "number") {
                        nextState.flagged_watched = 1;
                    }
                    if (typeof existingState.times_watched === "number") {
                        nextState.times_watched = existingState.times_watched + 1;
                    }

                    console.log(
                        `[Stremio] Marked as watched: ${context.name || context.libraryItemId} S${context.season}E${context.episode}`,
                    );
                    appendSyncLog({
                        step: "watched-marked",
                        libraryItemId: context.libraryItemId,
                        season: context.season,
                        episode: context.episode,
                        videoId: nextState.video_id,
                        timestamp: nowTimestamp(),
                    });
                }
            }
        } catch (error) {
            appendSyncLog({
                step: "watched-error",
                reason: error instanceof Error ? error.message : "unknown",
                timestamp: nowTimestamp(),
            });
        }
    }

    return {
        ...item,
        _mtime: now.toISOString(),
        state: nextState,
    };
}

function hasValidPlaybackProgress(data: MpvData): boolean {
    return (
        Number.isFinite(data.time_pos) &&
        data.time_pos >= 0 &&
        Number.isFinite(data.duration) &&
        data.duration > 0 &&
        Number.isFinite(data.percent_pos) &&
        data.percent_pos >= 0
    );
}

function hasUsefulContinueWatchingProgress(data: MpvData): boolean {
    return data.time_pos >= MIN_CONTINUE_WATCHING_SECONDS && data.percent_pos >= MIN_CONTINUE_WATCHING_PERCENT;
}

export async function trySyncStremio(data: MpvData): Promise<StremioSyncResult> {
    if (config.syncDryRun) {
        const season = data.season ?? 0;
        const episode = data.episode ?? 0;
        console.log(
            `[Stremio][dry-run] Would write continue-watching: ${data.series_title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} ${Math.round(data.percent_pos)}%`,
        );
        return { status: "skipped", reason: "dry-run" };
    }

    const authKey = getStremioAuthKey();
    if (!authKey) {
        appendSyncLog({ step: "auth", result: "skipped", reason: "missing-auth" });
        return { status: "skipped", reason: "missing-auth" };
    }

    const context = readStremioPlaybackContext();
    if (!context) {
        appendSyncLog({ step: "context", result: "skipped", reason: "missing-or-invalid-context" });
        return { status: "skipped", reason: "missing-or-invalid-context" };
    }

    appendSyncLog({
        step: "context",
        libraryItemId: context.libraryItemId,
        season: context.season,
        episode: context.episode,
        imdbId: context.imdbId,
        videoId: context.videoId,
        name: context.name,
        type: context.type,
    });

    if (!hasValidPlaybackProgress(data)) {
        appendSyncLog({
            step: "progress-validation",
            result: "skipped",
            reason: "invalid-playback-progress",
            time_pos: data.time_pos,
            duration: data.duration,
            percent_pos: data.percent_pos,
        });
        return { status: "skipped", reason: "invalid-playback-progress" };
    }

    if (!hasUsefulContinueWatchingProgress(data)) {
        appendSyncLog({
            step: "progress-useful",
            result: "skipped",
            reason: "progress-too-low",
            time_pos: data.time_pos,
            percent_pos: data.percent_pos,
        });
        return { status: "skipped", reason: "progress-too-low" };
    }

    appendSyncLog({
        step: "progress",
        time_pos: data.time_pos,
        duration: data.duration,
        percent_pos: data.percent_pos,
    });

    const contextMatch = isPlaybackContextMatchingData(context, data);
    appendSyncLog({ step: "context-match", matched: contextMatch });
    if (!contextMatch) {
        return { status: "skipped", reason: "playback-context-mismatch" };
    }

    const videoId = buildVideoIdWhenSafe(context);
    appendSyncLog({ step: "video-id", videoId });
    if (!videoId) {
        return { status: "skipped", reason: "missing-video-id" };
    }

    const now = new Date();
    const nowMs = now.getTime();
    const shouldSync = shouldSyncProgress(context.libraryItemId, nowMs);
    appendSyncLog({ step: "throttle", shouldSync, libraryItemId: context.libraryItemId });
    if (!shouldSync) {
        return { status: "skipped", reason: "progress-interval" };
    }

    try {
        const libraryItem = await getLibraryItem(context.libraryItemId, authKey);
        appendSyncLog({
            step: "library-item-fetch",
            found: libraryItem !== null,
            libraryItemId: context.libraryItemId,
        });
        if (!libraryItem) {
            return { status: "skipped", reason: "library-item-not-found" };
        }

        // Fetch video IDs for watched marking
        let videoIds: string[] | null = null;
        if (context.imdbId && context.type === "series") {
            videoIds = await fetchVideoIds(context.imdbId);
        }

        const originalMtime = libraryItem._mtime;
        const originalTimeOffset = (libraryItem.state as Record<string, unknown> | undefined)?.timeOffset;
        const updatedItem = cloneLibraryItemWithProgress(
            libraryItem,
            data,
            context,
            videoId,
            videoIds,
            now,
            config.stremio.syncThreshold,
        );

        appendSyncLog({
            step: "clone",
            originalMtime,
            newMtime: updatedItem._mtime,
            originalTimeOffset,
            newTimeOffset: (updatedItem.state as Record<string, unknown>).timeOffset,
            newDuration: (updatedItem.state as Record<string, unknown>).duration,
            newSeason: (updatedItem.state as Record<string, unknown>).season,
            newEpisode: (updatedItem.state as Record<string, unknown>).episode,
        });

        await putLibraryItem(updatedItem, authKey);
        lastProgressSyncByLibraryItem.set(context.libraryItemId, nowMs);

        appendSyncLog({ step: "put", result: "success", libraryItemId: context.libraryItemId });
        return { status: "synced", libraryItemId: context.libraryItemId };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        appendSyncLog({ step: "error", reason });
        return { status: "error", reason };
    }
}

export function resetStremioSyncStateForTests(): void {
    lastProgressSyncByLibraryItem.clear();
}
