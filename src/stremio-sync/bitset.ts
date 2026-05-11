import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";

export type DecodedWatched = {
    imdbId: string;
    season: number;
    totalEpsInSeason: number;
    lastGlobalEp: number;
    watchedEpisodes: boolean[];
};

export type MarkWatchedResult = {
    watched: string;
    changed: boolean;
};

const WATCHED_PATTERN = /^(tt\d+):(\d+):(\d+):(\d+):([A-Za-z0-9+/]+={0,2})$/;

function parseNonNegativeInteger(rawValue: string, fieldName: string): number {
    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
        throw new Error(`Invalid Stremio watched ${fieldName}.`);
    }

    return parsedValue;
}

function parsePositiveInteger(rawValue: string, fieldName: string): number {
    const parsedValue = parseNonNegativeInteger(rawValue, fieldName);
    if (parsedValue < 1) {
        throw new Error(`Invalid Stremio watched ${fieldName}.`);
    }

    return parsedValue;
}

function inflateWatchedBuffer(base64Bitset: string): Buffer {
    const compressedBuffer = Buffer.from(base64Bitset, "base64");

    try {
        return inflateSync(compressedBuffer);
    } catch {
        return inflateRawSync(compressedBuffer);
    }
}

function readEpisodeBit(buffer: Buffer, episodeNumber: number): boolean {
    const bitIndex = episodeNumber - 1;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = bitIndex % 8;
    return (buffer[byteIndex] & (1 << bitOffset)) !== 0;
}

function writeEpisodeBit(buffer: Buffer, episodeNumber: number): void {
    const bitIndex = episodeNumber - 1;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = bitIndex % 8;
    buffer[byteIndex] |= 1 << bitOffset;
}

export function decodeWatched(watched: string): DecodedWatched {
    const match = watched.match(WATCHED_PATTERN);
    if (!match) {
        throw new Error("Invalid Stremio watched format.");
    }

    const [, imdbId, rawSeason, rawTotalEpsInSeason, rawLastGlobalEp, base64Bitset] = match;
    const season = parsePositiveInteger(rawSeason, "season");
    const totalEpsInSeason = parsePositiveInteger(rawTotalEpsInSeason, "total episode count");
    const lastGlobalEp = parseNonNegativeInteger(rawLastGlobalEp, "last global episode");
    const buffer = inflateWatchedBuffer(base64Bitset);
    const requiredBytes = Math.ceil(totalEpsInSeason / 8);

    if (buffer.length < requiredBytes) {
        throw new Error("Invalid Stremio watched bitset length.");
    }

    return {
        imdbId,
        season,
        totalEpsInSeason,
        lastGlobalEp,
        watchedEpisodes: Array.from({ length: totalEpsInSeason }, (_, index) => readEpisodeBit(buffer, index + 1)),
    };
}

export function encodeWatched(decodedWatched: DecodedWatched): string {
    if (decodedWatched.totalEpsInSeason !== decodedWatched.watchedEpisodes.length) {
        throw new Error("Decoded watched episode count does not match bitset length.");
    }

    const buffer = Buffer.alloc(Math.ceil(decodedWatched.totalEpsInSeason / 8));
    decodedWatched.watchedEpisodes.forEach((isWatched, index) => {
        if (isWatched) {
            writeEpisodeBit(buffer, index + 1);
        }
    });

    const base64Bitset = deflateSync(buffer).toString("base64");
    return `${decodedWatched.imdbId}:${decodedWatched.season}:${decodedWatched.totalEpsInSeason}:${decodedWatched.lastGlobalEp}:${base64Bitset}`;
}

export function markEpisodeWatched(watched: string, episode: number): MarkWatchedResult {
    if (!Number.isInteger(episode) || episode < 1) {
        throw new Error("Episode must be a positive integer.");
    }

    const decodedWatched = decodeWatched(watched);
    if (episode > decodedWatched.totalEpsInSeason) {
        throw new Error("Episode is outside the Stremio watched bitset range.");
    }

    if (decodedWatched.watchedEpisodes[episode - 1]) {
        return { watched, changed: false };
    }

    return {
        watched: encodeWatched({
            ...decodedWatched,
            watchedEpisodes: decodedWatched.watchedEpisodes.map(
                (isWatched, index) => index === episode - 1 || isWatched,
            ),
        }),
        changed: true,
    };
}
