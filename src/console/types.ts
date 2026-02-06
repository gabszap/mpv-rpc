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
