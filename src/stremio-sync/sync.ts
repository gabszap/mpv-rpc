import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../config";
import type { MpvData } from "../mpv";
import { getLibraryItem, type LibraryItem, type LibraryItemState, nowTimestamp, putLibraryItem } from "./api";
import { getStremioAuthKey } from "./auth";
import { isEpisodeWatched, markEpisodeWatched } from "./bitset";
import { readStremioPlaybackContext, type StremioPlaybackContext } from "./context";
import {
    type CanonicalStremioIdentity,
    type EpisodePosition,
    getCanonicalEpisodePosition,
    getCanonicalStremioIdentity,
} from "./identity";
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
const dryRunContinueWatchingMilestonesByIdentity = new Map<string, Set<number>>();
const MIN_CONTINUE_WATCHING_PERCENT = 1;
const MIN_CONTINUE_WATCHING_SECONDS = 5;
const DRY_RUN_PROGRESS_MILESTONES = [25, 50, 75, 80, 90, 100] as const;

function shouldSyncProgress(libraryItemId: string, nowMs: number): boolean {
    const lastSyncMs = lastProgressSyncByLibraryItem.get(libraryItemId);
    if (lastSyncMs !== undefined && nowMs - lastSyncMs < config.stremio.progressIntervalMs) {
        return false;
    }

    return true;
}

