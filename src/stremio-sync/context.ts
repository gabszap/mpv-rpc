import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MpvData } from "../integrations/mpv";
import { getCurrentEpisodePosition, isPlaybackContextMatchingData } from "./identity";

export type StremioPlaybackContext = {
    libraryItemId: string;
    seriesId?: string | null;
    imdbId: string | null;
    videoId: string | null;
    name: string | null;
    type: "series" | "movie" | null;
    season: number | null;
    episode: number | null;
    episodesInSeason: number | null;
    isFresh?: boolean;
    savedAtMs?: number | null;
};

type AutoFetchedPlaybackContextEntry = Record<string, unknown> & {
    matchKey?: string;
    titleKey?: string;
    savedAt?: string;
};

const CONFIG_PATH = path.join(process.cwd(), ".config", ".stremio-mpv-config.json");
const MAX_CONTEXT_AGE_MS = 12 * 60 * 60 * 1000;
// Per-appended-item playback contexts expire sooner than the primary Stremio metadata.
const AUTO_FETCH_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
const AUTO_FETCH_CONTEXT_MAX_ENTRIES = 100;
const REAL_IMDB_ID_PATTERN = /^tt\d+$/;

type ReadContextOptions = {
    data: MpvData | null;
    nowMs: number;
};

function readString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const normalizedValue = value.trim();
    return normalizedValue.length > 0 ? normalizedValue : null;
}

function readPositiveInteger(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return null;
    }

    return value;
}

function readMediaType(value: unknown): "series" | "movie" | null {
    if (value === "series" || value === "movie") {
        return value;
    }

    return null;
}

function readRealImdbId(value: unknown): string | null {
    const candidate = readString(value);
    if (!candidate || !REAL_IMDB_ID_PATTERN.test(candidate)) {
        return null;
    }

    return candidate;
}

type CanonicalSeriesVideoId = {
    imdbId: string;
    season: number;
    episode: number;
};

function parseCanonicalSeriesVideoId(value: string | null): CanonicalSeriesVideoId | null {
    if (!value) {
        return null;
    }

    const match = value.match(/^(tt\d+):(\d+):(\d+)$/);
    if (!match) {
        return null;
    }

    const season = Number.parseInt(match[2], 10);
    const episode = Number.parseInt(match[3], 10);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
        return null;
    }

    return { imdbId: match[1], season, episode };
}

function getTrustedContextVideoId(
    rawVideoId: string | null,
    type: "series" | "movie" | null,
    imdbId: string | null,
    season: number | null,
    episode: number | null,
): string | null {
    if (type !== "series" || !imdbId || season === null || episode === null) {
        return rawVideoId;
    }

    const canonicalVideoId = `${imdbId}:${season}:${episode}`;
    const parsedVideoId = parseCanonicalSeriesVideoId(rawVideoId);
    if (!parsedVideoId) {
        return rawVideoId?.startsWith("tt") ? canonicalVideoId : rawVideoId;
    }

    if (parsedVideoId.imdbId !== imdbId) {
        return null;
    }

    return canonicalVideoId;
}

