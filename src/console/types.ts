/**
 * Console REPL Types - Manual title override system
 */

/**
 * Represents the current episode context for override matching
 */
export interface EpisodeContext {
    /** Unique episode identifier (file path or normalized SxxExx) */
    id: string;
    /** Parent series name for logging */
    seriesName: string;
    /** Episode number */
    episodeNumber: number;
    /** Season number (if available) */
    seasonNumber: number | null;
}

/**
 * Represents a manual title override set by the user
 */
export interface ManualOverride {
    /** The custom title to display */
    title: string;
    /** The episode context this override applies to */
    context: EpisodeContext;
    /** When the override was set */
    timestamp: Date;
}

/**
 * Global override state - exported for use across modules
 */
export let manualOverride: ManualOverride | null = null;

/**
 * Set the manual override
 */
export function setManualOverride(override: ManualOverride | null): void {
    manualOverride = override;
}

/**
 * Get the current manual override
 */
export function getManualOverride(): ManualOverride | null {
    return manualOverride;
}

/**
 * Clear the manual override
 */
export function clearManualOverride(): void {
    manualOverride = null;
}

/**
 * Create an episode context from MPV data
 */
export function createEpisodeContext(
    filename: string,
    seriesName: string,
    season: number | null,
    episode: number | null
): EpisodeContext | null {
    if (episode === null) {
        return null;
    }

    // Create a unique ID from season/episode or filename
    let id: string;
    if (season !== null) {
        id = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    } else {
        // Use filename + episode as fallback
        id = `${filename}:E${episode}`;
    }

    return {
        id,
        seriesName,
        episodeNumber: episode,
        seasonNumber: season,
    };
}

/**
 * Represents a manual override for the series name (rename command)
 * Used when the parser fails to extract the correct anime/series title
 */
export interface SeriesNameOverride {
    /** The corrected series name to use for metadata searches */
    overrideName: string;
    /** The original filename this override applies to (cleared on file change) */
    filename: string;
    /** When the override was set */
    timestamp: Date;
}

/**
 * Global series name override state
 */
let seriesNameOverride: SeriesNameOverride | null = null;

/**
 * Set the series name override
 */
export function setSeriesNameOverride(override: SeriesNameOverride | null): void {
    seriesNameOverride = override;
}

/**
 * Get the current series name override
 */
export function getSeriesNameOverride(): SeriesNameOverride | null {
    return seriesNameOverride;
}

/**
 * Clear the series name override
 */
export function clearSeriesNameOverride(): void {
    seriesNameOverride = null;
}

/**
 * Check if the series name override is still valid for the given filename
 * Automatically clears if the file has changed
 */
export function checkSeriesNameOverride(currentFilename: string): SeriesNameOverride | null {
    if (seriesNameOverride && seriesNameOverride.filename !== currentFilename) {
        console.log(`[System] File changed. Series name override auto-cleared.`);
        seriesNameOverride = null;
    }
    return seriesNameOverride;
}