function cloneLibraryItemWithProgress(
    item: LibraryItem,
    data: MpvData,
    context: StremioPlaybackContext,
    season: number | null,
    episode: number | null,
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

    if (context.type === "series" && season !== null && episode !== null) {
        nextState.season = season;
        nextState.episode = episode;
    }

    // Mark watched if conditions are met
    const shouldMarkWatched =
        context.type === "series" &&
        season != null &&
        episode != null &&
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
                        `[Stremio] Marked as watched: ${context.name || context.libraryItemId} S${season}E${episode}`,
                    );
                    appendSyncLog({
                        step: "watched-marked",
                        libraryItemId: context.libraryItemId,
                        season,
                        episode,
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

function getUsefulDryRunTitle(data: MpvData, canonicalIdentity: CanonicalStremioIdentity | null): string | null {
    const title = canonicalIdentity?.context.name || data.series_title;
    const normalizedTitle = title.trim().toLowerCase();

    if (!normalizedTitle || normalizedTitle === "n/a" || normalizedTitle === "unknown") {
        return null;
    }

    return title;
}

function normalizeDryRunIdentityTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function getDryRunContinueWatchingIdentityKey(title: string, position: EpisodePosition): string {
    return `${normalizeDryRunIdentityTitle(title)}|S${position.season}|E${position.episode}`;
}

function getBoundedDryRunPercent(roundedPercent: number): number {
    if (!Number.isFinite(roundedPercent)) {
        return roundedPercent;
    }

    return Math.min(100, Math.max(0, roundedPercent));
}

function getReachedDryRunMilestone(roundedPercent: number): number | null {
    const boundedPercent = getBoundedDryRunPercent(roundedPercent);
    if (!Number.isFinite(boundedPercent)) {
        return null;
    }

    for (let i = DRY_RUN_PROGRESS_MILESTONES.length - 1; i >= 0; i -= 1) {
        const milestone = DRY_RUN_PROGRESS_MILESTONES[i];
        if (milestone === undefined) {
            continue;
        }

        if (boundedPercent >= milestone) {
            return milestone;
        }
    }

    return null;
}

function getReachedDryRunMilestones(roundedPercent: number): number[] {
    const boundedPercent = getBoundedDryRunPercent(roundedPercent);
    if (!Number.isFinite(boundedPercent)) {
        return [];
    }

    return DRY_RUN_PROGRESS_MILESTONES.filter((milestone) => boundedPercent >= milestone);
}

type DryRunContinueWatchingLog = {
    episodeLabel: string;
    identityKey: string;
    reachedMilestone: number | null;
    roundedPercent: number;
    seasonLabel: string;
    title: string;
};

type PendingDryRunContinueWatchingLog = DryRunContinueWatchingLog & {
    displayPercent: number;
};

function formatDryRunContinueWatchingLog(
    data: MpvData,
    canonicalIdentity: CanonicalStremioIdentity | null,
    position: EpisodePosition,
): DryRunContinueWatchingLog | null {
    if (position.season === null || position.episode === null || position.season < 1 || position.episode < 1) {
        return null;
    }

    const title = getUsefulDryRunTitle(data, canonicalIdentity);
    if (!title) {
        return null;
    }

    const season = String(position.season).padStart(2, "0");
    const episode = String(position.episode).padStart(2, "0");
    const roundedPercent = Math.round(data.percent_pos);

    return {
        episodeLabel: episode,
        identityKey: getDryRunContinueWatchingIdentityKey(title, position),
        reachedMilestone: getReachedDryRunMilestone(roundedPercent),
        roundedPercent: getBoundedDryRunPercent(roundedPercent),
        seasonLabel: season,
        title,
    };
}

function selectPendingDryRunContinueWatchingLog(
    log: DryRunContinueWatchingLog,
): PendingDryRunContinueWatchingLog | null {
    const loggedMilestones = dryRunContinueWatchingMilestonesByIdentity.get(log.identityKey);
    if (!loggedMilestones) {
        return { ...log, displayPercent: log.roundedPercent };
    }

    if (log.reachedMilestone === null || loggedMilestones.has(log.reachedMilestone)) {
        return null;
    }

    return { ...log, displayPercent: log.reachedMilestone };
}

function formatPendingDryRunContinueWatchingMessage(log: PendingDryRunContinueWatchingLog): string {
    return `[Stremio][dry-run] Would write continue-watching: ${log.title} S${log.seasonLabel}E${log.episodeLabel} ${log.displayPercent}%`;
}

function rememberDryRunContinueWatchingLog(log: PendingDryRunContinueWatchingLog): void {
    const loggedMilestones = dryRunContinueWatchingMilestonesByIdentity.get(log.identityKey) ?? new Set<number>();

    if (log.reachedMilestone === null) {
        dryRunContinueWatchingMilestonesByIdentity.set(log.identityKey, loggedMilestones);
        return;
    }

    for (const milestone of getReachedDryRunMilestones(log.roundedPercent)) {
        loggedMilestones.add(milestone);
    }

    dryRunContinueWatchingMilestonesByIdentity.set(log.identityKey, loggedMilestones);
}

export async function trySyncStremio(data: MpvData): Promise<StremioSyncResult> {
    const context = readStremioPlaybackContext();
    const canonicalIdentity = getCanonicalStremioIdentity(context, data);
    const dryRunPosition = getCanonicalEpisodePosition(context, data);

    if (config.syncDryRun) {
        const dryRunLog = formatDryRunContinueWatchingLog(data, canonicalIdentity, dryRunPosition);
        const pendingDryRunLog = dryRunLog ? selectPendingDryRunContinueWatchingLog(dryRunLog) : null;
        if (pendingDryRunLog) {
            console.log(formatPendingDryRunContinueWatchingMessage(pendingDryRunLog));
            rememberDryRunContinueWatchingLog(pendingDryRunLog);
        }
        return { status: "skipped", reason: "dry-run" };
    }

    const authKey = getStremioAuthKey();
    if (!authKey) {
        appendSyncLog({ step: "auth", result: "skipped", reason: "missing-auth" });
        return { status: "skipped", reason: "missing-auth" };
    }

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

    const contextMatch = canonicalIdentity !== null;
    appendSyncLog({ step: "context-match", matched: contextMatch });
    if (!contextMatch) {
        return { status: "skipped", reason: "playback-context-mismatch" };
    }

    const authoritativeContext = canonicalIdentity.context;
    const videoId = canonicalIdentity.videoId;
    appendSyncLog({ step: "video-id", videoId });
    if (!videoId) {
        return { status: "skipped", reason: "missing-video-id" };
    }

    const now = new Date();
    const nowMs = now.getTime();
    const shouldSync = shouldSyncProgress(authoritativeContext.libraryItemId, nowMs);
    appendSyncLog({ step: "throttle", shouldSync, libraryItemId: authoritativeContext.libraryItemId });
    if (!shouldSync) {
        return { status: "skipped", reason: "progress-interval" };
    }

    try {
        const libraryItem = await getLibraryItem(authoritativeContext.libraryItemId, authKey);
        appendSyncLog({
            step: "library-item-fetch",
            found: libraryItem !== null,
            libraryItemId: authoritativeContext.libraryItemId,
        });
        if (!libraryItem) {
            return { status: "skipped", reason: "library-item-not-found" };
        }

        // Fetch video IDs for watched marking
        let videoIds: string[] | null = null;
        if (authoritativeContext.imdbId && authoritativeContext.type === "series") {
            videoIds = await fetchVideoIds(authoritativeContext.imdbId);
        }

        const originalMtime = libraryItem._mtime;
        const originalTimeOffset = (libraryItem.state as Record<string, unknown> | undefined)?.timeOffset;
        const updatedItem = cloneLibraryItemWithProgress(
            libraryItem,
            data,
            authoritativeContext,
            canonicalIdentity.season,
            canonicalIdentity.episode,
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
        lastProgressSyncByLibraryItem.set(authoritativeContext.libraryItemId, nowMs);

        appendSyncLog({ step: "put", result: "success", libraryItemId: authoritativeContext.libraryItemId });
        return { status: "synced", libraryItemId: authoritativeContext.libraryItemId };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        appendSyncLog({ step: "error", reason });
        return { status: "error", reason };
    }
}

export function resetStremioSyncStateForTests(): void {
    lastProgressSyncByLibraryItem.clear();
    dryRunContinueWatchingMilestonesByIdentity.clear();
}
