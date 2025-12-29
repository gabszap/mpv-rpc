/**
 * MAL API Client
 * Handles MyAnimeList API calls for syncing watch progress
 */

import axios from "axios";
import { getAccessToken } from "./auth";

const MAL_API = "https://api.myanimelist.net/v2";

interface UpdateListResponse {
    status: string;
    num_watched_episodes: number;
}

/**
 * Update anime watch progress on MAL
 */
export async function updateWatchedEpisodes(
    malId: number,
    episodesWatched: number,
    totalEpisodes?: number
): Promise<boolean> {
    const token = await getAccessToken();
    if (!token) {
        console.log("[MAL] Not authenticated - skipping sync");
        return false;
    }

    try {
        const status = (totalEpisodes && episodesWatched >= totalEpisodes) ? "completed" : "watching";

        // Use URLSearchParams for x-www-form-urlencoded
        const params = new URLSearchParams();
        params.append("num_watched_episodes", String(episodesWatched));
        params.append("status", status);

        const response = await axios.patch<UpdateListResponse>(
            `${MAL_API}/anime/${malId}/my_list_status`,
            params.toString(), // Explicitly stringify
            {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            }
        );

        if (response.status === 200) {
            const epDisplay = totalEpisodes ? `${episodesWatched}/${totalEpisodes}` : String(episodesWatched);
            console.log(`[MAL] Synced: Episode ${epDisplay} (${status})`);
            return true;
        }

        return false;
    } catch (e: any) {
        if (e.response?.status === 401) {
            console.error("[MAL] Authentication expired - please re-authorize");
        } else {
            console.error("[MAL] API Error:", e.response?.data || e.message);
        }
        return false;
    }
}

/**
 * Get current watch status for an anime
 */
export async function getWatchStatus(malId: number): Promise<number | null> {
    const token = await getAccessToken();
    if (!token) return null;

    try {
        const response = await axios.get(
            `${MAL_API}/anime/${malId}`,
            {
                params: { fields: "my_list_status" },
                headers: { "Authorization": `Bearer ${token}` },
            }
        );

        return response.data.my_list_status?.num_watched_episodes ?? 0;
    } catch (e: any) {
        // 404 means not in list yet
        if (e.response?.status === 404) return 0;
        return null;
    }
}

/**
 * Get current authenticated user's info
 */
export async function getUsername(): Promise<string | null> {
    const token = await getAccessToken();
    if (!token) return null;

    try {
        const response = await axios.get(
            `${MAL_API}/users/@me`,
            {
                headers: { "Authorization": `Bearer ${token}` },
            }
        );

        return response.data.name || null;
    } catch {
        return null;
    }
}