function readSavedAtMs(value: unknown): number | null {
    const savedAt = readString(value);
    if (!savedAt) {
        return null;
    }

    const savedAtMs = Date.parse(savedAt);
    return Number.isNaN(savedAtMs) ? null : savedAtMs;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextTimeFresh(contextTimeMs: number, nowMs: number): boolean {
    return nowMs - contextTimeMs <= MAX_CONTEXT_AGE_MS;
}

function isAutoFetchedContextFresh(savedAtMs: number | null, nowMs: number): boolean {
    return savedAtMs !== null && nowMs - savedAtMs <= AUTO_FETCH_CONTEXT_TTL_MS;
}

function attachContextFreshness(
    context: StremioPlaybackContext,
    freshness: { isFresh: boolean; savedAtMs: number | null },
): StremioPlaybackContext {
    Object.defineProperties(context, {
        isFresh: {
            configurable: true,
            enumerable: false,
            value: freshness.isFresh,
        },
        savedAtMs: {
            configurable: true,
            enumerable: false,
            value: freshness.savedAtMs,
        },
    });

    return context;
}

function parseStremioPlaybackContextMeta(meta: Record<string, unknown>): StremioPlaybackContext | null {
    const libraryItemId = readString(meta.libraryItemId) ?? readString(meta.seriesId);
    if (!libraryItemId) {
        return null;
    }

    const seriesId = readString(meta.seriesId);
    const imdbId = readRealImdbId(meta.imdbId);
    const type = readMediaType(meta.type);
    const season = readPositiveInteger(meta.season);
    const episode = readPositiveInteger(meta.episode);

    return {
        libraryItemId,
        ...(seriesId ? { seriesId } : {}),
        imdbId,
        videoId: getTrustedContextVideoId(readString(meta.videoId), type, imdbId, season, episode),
        name: readString(meta.name),
        type,
        season,
        episode,
        episodesInSeason: readPositiveInteger(meta.episodesInSeason),
    };
}

export function parseStremioPlaybackContext(rawConfig: unknown): StremioPlaybackContext | null {
    if (!isPlainObject(rawConfig)) {
        return null;
    }

    const configObject = rawConfig as { stremioMeta?: unknown };
    if (!isPlainObject(configObject.stremioMeta)) {
        return null;
    }

    return parseStremioPlaybackContextMeta(configObject.stremioMeta);
}

function normalizeAutoFetchedPlaybackIdentifier(value: unknown): string | null {
    return readString(value);
}

function hashAutoFetchedPlaybackIdentifier(value: unknown): string | null {
    const identifier = normalizeAutoFetchedPlaybackIdentifier(value);
    if (!identifier) {
        return null;
    }

    return crypto.createHash("sha256").update(identifier).digest("hex");
}

function normalizeAutoFetchedTitleKey(value: unknown): string | null {
    const title = readString(value);
    if (!title) {
        return null;
    }

    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function buildUrlMatchKeys(value: unknown): string[] {
    const keys = new Set<string>();
    const rawHash = hashAutoFetchedPlaybackIdentifier(value);
    if (rawHash) {
        keys.add(`url:${rawHash}`);
    }

    const rawValue = readString(value);
    if (!rawValue) {
        return [...keys];
    }

    try {
        const decodedHash = hashAutoFetchedPlaybackIdentifier(decodeURIComponent(rawValue));
        if (decodedHash) {
            keys.add(`url:${decodedHash}`);
        }
    } catch {
        // Invalid percent-encoding only means there is no decoded alias.
    }

    return [...keys];
}

function buildTitleMatchKey(titleKey: string): string {
    return `title:${crypto.createHash("sha256").update(titleKey).digest("hex")}`;
}

function getCurrentPath(data: MpvData): string | null {
    return readString((data as unknown as { path?: unknown }).path);
}

function getPlaybackUrlMatchKeys(data: MpvData): string[] {
    return [getCurrentPath(data), data.filename].flatMap(buildUrlMatchKeys);
}

function readUrlPathnameTitle(value: string | null): string | null {
    if (!value) {
        return null;
    }

    try {
        const parsedUrl = new URL(value);
        const pathname = decodeURIComponent(parsedUrl.pathname);
        return path.basename(pathname);
    } catch {
        return null;
    }
}

function getPlaybackTitleKeys(data: MpvData): Set<string> {
    const currentPath = getCurrentPath(data);
    const candidates = [data.media_title, data.filename, readUrlPathnameTitle(currentPath)]
        .map(normalizeAutoFetchedTitleKey)
        .filter((value): value is string => value !== null);

    return new Set(candidates);
}

function getContextIdCandidates(context: StremioPlaybackContext): string[] {
    return [context.libraryItemId, context.seriesId, context.videoId].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
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

function readMpvNumericId(data: MpvData, field: "mal_id" | "tvdb_id" | "kitsu_id"): number | null {
    const value = (data as unknown as Record<string, unknown>)[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return null;
    }

    return value;
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

function hasSecureSeriesIdMatch(context: StremioPlaybackContext, data: MpvData): boolean {
    if (context.imdbId && data.imdb_id) {
        return context.imdbId === data.imdb_id;
    }

    const contextMalId = readContextProviderId(context, "mal");
    const dataMalId = readMpvNumericId(data, "mal_id");
    if (contextMalId && dataMalId) {
        return contextMalId === dataMalId;
    }

    const contextTvdbId = readContextProviderId(context, "tvdb");
    const dataTvdbId = readMpvNumericId(data, "tvdb_id");
    if (contextTvdbId && dataTvdbId) {
        return contextTvdbId === dataTvdbId;
    }

    const contextKitsuId = readContextProviderId(context, "kitsu");
    const dataKitsuId = readMpvNumericId(data, "kitsu_id");
    return Boolean(contextKitsuId && dataKitsuId && contextKitsuId === dataKitsuId);
}

function isTitleFallbackSafeForPlayback(context: StremioPlaybackContext, data: MpvData): boolean {
    const currentPosition = getCurrentEpisodePosition(data);
    if (currentPosition.season === null || currentPosition.episode === null) {
        return false;
    }

    if (context.season !== currentPosition.season || context.episode !== currentPosition.episode) {
        return false;
    }

    return hasSecureSeriesIdMatch(context, data);
}

function parseAutoFetchedPlaybackContextEntry(
    entry: unknown,
    nowMs: number,
): { context: StremioPlaybackContext; savedAtMs: number; entry: AutoFetchedPlaybackContextEntry } | null {
    if (!isPlainObject(entry)) {
        return null;
    }

    const savedAtMs = readSavedAtMs(entry.savedAt);
    if (!isAutoFetchedContextFresh(savedAtMs, nowMs)) {
        return null;
    }

    const context = parseStremioPlaybackContextMeta(entry);
    if (!context || savedAtMs === null) {
        return null;
    }

    return {
        context: attachContextFreshness(context, { isFresh: true, savedAtMs }),
        savedAtMs,
        entry,
    };
}

function readAutoFetchedPlaybackContextMap(rawConfig: Record<string, unknown>): Record<string, unknown> {
    if (!isPlainObject(rawConfig.autoFetchedPlaybackContexts)) {
        return {};
    }

    return rawConfig.autoFetchedPlaybackContexts;
}

function findAutoFetchedPlaybackContext(
    rawConfig: Record<string, unknown>,
    data: MpvData,
    nowMs: number,
): { context: StremioPlaybackContext; entry: AutoFetchedPlaybackContextEntry } | null {
    const contextMap = readAutoFetchedPlaybackContextMap(rawConfig);

    for (const matchKey of getPlaybackUrlMatchKeys(data)) {
        const parsedEntry = parseAutoFetchedPlaybackContextEntry(contextMap[matchKey], nowMs);
        if (parsedEntry) {
            return { context: parsedEntry.context, entry: parsedEntry.entry };
        }
    }

    const playbackTitleKeys = getPlaybackTitleKeys(data);
    if (playbackTitleKeys.size === 0) {
        return null;
    }

    for (const titleKey of playbackTitleKeys) {
        const matchKey = buildTitleMatchKey(titleKey);
        const parsedEntry = parseAutoFetchedPlaybackContextEntry(contextMap[matchKey], nowMs);
        if (
            parsedEntry &&
            parsedEntry.entry.titleKey === titleKey &&
            isTitleFallbackSafeForPlayback(parsedEntry.context, data)
        ) {
            return { context: parsedEntry.context, entry: parsedEntry.entry };
        }
    }

    return null;
}

function serializePromotedStremioMeta(context: StremioPlaybackContext): Record<string, unknown> {
    return {
        libraryItemId: context.libraryItemId,
        ...(context.seriesId ? { seriesId: context.seriesId } : {}),
        imdbId: context.imdbId,
        videoId: context.videoId,
        name: context.name,
        type: context.type,
        season: context.season,
        episode: context.episode,
        episodesInSeason: context.episodesInSeason,
        savedAt: new Date().toISOString(),
    };
}

function pruneAutoFetchedPlaybackContextMap(
    rawContexts: Record<string, unknown>,
    nowMs: number,
): Record<string, unknown> {
    const freshEntries = Object.entries(rawContexts)
        .filter(([, entry]) => parseAutoFetchedPlaybackContextEntry(entry, nowMs) !== null)
        .sort(([, left], [, right]) => {
            const leftSavedAtMs = readSavedAtMs((left as { savedAt?: unknown }).savedAt) ?? 0;
            const rightSavedAtMs = readSavedAtMs((right as { savedAt?: unknown }).savedAt) ?? 0;
            return rightSavedAtMs - leftSavedAtMs;
        })
        .slice(0, AUTO_FETCH_CONTEXT_MAX_ENTRIES);

    return Object.fromEntries(freshEntries);
}

function promoteAutoFetchedPlaybackContext(
    rawConfig: Record<string, unknown>,
    context: StremioPlaybackContext,
    nowMs: number,
): void {
    const nextConfig = {
        ...rawConfig,
        stremioMeta: serializePromotedStremioMeta(context),
        autoFetchedPlaybackContexts: pruneAutoFetchedPlaybackContextMap(
            readAutoFetchedPlaybackContextMap(rawConfig),
            nowMs,
        ),
    };
    const tmpPath = `${CONFIG_PATH}.tmp.${crypto.randomBytes(8).toString("hex")}`;
    fs.writeFileSync(tmpPath, JSON.stringify(nextConfig, null, 4), "utf-8");
    fs.renameSync(tmpPath, CONFIG_PATH);
}

function resolveReadContextOptions(dataOrNowMs: MpvData | number, nowMs: number): ReadContextOptions {
    if (typeof dataOrNowMs === "number") {
        return { data: null, nowMs: dataOrNowMs };
    }

    return { data: dataOrNowMs, nowMs };
}

export function readStremioPlaybackContext(
    dataOrNowMs: MpvData | number = Date.now(),
    nowMs = Date.now(),
): StremioPlaybackContext | null {
    const options = resolveReadContextOptions(dataOrNowMs, nowMs);

    try {
        const stats = fs.statSync(CONFIG_PATH);
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const parsedConfig = JSON.parse(raw) as unknown;
        if (!isPlainObject(parsedConfig)) {
            return null;
        }

        const savedAtMs = readSavedAtMs((parsedConfig as { stremioMeta?: { savedAt?: unknown } }).stremioMeta?.savedAt);
        const contextTimeMs = savedAtMs ?? stats.mtimeMs;
        const context = parseStremioPlaybackContext(parsedConfig);
        const currentContext = context
            ? attachContextFreshness(context, {
                  isFresh: isContextTimeFresh(contextTimeMs, options.nowMs),
                  savedAtMs,
              })
            : null;

        if (!options.data) {
            return currentContext;
        }

        if (currentContext && isPlaybackContextMatchingData(currentContext, options.data)) {
            return currentContext;
        }

        const autoFetchedContext = findAutoFetchedPlaybackContext(parsedConfig, options.data, options.nowMs);
        if (!autoFetchedContext) {
            return currentContext;
        }

        try {
            promoteAutoFetchedPlaybackContext(parsedConfig, autoFetchedContext.context, options.nowMs);
        } catch {
            // The matched context is still safe for this process; retry persistence on a later tick.
        }

        return attachContextFreshness(autoFetchedContext.context, {
            isFresh: true,
            savedAtMs: options.nowMs,
        });
    } catch {
        return null;
    }
}
