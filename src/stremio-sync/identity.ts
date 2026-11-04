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

export function buildVideoIdWhenSafe(
    context: StremioPlaybackContext,
    position: EpisodePosition = { season: context.season, episode: context.episode },
): string | null {
    if (context.type === "movie" && context.imdbId) {
        return context.imdbId;
    }

    if (context.type === "series" && context.imdbId && position.season !== null && position.episode !== null) {
        return `${context.imdbId}:${position.season}:${position.episode}`;
    }

    if (context.videoId) {
        return context.videoId;
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

function readProviderNumericId(value: string | null | undefined, provider: "mal" | "tvdb" | "kitsu"): number | null {
    if (!value) {
        return null;
    }

    const match = value.match(new RegExp(`(?:^|:)${provider}:(\\d+)(?::|$)`, "i"));
    if (!match) {
        return null;
    }

    const numericId = Number.parseInt(match[1], 10);
    return Number.isInteger(numericId) && numericId > 0 ? numericId : null;
}

function getContextIdCandidates(context: StremioPlaybackContext): string[] {
    return [context.libraryItemId, context.seriesId, context.videoId].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
}

function readContextProviderId(context: StremioPlaybackContext, provider: "mal" | "tvdb" | "kitsu"): number | null {
    for (const candidate of getContextIdCandidates(context)) {
        const providerId = readProviderNumericId(candidate, provider);
        if (providerId) {
            return providerId;
        }
    }

    return null;
}

function readMpvNumericId(data: MpvData, field: "mal_id" | "tvdb_id" | "kitsu_id"): number | null {
    const value = (data as unknown as Record<string, unknown>)[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return null;
    }

    return value;
}

function doesKnownImdbIdConflict(context: StremioPlaybackContext, data: MpvData): boolean {
    return Boolean(context.imdbId && data.imdb_id && context.imdbId !== data.imdb_id);
}

function doKnownProviderIdsConflict(context: StremioPlaybackContext, data: MpvData): boolean {
    const contextMalId = readContextProviderId(context, "mal");
    const dataMalId = readMpvNumericId(data, "mal_id");
    if (contextMalId && dataMalId && contextMalId !== dataMalId) {
        return true;
    }

    const contextTvdbId = readContextProviderId(context, "tvdb");
    const dataTvdbId = readMpvNumericId(data, "tvdb_id");
    if (contextTvdbId && dataTvdbId && contextTvdbId !== dataTvdbId) {
        return true;
    }

    const contextKitsuId = readContextProviderId(context, "kitsu");
    const dataKitsuId = readMpvNumericId(data, "kitsu_id");
    return Boolean(contextKitsuId && dataKitsuId && contextKitsuId !== dataKitsuId);
}

function doesContextCanonicalVideoIdMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    const canonicalSplitPartPosition = resolveCanonicalSplitPartEpisode(data);
    if (!canonicalSplitPartPosition) {
        return false;
    }

    const expectedVideoId = buildCanonicalVideoId(context.imdbId, canonicalSplitPartPosition);
    if (!expectedVideoId || context.videoId !== expectedVideoId) {
        return false;
    }

    return (
        context.season === canonicalSplitPartPosition.season && context.episode === canonicalSplitPartPosition.episode
    );
}

function doesContextSecurelyMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    if (doesKnownImdbIdConflict(context, data)) {
        return false;
    }

    if (doesContextCanonicalVideoIdMatchPlayback(context, data)) {
        return true;
    }

    if (doKnownProviderIdsConflict(context, data)) {
        return false;
    }

    return doesContextSecureIdMatchPlayback(context, data) || doesContextNameExactlyMatchPlayback(context, data);
}

function doesContextSecureIdMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    if (context.imdbId && data.imdb_id && context.imdbId === data.imdb_id) {
        return true;
    }

    const contextMalId = readContextProviderId(context, "mal");
    const dataMalId = readMpvNumericId(data, "mal_id");
    if (contextMalId && dataMalId && contextMalId === dataMalId) {
        return true;
    }

    const contextTvdbId = readContextProviderId(context, "tvdb");
    const dataTvdbId = readMpvNumericId(data, "tvdb_id");
    if (contextTvdbId && dataTvdbId && contextTvdbId === dataTvdbId) {
        return true;
    }

    const contextKitsuId = readContextProviderId(context, "kitsu");
    const dataKitsuId = readMpvNumericId(data, "kitsu_id");
    return Boolean(contextKitsuId && dataKitsuId && contextKitsuId === dataKitsuId);
}

function isContextFreshEnoughForTitleOnlyMatch(context: StremioPlaybackContext): boolean {
    return context.isFresh !== false;
}

function doesContextIdentityMatchPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    if (isContextFreshEnoughForTitleOnlyMatch(context)) {
        return doesContextSecurelyMatchPlayback(context, data);
    }

    if (doesKnownImdbIdConflict(context, data)) {
        return false;
    }

    if (doesContextCanonicalVideoIdMatchPlayback(context, data)) {
        return true;
    }

    if (doKnownProviderIdsConflict(context, data)) {
        return false;
    }

    return doesContextSecureIdMatchPlayback(context, data);
}

function isContextEpisodeEqualToLocalPlaybackEpisode(context: StremioPlaybackContext, data: MpvData): boolean {
    const currentPosition = getCurrentEpisodePosition(data);

    return (
        currentPosition.season === null &&
        currentPosition.episode !== null &&
        currentPosition.episode === context.episode
    );
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

    if (isContextEpisodeEqualToLocalPlaybackEpisode(context, data)) {
        return doesContextSecureIdMatchPlayback(context, data) || doesContextNameExactlyMatchPlayback(context, data);
    }

    return false;
}

export function isPlaybackContextMatchingData(context: StremioPlaybackContext, data: MpvData): boolean {
    if (!doesContextIdentityMatchPlayback(context, data)) {
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
            : buildVideoIdWhenSafe(context, canonicalPosition);

    return {
        context,
        season: canonicalPosition.season,
        episode: canonicalPosition.episode,
        videoId,
    };
}
