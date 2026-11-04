import axios from "axios";
import { appendSyncLog } from "./sync";

const CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";

const videoIdCache = new Map<string, { videoIds: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type VideoInfo = {
    id: string;
    title: string | null;
    season: number;
    episode: number;
};

/**
 * Fetch video IDs for a series from the Cinemeta addon.
 * Returns an ordered array of video IDs (season → episode order).
 * Returns null if the fetch fails or no videos are found.
 */
export async function fetchVideoIds(imdbId: string): Promise<string[] | null> {
    if (!imdbId?.startsWith("tt")) {
        return null;
    }

    // Check cache
    const cached = videoIdCache.get(imdbId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.videoIds;
    }

    try {
        const url = `${CINEMETA_BASE_URL}/meta/series/${imdbId}.json`;
        const response = await axios.get(url, {
            timeout: 10000,
            validateStatus: () => true,
        });

        if (response.status !== 200 || !response.data?.meta?.videos) {
            appendSyncLog({
                step: "meta-fetch",
                result: "failed",
                reason: `HTTP ${response.status}`,
                imdbId,
                timestamp: new Date().toISOString(),
            });
            return null;
        }

        const videos: VideoInfo[] = response.data.meta.videos
            .filter((v: { id?: string }) => typeof v.id === "string" && v.id.length > 0)
            .map((v: { id: string; title?: string; season?: number; episode?: number }) => ({
                id: v.id,
                title: v.title ?? null,
                season: v.season ?? 0,
                episode: v.episode ?? 0,
            }));

        const videoIds = videos.map((v) => v.id);

        appendSyncLog({
            step: "meta-fetch",
            result: "success",
            imdbId,
            videoCount: videoIds.length,
            timestamp: new Date().toISOString(),
        });

        if (videoIds.length > 0) {
            videoIdCache.set(imdbId, { videoIds, fetchedAt: Date.now() });
        }

        return videoIds.length > 0 ? videoIds : null;
    } catch (error) {
        appendSyncLog({
            step: "meta-fetch",
            result: "error",
            reason: error instanceof Error ? error.message : "unknown",
            imdbId,
            timestamp: new Date().toISOString(),
        });
        return null;
    }
}
