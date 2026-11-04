import { config } from "../core/config";

export function formatStremioSkipReason(reason: string): string {
    if (reason === "missing-auth") {
        return "auth token not found; open something through the Stremio bridge to save .config/.stremio_tokens.json.";
    }

    if (reason === "missing-or-invalid-context") {
        return "playback context not found, stale, or invalid; open the stream through the Stremio bridge again.";
    }

    if (reason === "invalid-playback-progress") {
        return "MPV did not report valid time/duration yet.";
    }

    if (reason === "progress-too-low") {
        return "playback is still near the start; waiting for at least 5 seconds and 1% before writing Continue Watching so a 0% offset is not saved.";
    }

    if (reason === "playback-context-mismatch") {
        return "current MPV title/season/episode does not match saved .config/.stremio-mpv-config.json context.";
    }

    if (reason === "missing-video-id") {
        return "saved context has no safe video_id for Continue Watching.";
    }

    if (reason === "progress-interval") {
        return `waiting for progress interval (${config.stremio.progressIntervalMs}ms)`;
    }

    if (reason === "library-item-not-found") {
        return "Stremio datastore returned no library item for the saved libraryItemId; Continue Watching can only update an existing library item.";
    }

    return reason;
}

export function logStremioSkipDetail(reason: string): void {
    if (!config.debug) {
        return;
    }

    console.debug?.(`[Stremio][debug] Skip detail: ${formatStremioSkipReason(reason)}`);
}
