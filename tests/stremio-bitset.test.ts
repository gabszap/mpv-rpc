import { deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeWatched, encodeWatched, isEpisodeWatched, markEpisodeWatched } from "../src/stremio-sync/bitset";

// Helper to create a bitset buffer with `watchedCount` bits set out of `totalBits`.
function createTestBitset(watchedCount: number, totalBits: number): Buffer {
    const byteCount = Math.ceil(totalBits / 8);
    const bytes = Buffer.alloc(byteCount, 0);
    for (let i = 0; i < watchedCount; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        bytes[byteIndex] |= 1 << bitIndex;
    }
    return bytes;
}

// Build a valid 3-field watched string for 30 episodes, first 24 watched.
function buildTestWatchedString(): { watched: string; videoIds: string[] } {
    const videoCount = 30;
    const watchedCount = 24;
    const videoIds = Array.from({ length: videoCount }, (_, i) => `tt2934286:1:${i + 1}`);
    const bitset = createTestBitset(watchedCount, videoCount);
    const compressed = deflateSync(bitset, { level: 6 });
    const base64 = compressed.toString("base64");
    const anchorVideoId = videoIds[watchedCount - 1]; // episode 24, index 23
    const anchorLength = watchedCount; // 24
    return {
        watched: `${anchorVideoId}:${anchorLength}:${base64}`,
        videoIds,
    };
}

