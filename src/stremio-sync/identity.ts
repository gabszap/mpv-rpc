import { type CanonicalEpisodePosition, resolveCanonicalSplitPartEpisode } from "../canonical-episode";
import type { MpvData } from "../mpv";
import type { StremioPlaybackContext } from "./context";

export type EpisodePosition = {
    season: number | null;
    episode: number | null;
};

export type CanonicalStremioIdentity = {
    context: StremioPlaybackContext;
    season: number | null;
    episode: number | null;
    videoId: string | null;
};

export function buildCanonicalVideoId(imdbId: string | null | undefined, position: EpisodePosition): string | null {
    if (!imdbId || position.season === null || position.episode === null) {
        return null;
    }

    return `${imdbId}:${position.season}:${position.episode}`;
}

export function buildVideoIdWhenSafe(context: StremioPlaybackContext): string | null {
    if (context.videoId) {
        return context.videoId;
    }

    if (context.type === "movie" && context.imdbId) {
        return context.imdbId;
    }

    if (context.type === "series" && context.imdbId && context.season && context.episode) {
        return `${context.imdbId}:${context.season}:${context.episode}`;
    }

    return null;
}

function parseEpisodePositionFromFilename(filename: string): EpisodePosition {
    const seasonEpisodeMatch = filename.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,4})/);
    if (seasonEpisodeMatch) {
        return {
            season: Number.parseInt(seasonEpisodeMatch[1], 10),
            episode: Number.parseInt(seasonEpisodeMatch[2], 10),
        };
    }

    return { season: null, episode: null };
}

export function getCurrentEpisodePosition(data: MpvData): EpisodePosition {
    const filenamePosition = parseEpisodePositionFromFilename(data.filename);

    if (filenamePosition.season !== null && filenamePosition.episode !== null) {
        return filenamePosition;
    }

    return {
        season: data.season,
        episode: data.episode,
    };
}

function normalizeTitleForMatch(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function stripEpisodeMarkersFromFilename(filename: string): string {
    return filename
        .replace(/\.[^.\\/]+$/, "")
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/[Ss]\d{1,2}[\s._-]*[Ee]\d{1,4}.*/g, " ")
        .replace(/\b[Ee][Pp]?\s*\d{1,4}.*/g, " ")
        .replace(/\s+-\s+\d{1,4}.*/g, " ");
}

function getSafePlaybackTitleCandidates(data: MpvData): string[] {
    return [data.series_title, data.media_title, stripEpisodeMarkersFromFilename(data.filename)]
        .map(normalizeTitleForMatch)
        .filter((title) => title.length > 0);
}

function doesContextNameExactlyMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    if (!context.name) {
        return false;
    }

    const normalizedContextName = normalizeTitleForMatch(context.name);
    if (!normalizedContextName) {
        return false;
    }

    return getSafePlaybackTitleCandidates(data).some((playbackTitle) => playbackTitle === normalizedContextName);
}

function doesContextIdMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    return Boolean(context.imdbId && data.imdb_id && context.imdbId === data.imdb_id);
}

function doesContextSecurelyMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    if (context.imdbId && data.imdb_id && context.imdbId !== data.imdb_id) {
        return false;
    }

    return doesContextIdMatchPlayback(context, data) || doesContextNameExactlyMatchPlayback(context, data);
}

function isSeriesPositionSafeForContext(context: StremioPlaybackContext, data: MpvData): boolean {
    const currentPosition = getCurrentEpisodePosition(data);

    if (context.season === null || context.episode === null) {
        return false;
    }

    if (currentPosition.season !== null && currentPosition.episode !== null) {
        return currentPosition.season === context.season && currentPosition.episode === context.episode;
    }

    const canonicalSplitPartPosition = resolveCanonicalSplitPartEpisode(data);

    if (canonicalSplitPartPosition) {
        return (
            context.season === canonicalSplitPartPosition.season &&
            context.episode === canonicalSplitPartPosition.episode
        );
    }

    return false;
}

export function isPlaybackContextMatchingData(context: StremioPlaybackContext, data: MpvData): boolean {
    if (!doesContextSecurelyMatchPlayback(context, data)) {
        return false;
    }

    if (context.type === "series" || context.season !== null || context.episode !== null) {
        return isSeriesPositionSafeForContext(context, data);
    }

    return context.type === "movie" || doesContextNameExactlyMatchPlayback(context, data);
}

export function getCanonicalEpisodePosition(
    context: StremioPlaybackContext | null,
    data: MpvData,
): EpisodePosition & { source: "stremio-context" | CanonicalEpisodePosition["source"] | "playback" } {
    const currentPosition = getCurrentEpisodePosition(data);
    if (currentPosition.season !== null && currentPosition.episode !== null) {
        return {
            season: currentPosition.season,
            episode: currentPosition.episode,
            source: "playback",
        };
    }

    const splitPartPosition = resolveCanonicalSplitPartEpisode(data);
    if (splitPartPosition) {
        return {
            season: splitPartPosition.season,
            episode: splitPartPosition.episode,
            source: splitPartPosition.source,
        };
    }

    if (context && isPlaybackContextMatchingData(context, data)) {
        return {
            season: context.season,
            episode: context.episode,
            source: "stremio-context",
        };
    }

    return {
        ...currentPosition,
        source: "playback",
    };
}

export function getCanonicalStremioIdentity(
    context: StremioPlaybackContext | null,
    data: MpvData,
): CanonicalStremioIdentity | null {
    if (!context) {
        return null;
    }

    if (!isPlaybackContextMatchingData(context, data)) {
        return null;
    }

    const canonicalPosition = getCanonicalEpisodePosition(context, data);
    const videoId =
        canonicalPosition.source === "split-part-rule"
            ? buildCanonicalVideoId(context.imdbId, canonicalPosition)
            : buildVideoIdWhenSafe(context);

    return {
        context,
        season: canonicalPosition.season,
        episode: canonicalPosition.episode,
        videoId,
    };
}
