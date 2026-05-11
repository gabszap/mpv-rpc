import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeWatched, encodeWatched, markEpisodeWatched } from "../src/stremio-sync/bitset";

describe("Stremio watched bitset helpers", () => {
    it("decodes the observed watched format", () => {
        const decoded = decodeWatched("tt9679542:4:30:90:eJxjYGBgOPAfDJgZACeyBr4=");

        expect(decoded.imdbId).toBe("tt9679542");
        expect(decoded.season).toBe(4);
        expect(decoded.totalEpsInSeason).toBe(30);
        expect(decoded.lastGlobalEp).toBe(90);
        expect(decoded.watchedEpisodes).toHaveLength(30);
    });

    it("re-encodes decoded state without changing watched bits", () => {
        const decoded = decodeWatched("tt9679542:4:30:90:eJxjYGBgOPAfDJgZACeyBr4=");
        const reencoded = encodeWatched(decoded);

        expect(decodeWatched(reencoded)).toEqual(decoded);
    });

    it("marks an unmarked episode and reports a change", () => {
        const watched = encodeWatched({
            imdbId: "tt1234567",
            season: 1,
            totalEpsInSeason: 3,
            lastGlobalEp: 7,
            watchedEpisodes: [false, false, false],
        });

        const result = markEpisodeWatched(watched, 2);

        expect(result.changed).toBe(true);
        expect(decodeWatched(result.watched).watchedEpisodes).toEqual([false, true, false]);
        expect(decodeWatched(result.watched).lastGlobalEp).toBe(7);
    });

    it("does not modify already marked episodes", () => {
        const watched = encodeWatched({
            imdbId: "tt1234567",
            season: 1,
            totalEpsInSeason: 3,
            lastGlobalEp: 7,
            watchedEpisodes: [false, true, false],
        });

        const result = markEpisodeWatched(watched, 2);

        expect(result).toEqual({ watched, changed: false });
    });

    it("uses inflateRawSync fallback for raw deflate payloads", () => {
        const rawBitset = deflateRawSync(Buffer.from([0b00000101])).toString("base64");

        const decoded = decodeWatched(`tt1234567:1:3:0:${rawBitset}`);

        expect(decoded.watchedEpisodes).toEqual([true, false, true]);
    });

    it("throws a clear error for invalid watched format", () => {
        expect(() => decodeWatched("mal:1:1:1:not-a-real-format")).toThrow("Invalid Stremio watched format.");
    });
});
