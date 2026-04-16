/**
 * MAL Sync Module
 * High-level sync logic with debouncing
 */

import { config } from "../config";
import { isAuthenticated } from "./auth";
import { updateWatchedEpisodes, getWatchStatus } from "./api";

export type MalSyncResult = "updated" | "already_synced" | "skipped" | "failed";

// Track last synced to avoid duplicate updates
const lastSynced: Map<string, { episode: number; timestamp: number }> = new Map();
const lastSuccess: Map<string, number> = new Map(); // Track last successful EP to avoid syncing same EP twice
const syncInProgress: Set<string> = new Set(); // Lock to prevent parallel calls
const SYNC_COOLDOWN = 60 * 1000; // 60 seconds cooldown per anime if EP hasn't changed

type SyncGateDecision = "allow" | "in_progress" | "already_success" | "cooldown";

/**
 * Check if this episode is allowed to sync right now
 */
function getSyncGateDecision(malId: number, episode: number): SyncGateDecision {
    const key = `${malId}:${episode}`;

    // Already syncing this exact episode
    if (syncInProgress.has(key)) {
        return "in_progress";
    }

    const malIdStr = String(malId);

    // If we already successfully synced this episode, never sync it again
    if (lastSuccess.get(malIdStr) === episode) {
        return "already_success";
    }

    const last = lastSynced.get(malIdStr);
    if (!last) return "allow";

    // If it's a new episode, sync immediately bypassing cooldown
    if (last.episode !== episode) {
        return "allow";
    }

    // Same episode, check cooldown
    if (Date.now() - last.timestamp < SYNC_COOLDOWN) {
        return "cooldown";
    }

    return "allow";
}

/**
 * Record that a sync attempt started
 */
function recordSyncAttempt(malId: number, episode: number): void {
    lastSynced.set(String(malId), { episode, timestamp: Date.now() });
}

/**
 * Record that a sync was successful
 */
function recordSyncSuccess(malId: number, episode: number): void {
    lastSuccess.set(String(malId), episode);
}

/**
 * Sync episode to MAL if conditions are met
 * @param malId - MyAnimeList anime ID
 * @param episode - Episode number watched
 * @param percentWatched - Percentage of episode watched (0-100)
 * @param totalEpisodes - Total episodes in the anime (optional)
 */
export async function syncEpisodeDetailed(
    malId: number,
    episode: number,
    percentWatched: number,
    totalEpisodes?: number
): Promise<MalSyncResult> {
    // Check if MAL sync is enabled
    if (!config.mal.enabled) {
        return "skipped";
    }

    // Check authentication
    if (!isAuthenticated()) {
        return "skipped";
    }

    // Check watch threshold
    if (percentWatched < config.mal.syncThreshold) {
        return "skipped";
    }

    // Check cooldown and duplicate sync
    const gateDecision = getSyncGateDecision(malId, episode);
    if (gateDecision !== "allow") {
        return "skipped";
    }

    // Lock this episode to prevent parallel syncs
    const lockKey = `${malId}:${episode}`;
    syncInProgress.add(lockKey);

    try {
        // Record sync attempt timestamp
        recordSyncAttempt(malId, episode);

        // Get current progress to avoid going backwards
        // (Wait status also acts as a check to see if we really need to update)
        const currentProgress = await getWatchStatus(malId);
        if (currentProgress !== null && currentProgress >= episode) {
            // Already synced this or later episode on MAL
            recordSyncSuccess(malId, currentProgress);
            return "already_synced";
        }

        // Update MAL
        const success = await updateWatchedEpisodes(malId, episode, totalEpisodes);

        if (success) {
            recordSyncSuccess(malId, episode);
            return "updated";
        }

        return "failed";
    } catch {
        return "failed";
    } finally {
        // Always unlock
        syncInProgress.delete(lockKey);
    }
}

export async function syncEpisode(
    malId: number,
    episode: number,
    percentWatched: number,
    totalEpisodes?: number
): Promise<boolean> {
    const result = await syncEpisodeDetailed(malId, episode, percentWatched, totalEpisodes);
    return result === "updated" || result === "already_synced";
}

// Re-export auth functions for convenience
export { authorize, isAuthenticated, logout } from "./auth";
export { getUsername } from "./api";
