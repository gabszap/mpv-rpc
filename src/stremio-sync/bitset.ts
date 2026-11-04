import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";

export type DecodedWatched = {
    anchorVideoId: string;
    anchorLength: number;
    watchedEpisodes: boolean[];
};

export type MarkWatchedResult = {
    watched: string;
    changed: boolean;
};

/**
 * Decode a Stremio `watched` field string into structured data.
 *
 * Format: `{anchorVideoId}:{anchorLength}:{base64_zlib_bitset}`
 *
 * The bitset is a BitField8 — bit array with LSB-first bit ordering within each byte.
 * zlib compression uses flate2 (standard zlib), fallback to raw deflate.
 */
export function decodeWatched(watched: string, videoCount: number): DecodedWatched {
    if (typeof watched !== "string" || watched.length === 0) {
        throw new Error("watched must be a non-empty string");
    }

    // Split into 3 parts: anchorVideoId:anchorLength:base64_zlib_bitset
    // anchorVideoId can contain colons (e.g., "tt2934286:1:24"), so we split from the right
    const lastColon = watched.lastIndexOf(":");
    if (lastColon === -1) {
        throw new Error("watched must contain at least one colon separator");
    }

    const prefix = watched.substring(0, lastColon);
    const base64Part = watched.substring(lastColon + 1);

    // Split prefix into anchorVideoId and anchorLength
    const secondLastColon = prefix.lastIndexOf(":");
    if (secondLastColon === -1) {
        throw new Error("watched must have format {anchorVideoId}:{anchorLength}:{base64}");
    }

    const anchorVideoId = prefix.substring(0, secondLastColon);
    const anchorLength = parseNonNegativeInteger(prefix.substring(secondLastColon + 1), "anchorLength");

    if (anchorVideoId.length === 0) {
        throw new Error("anchorVideoId must not be empty");
    }

    // Decode base64 → zlib → bit array
    const compressed = Buffer.from(base64Part, "base64");
    if (compressed.length === 0) {
        throw new Error("base64 bitset part must not be empty");
    }

    const bytes = inflateBitset(compressed);

    // Convert bytes to boolean array (LSB-first within each byte)
    const watchedEpisodes: boolean[] = [];
    for (let i = 0; i < videoCount; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        if (byteIndex < bytes.length) {
            watchedEpisodes.push(((bytes[byteIndex] >> bitIndex) & 1) !== 0);
        } else {
            watchedEpisodes.push(false);
        }
    }

    return { anchorVideoId, anchorLength, watchedEpisodes };
}

/**
 * Encode a DecodedWatched back into the Stremio `watched` field string.
 */
export function encodeWatched(decoded: DecodedWatched): string {
    const { anchorVideoId, anchorLength, watchedEpisodes } = decoded;

    // Convert boolean array to bytes (LSB-first within each byte)
    const byteCount = Math.ceil(watchedEpisodes.length / 8);
    const bytes = Buffer.alloc(byteCount, 0);
    for (let i = 0; i < watchedEpisodes.length; i++) {
        if (watchedEpisodes[i]) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            bytes[byteIndex] |= 1 << bitIndex;
        }
    }

    // Compress with zlib (flate2 level 6)
    const compressed = deflateSync(bytes, { level: 6 });
    const base64 = compressed.toString("base64");

    return `${anchorVideoId}:${anchorLength}:${base64}`;
}

/**
 * Mark a specific episode as watched in the bitset.
 *
 * @param watched - The current watched field string (null if none exists)
 * @param videoCount - Total number of videos in the series
 * @param videoId - The video ID to mark as watched
 * @param videoIds - Ordered list of all video IDs (season → episode → released)
 * @returns The updated watched string and whether it changed
 */
export function markEpisodeWatched(
    watched: string | null,
    videoCount: number,
    videoId: string,
    videoIds: string[],
): MarkWatchedResult {
    const videoIndex = videoIds.indexOf(videoId);
    if (videoIndex === -1) {
        throw new Error(`Video ID "${videoId}" not found in video list`);
    }

    // No existing watched field — create a fresh one
    if (!watched || watched.length === 0) {
        const watchedEpisodes = new Array(videoCount).fill(false);
        watchedEpisodes[videoIndex] = true;
        return {
            watched: encodeWatched({
                anchorVideoId: videoId,
                anchorLength: videoIndex + 1,
                watchedEpisodes,
            }),
            changed: true,
        };
    }

    const decoded = decodeWatched(watched, videoCount);

    // Already watched — nothing to do
    if (decoded.watchedEpisodes[videoIndex]) {
        return { watched, changed: false };
    }

    decoded.watchedEpisodes[videoIndex] = true;

    // The anchor is the "last watched" episode — the one being marked now
    const newAnchorIndex = videoIndex;

    return {
        watched: encodeWatched({
            anchorVideoId: videoIds[newAnchorIndex],
            anchorLength: newAnchorIndex + 1,
            watchedEpisodes: decoded.watchedEpisodes,
        }),
        changed: true,
    };
}

/**
 * Check if a specific episode is marked as watched.
 */
export function isEpisodeWatched(
    watched: string | null,
    videoCount: number,
    videoId: string,
    videoIds: string[],
): boolean {
    if (!watched || watched.length === 0) {
        return false;
    }

    const videoIndex = videoIds.indexOf(videoId);
    if (videoIndex === -1) {
        return false;
    }

    try {
        const decoded = decodeWatched(watched, videoCount);
        return decoded.watchedEpisodes[videoIndex] ?? false;
    } catch {
        return false;
    }
}

// ── Private helpers ──────────────────────────────────────────────────

function parseNonNegativeInteger(rawValue: string, fieldName: string): number {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid Stremio watched ${fieldName}.`);
    }
    return parsed;
}

function inflateBitset(compressed: Buffer): Buffer {
    try {
        return inflateSync(compressed);
    } catch {
        return inflateRawSync(compressed);
    }
}
