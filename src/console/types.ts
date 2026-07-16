/**
 * Console REPL Types - Manual title override system
 */

/**
 * Represents the current episode context for override matching
 */
export interface EpisodeContext {
    /** Unique episode identifier (file path or normalized SxxExx) */
    id: string;
    /**
     * Parsed-source S/E identity, anchored to the filename before canonical
     * remapping. The override auto-clear only fires when this changes,
     * so overrides survive overflow/canonical resolution (e.g. S04E35 → S04E11).
     * Falls back to the filename when no S/E was parsed.
     */
    parsedId: string;
    /** Parent series name for logging */
    seriesName: string;
    /** Episode number */
    episodeNumber: number | null;
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
    /** Reason the override was cleared (populated only at clear time for logging) */
    clearReason?: string;
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
 * Create an episode context from MPV data.
 *
 * @param filename - The current filename (used as parsedId fallback when no S/E)
 * @param seriesName - The series name for display
 * @param season - The resolved/canonical season (may differ from parsed after overflow)
 * @param episode - The resolved/canonical episode (may differ from parsed after overflow)
 * @param parsedSeason - The season extracted from the filename before canonical remapping
 * @param parsedEpisode - The episode extracted from the filename before canonical remapping
 */
export function createEpisodeContext(
    filename: string,
    seriesName: string,
    season: number | null,
    episode: number | null,
    parsedSeason?: number | null,
    parsedEpisode?: number | null,
): EpisodeContext | null {
    const id = buildEpisodeIdentity(filename, season, episode);

    // Build the parsed-source identity: the S/E from the filename before
    // canonical remapping. This is the anchor for override matching.
    const effectiveParsedSeason = parsedSeason ?? season;
    const effectiveParsedEpisode = parsedEpisode ?? episode;

    const parsedId = buildEpisodeIdentity(filename, effectiveParsedSeason, effectiveParsedEpisode);

    return {
        id,
        parsedId,
        seriesName,
        episodeNumber: episode,
        seasonNumber: season,
    };
}

function buildEpisodeIdentity(filename: string, season: number | null | undefined, episode: number | null): string {
    if (episode === null) {
        return filename;
    }

    if (season !== null && season !== undefined) {
        return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    }

    return `${filename}:E${episode}`;
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
