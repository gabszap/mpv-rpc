import * as fs from "node:fs";
import * as path from "node:path";

export type StremioPlaybackContext = {
    libraryItemId: string;
    imdbId: string | null;
    videoId: string | null;
    name: string | null;
    type: "series" | "movie" | null;
    season: number | null;
    episode: number | null;
    episodesInSeason: number | null;
};

const CONFIG_PATH = path.join(process.cwd(), ".config", ".stremio-mpv-config.json");
const MAX_CONTEXT_AGE_MS = 12 * 60 * 60 * 1000;
const REAL_IMDB_ID_PATTERN = /^tt\d+$/;

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

function readSavedAtMs(value: unknown): number | null {
    const savedAt = readString(value);
    if (!savedAt) {
        return null;
    }

    const savedAtMs = Date.parse(savedAt);
    return Number.isNaN(savedAtMs) ? null : savedAtMs;
}

export function parseStremioPlaybackContext(rawConfig: unknown): StremioPlaybackContext | null {
    if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
        return null;
    }

    const configObject = rawConfig as { stremioMeta?: unknown };
    if (
        typeof configObject.stremioMeta !== "object" ||
        configObject.stremioMeta === null ||
        Array.isArray(configObject.stremioMeta)
    ) {
        return null;
    }

    const meta = configObject.stremioMeta as Record<string, unknown>;
    const libraryItemId = readString(meta.libraryItemId) ?? readString(meta.seriesId);
    if (!libraryItemId) {
        return null;
    }

    return {
        libraryItemId,
        imdbId: readRealImdbId(meta.imdbId),
        videoId: readString(meta.videoId),
        name: readString(meta.name),
        type: readMediaType(meta.type),
        season: readPositiveInteger(meta.season),
        episode: readPositiveInteger(meta.episode),
        episodesInSeason: readPositiveInteger(meta.episodesInSeason),
    };
}

export function readStremioPlaybackContext(nowMs = Date.now()): StremioPlaybackContext | null {
    try {
        const stats = fs.statSync(CONFIG_PATH);
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const parsedConfig = JSON.parse(raw) as unknown;
        const savedAtMs = readSavedAtMs((parsedConfig as { stremioMeta?: { savedAt?: unknown } }).stremioMeta?.savedAt);
        const contextTimeMs = savedAtMs ?? stats.mtimeMs;

        if (nowMs - contextTimeMs > MAX_CONTEXT_AGE_MS) {
            return null;
        }

        return parseStremioPlaybackContext(parsedConfig);
    } catch {
        return null;
    }
}
