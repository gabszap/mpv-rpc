/**
 * Auto-fetch module - detects when playback is near the end of a playlist
 * and triggers the Stremio bridge to fetch the next episodes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";
import type { MpvData } from "./mpv";

// Shared config file path (same as bridge uses)
const CONFIG_PATH = path.resolve(__dirname, "..", ".config", ".stremio-mpv-config.json");

// Deduplication state
let lastTriggerKey: string | null = null;
let lastFilename: string | null = null;
let lastTriggerTime = 0;

// Cooldown between trigger attempts (success or failure) to prevent spam
const TRIGGER_COOLDOWN_MS = 30_000;

interface StremioMeta {
    imdbId?: string;
    seriesId?: string;
    name?: string;
    season?: number;
    episode?: number;
    type?: string;
}

interface SharedConfig {
    stremioMeta?: StremioMeta;
    extraEpisodes?: number;
    [key: string]: unknown;
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
    if (!config.autoFetchEnabled) {
        return;
    }

    // Reset deduplication when filename changes
    if (lastFilename !== data.filename) {
        lastTriggerKey = null;
        lastFilename = data.filename;
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

    // Read shared config
    const sharedConfig = readSharedConfig();
    if (!sharedConfig) {
        console.warn("[AutoFetch] Shared config file not found or invalid JSON. Skipping auto-fetch.");
        return;
    }

    const stremioMeta = sharedConfig.stremioMeta;
    if (!stremioMeta?.imdbId || !stremioMeta.name) {
        console.warn("[AutoFetch] No Stremio metadata in shared config. Skipping auto-fetch.");
        return;
    }

    // Parse season/episode from filename (more reliable than config)
    const parsed = parseFilenameEpisode(data.filename);
    const season = parsed.season ?? stremioMeta.season;
    const episode = parsed.episode ?? stremioMeta.episode;

    // Guard: couldn't determine episode number
    if (episode == null) {
        console.warn("[AutoFetch] Could not determine episode number from filename or config. Skipping.");
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
    const extraEpisodes = sharedConfig.extraEpisodes ?? 3;
    const requestBody = {
        imdbId: stremioMeta.imdbId,
        name: stremioMeta.name,
        season,
        episode,
        type: stremioMeta.type || "series",
        extraEpisodes,
    };

    try {
        const res = await fetch("http://localhost:9632/auto-fetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(30000),
        });

        const result = (await res.json()) as { success?: boolean; added?: number; error?: string };
        if (result.success) {
            console.log(`[AutoFetch] Added ${result.added} episode(s) to playlist.`);
            lastTriggerKey = triggerKey;
        } else {
            console.error(`[AutoFetch] Bridge returned error: ${result.error}`);
        }
    } catch (e) {
        console.error("[AutoFetch] Failed to trigger auto-fetch:", e instanceof Error ? e.message : String(e));
    }
}