describe("Stremio watched bitset helpers", () => {
    describe("decodeWatched", () => {
        it("decodes a valid 3-field watched string", () => {
            const { watched, videoIds } = buildTestWatchedString();
            const decoded = decodeWatched(watched, 30);

            expect(decoded.anchorVideoId).toBe(videoIds[23]);
            expect(decoded.anchorLength).toBe(24);
            expect(decoded.watchedEpisodes).toHaveLength(30);
            // First 24 episodes watched
            for (let i = 0; i < 24; i++) {
                expect(decoded.watchedEpisodes[i]).toBe(true);
            }
            // Episodes 25-30 not watched
            for (let i = 24; i < 30; i++) {
                expect(decoded.watchedEpisodes[i]).toBe(false);
            }
        });

        it("throws on empty string", () => {
            expect(() => decodeWatched("", 10)).toThrow("non-empty string");
        });

        it("throws on missing colons", () => {
            expect(() => decodeWatched("nocolons", 10)).toThrow("at least one colon");
        });

        it("throws on only one colon (needs at least two)", () => {
            expect(() => decodeWatched("tt1234:5", 10)).toThrow("format");
        });

        it("throws on empty anchorVideoId", () => {
            const bitset = deflateSync(Buffer.alloc(1)).toString("base64");
            expect(() => decodeWatched(`:5:${bitset}`, 10)).toThrow("anchorVideoId must not be empty");
        });

        it("throws on negative anchorLength", () => {
            const bitset = deflateSync(Buffer.alloc(1)).toString("base64");
            expect(() => decodeWatched(`tt1234:-1:${bitset}`, 10)).toThrow("anchorLength");
        });

        it("handles anchorVideoId containing colons", () => {
            const bitset = createTestBitset(2, 2);
            const compressed = deflateSync(bitset).toString("base64");
            const watched = `tt2934286:1:2:2:${compressed}`;

            const decoded = decodeWatched(watched, 2);
            expect(decoded.anchorVideoId).toBe("tt2934286:1:2");
            expect(decoded.anchorLength).toBe(2);
            expect(decoded.watchedEpisodes).toEqual([true, true]);
        });
    });

    describe("encodeWatched", () => {
        it("encodes a DecodedWatched into a 3-field string", () => {
            const videoIds = Array.from({ length: 5 }, (_, i) => `tt111:1:${i + 1}`);
            const encoded = encodeWatched({
                anchorVideoId: videoIds[2],
                anchorLength: 3,
                watchedEpisodes: [true, true, true, false, false],
            });

            const parts = encoded.split(":");
            // anchorVideoId is "tt111:1:3" (contains 2 colons), so last 2 parts are length + base64
            expect(parts.length).toBeGreaterThanOrEqual(3);
            // Re-decode to verify
            const decoded = decodeWatched(encoded, 5);
            expect(decoded.anchorVideoId).toBe("tt111:1:3");
            expect(decoded.anchorLength).toBe(3);
            expect(decoded.watchedEpisodes).toEqual([true, true, true, false, false]);
        });
    });

    describe("decode/encode roundtrip", () => {
        it("roundtrips without changing watched bits", () => {
            const { watched } = buildTestWatchedString();
            const decoded = decodeWatched(watched, 30);
            const reencoded = encodeWatched(decoded);

            expect(decodeWatched(reencoded, 30)).toEqual(decoded);
        });

        it("roundtrips with all episodes watched", () => {
            const videoIds = Array.from({ length: 12 }, (_, i) => `tt999:1:${i + 1}`);
            const original = encodeWatched({
                anchorVideoId: videoIds[11],
                anchorLength: 12,
                watchedEpisodes: new Array(12).fill(true),
            });

            const decoded = decodeWatched(original, 12);
            expect(decoded.watchedEpisodes.every(Boolean)).toBe(true);
            expect(encodeWatched(decoded)).toBe(original);
        });

        it("roundtrips with no episodes watched", () => {
            const encoded = encodeWatched({
                anchorVideoId: "tt000:1:1",
                anchorLength: 0,
                watchedEpisodes: [false, false, false],
            });

            const decoded = decodeWatched(encoded, 3);
            expect(decoded.watchedEpisodes).toEqual([false, false, false]);
            expect(decoded.anchorLength).toBe(0);
        });
    });

    describe("markEpisodeWatched", () => {
        it("creates a new watched field when none exists", () => {
            const videoIds = ["tt100:1:1", "tt100:1:2", "tt100:1:3"];
            const result = markEpisodeWatched(null, 3, "tt100:1:2", videoIds);

            expect(result.changed).toBe(true);
            const decoded = decodeWatched(result.watched, 3);
            expect(decoded.watchedEpisodes).toEqual([false, true, false]);
            expect(decoded.anchorVideoId).toBe("tt100:1:2");
            expect(decoded.anchorLength).toBe(2);
        });

        it("marks an unmarked episode and reports change", () => {
            const videoIds = Array.from({ length: 5 }, (_, i) => `tt200:1:${i + 1}`);
            const watched = encodeWatched({
                anchorVideoId: videoIds[0],
                anchorLength: 1,
                watchedEpisodes: [true, false, false, false, false],
            });

            const result = markEpisodeWatched(watched, 5, "tt200:1:3", videoIds);

            expect(result.changed).toBe(true);
            const decoded = decodeWatched(result.watched, 5);
            expect(decoded.watchedEpisodes).toEqual([true, false, true, false, false]);
            // Anchor moves to the episode being marked (last watched)
            expect(decoded.anchorVideoId).toBe(videoIds[2]);
            expect(decoded.anchorLength).toBe(3);
        });

        it("updates anchor when marking a higher-index episode", () => {
            const videoIds = Array.from({ length: 5 }, (_, i) => `tt300:1:${i + 1}`);
            const watched = encodeWatched({
                anchorVideoId: videoIds[0],
                anchorLength: 1,
                watchedEpisodes: [true, false, false, false, false],
            });

            const result = markEpisodeWatched(watched, 5, "tt300:1:5", videoIds);

            expect(result.changed).toBe(true);
            const decoded = decodeWatched(result.watched, 5);
            expect(decoded.watchedEpisodes).toEqual([true, false, false, false, true]);
            expect(decoded.anchorVideoId).toBe(videoIds[4]);
            expect(decoded.anchorLength).toBe(5);
        });

        it("does not modify already watched episodes", () => {
            const videoIds = Array.from({ length: 3 }, (_, i) => `tt400:1:${i + 1}`);
            const watched = encodeWatched({
                anchorVideoId: videoIds[1],
                anchorLength: 2,
                watchedEpisodes: [false, true, false],
            });

            const result = markEpisodeWatched(watched, 3, "tt400:1:2", videoIds);

            expect(result.changed).toBe(false);
            expect(result.watched).toBe(watched);
        });

        it("updates anchor to most recently watched episode, not highest index", () => {
            const videoIds = ["tt1:1:1", "tt1:1:2", "tt1:1:3", "tt1:1:4", "tt1:1:5"];
            const videoCount = videoIds.length;

            // Watch episode 5 first
            const step1 = markEpisodeWatched(null, videoCount, "tt1:1:5", videoIds);
            const decoded1 = decodeWatched(step1.watched, videoCount);
            expect(decoded1.anchorVideoId).toBe("tt1:1:5");
            expect(decoded1.anchorLength).toBe(5);

            // Now watch episode 2 — anchor should update to episode 2
            const step2 = markEpisodeWatched(step1.watched, videoCount, "tt1:1:2", videoIds);
            const decoded2 = decodeWatched(step2.watched, videoCount);
            expect(decoded2.anchorVideoId).toBe("tt1:1:2");
            expect(decoded2.anchorLength).toBe(2);

            // Both episodes should still be marked as watched
            expect(decoded2.watchedEpisodes[1]).toBe(true); // ep 2
            expect(decoded2.watchedEpisodes[4]).toBe(true); // ep 5
        });

        it("throws if videoId is not in the list", () => {
            const videoIds = ["tt500:1:1", "tt500:1:2"];
            expect(() => markEpisodeWatched(null, 2, "tt500:1:99", videoIds)).toThrow("not found in video list");
        });
    });

    describe("isEpisodeWatched", () => {
        it("returns true for a watched episode", () => {
            const videoIds = Array.from({ length: 3 }, (_, i) => `tt600:1:${i + 1}`);
            const watched = encodeWatched({
                anchorVideoId: videoIds[1],
                anchorLength: 2,
                watchedEpisodes: [true, true, false],
            });

            expect(isEpisodeWatched(watched, 3, "tt600:1:1", videoIds)).toBe(true);
            expect(isEpisodeWatched(watched, 3, "tt600:1:2", videoIds)).toBe(true);
        });

        it("returns false for an unwatched episode", () => {
            const videoIds = Array.from({ length: 3 }, (_, i) => `tt600:1:${i + 1}`);
            const watched = encodeWatched({
                anchorVideoId: videoIds[1],
                anchorLength: 2,
                watchedEpisodes: [true, true, false],
            });

            expect(isEpisodeWatched(watched, 3, "tt600:1:3", videoIds)).toBe(false);
        });

        it("returns false for null watched", () => {
            const videoIds = ["tt700:1:1"];
            expect(isEpisodeWatched(null, 1, "tt700:1:1", videoIds)).toBe(false);
        });

        it("returns false for unknown videoId", () => {
            const videoIds = ["tt800:1:1"];
            const watched = encodeWatched({
                anchorVideoId: videoIds[0],
                anchorLength: 1,
                watchedEpisodes: [true],
            });

            expect(isEpisodeWatched(watched, 1, "tt800:1:99", videoIds)).toBe(false);
        });
    });

    describe("zlib fallback", () => {
        it("uses inflateRawSync fallback for raw deflate payloads", () => {
            const rawBitset = deflateRawSync(createTestBitset(2, 3)).toString("base64");
            // 3-field format with raw deflate
            const watched = `tt900:1:3:3:${rawBitset}`;

            const decoded = decodeWatched(watched, 3);
            expect(decoded.watchedEpisodes).toEqual([true, true, false]);
        });
    });
});
