// Userscript adapter over the stream selection logic shared with the bridge
// server (stremio-mpv-bridge/shared/stream-selection.js). Parsing, release
// group / season detection, quality aliases and scoring live there, so the
// server and the userscript can never drift apart.

import { extractReleaseGroup, findBestStream as findBestStreamShared } from "../../shared/stream-selection.js";
import { log } from "./logging.js";
import { settings } from "./settings.js";

export { extractReleaseGroup };

/**
 * Pick the best stream using the user's saved preferences.
 * Signature kept for existing callers; the scoring is the shared implementation.
 */
export function findBestStream(
    streams,
    targetSeason = null,
    targetEpisode = null,
    fallbackGroup = null,
    seriesName = null,
) {
    return findBestStreamShared(
        streams,
        {
            preferredGroup: settings.preferredGroup,
            preferredQuality: settings.preferredQuality,
            inferredGroup: fallbackGroup,
            seriesName,
            log,
        },
        targetSeason,
        targetEpisode,
    );
}
