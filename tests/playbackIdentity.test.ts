import { describe, expect, it } from "vitest";
import {
    createPlaybackIdentity,
    isSafeForSync,
    mergePlaybackIdentity,
    normalizeTitle,
    type PlaybackEpisodeIdentity,
} from "../src/core/playbackIdentity";

describe("createPlaybackIdentity", () => {
    it("applies defaults and normalizes the title", () => {
        const identity = createPlaybackIdentity({ title: "Jujutsu Kaisen", episode: 5 });

        expect(identity.title).toBe("Jujutsu Kaisen");
        expect(identity.normalizedTitle).toBe("jujutsu kaisen");
        expect(identity.parserSource).toBe("fallback");
        expect(identity.confidence).toBe("low");
        expect(identity.episode).toBe(5);
    });

    it("preserves caller-supplied parserSource, confidence, and identifiers", () => {
        const identity = createPlaybackIdentity({
            title: "Sakurasou",
            imdbId: "tt0000001",
            parserSource: "ptt",
            confidence: "high",
        });

        expect(identity.parserSource).toBe("ptt");
        expect(identity.confidence).toBe("high");
        expect(identity.imdbId).toBe("tt0000001");
    });

    it("strips diacritics when normalizing (ö → o, é → e)", () => {
        const identity = createPlaybackIdentity({ title: "Shingeki no Kyojin: Ömer" });

        expect(identity.normalizedTitle).not.toContain("ö");
        expect(identity.normalizedTitle).toContain("omer");
        expect(identity.normalizedTitle).toBe("shingeki no kyojin: omer");
    });
});

describe("mergePlaybackIdentity", () => {
    const base = createPlaybackIdentity({
        title: "Original Title",
        episode: 3,
        season: 1,
        imdbId: "tt1111111",
        parserSource: "ptt",
        confidence: "high",
    });

    it("overlay's defined fields win for episode", () => {
        const merged = mergePlaybackIdentity(base, { episode: 7 });

        expect(merged.episode).toBe(7);
        expect(merged.title).toBe(base.title);
        expect(merged.season).toBe(base.season);
        expect(merged.imdbId).toBe(base.imdbId);
        expect(merged.parserSource).toBe(base.parserSource);
        expect(merged.confidence).toBe(base.confidence);
    });

    it("recomputes normalizedTitle when overlay changes the title", () => {
        const merged = mergePlaybackIdentity(base, { title: "New Title" });

        expect(merged.title).toBe("New Title");
        expect(merged.normalizedTitle).toBe("new title");
    });

    it("lets the overlay upgrade parserSource and confidence", () => {
        const merged = mergePlaybackIdentity(base, {
            parserSource: "stremioMeta",
            confidence: "medium",
        });

        expect(merged.parserSource).toBe("stremioMeta");
        expect(merged.confidence).toBe("medium");
    });

    it("leaves the base alone (no input mutation)", () => {
        const snapshot: PlaybackEpisodeIdentity = JSON.parse(JSON.stringify(base));
        mergePlaybackIdentity(base, { title: "Changed", episode: 99 });

        expect(base).toEqual(snapshot);
    });
});

describe("normalizeTitle", () => {
    it("lowercases and trims", () => {
        expect(normalizeTitle("  Hello WORLD  ")).toBe("hello world");
    });

    it("collapses internal whitespace", () => {
        expect(normalizeTitle("foo   bar\tbaz")).toBe("foo bar baz");
    });

    it("strips leading and trailing punctuation", () => {
        expect(normalizeTitle("  - foo! ")).toBe("foo");
    });

    it("returns empty string for empty input", () => {
        expect(normalizeTitle("")).toBe("");
    });

    it("strips cedilla and tilde characters that NFD does not fold", () => {
        expect(normalizeTitle("Açaí")).toBe("acai");
        expect(normalizeTitle("Mañana")).toBe("manana");
    });

    it("preserves non-Latin letters (Japanese, Cyrillic) without folding to empty", () => {
        // Non-ASCII letters must survive the trim + lowercase + strip pass so
        // downstream code (search, comparison) has something to work with.
        const japanese = normalizeTitle("進撃の巨人");
        expect(japanese).not.toBe("");
        expect(japanese.length).toBeGreaterThan(0);

        const cyrillic = normalizeTitle("Один Кусок");
        expect(cyrillic).not.toBe("");
        expect(cyrillic.length).toBeGreaterThan(0);
    });
});

describe("isSafeForSync", () => {
    it("returns false when there is no episode number", () => {
        const identity = createPlaybackIdentity({
            title: "Sakurasou",
            imdbId: "tt0000001",
        });

        expect(isSafeForSync(identity)).toBe(false);
    });

    it("returns true with title, episode, and an external id", () => {
        const identity = createPlaybackIdentity({
            title: "Sakurasou",
            episode: 1,
            imdbId: "tt0000001",
        });

        expect(isSafeForSync(identity)).toBe(true);
    });

    it("returns true when only absoluteEpisode is set", () => {
        const identity = createPlaybackIdentity({
            title: "Naruto",
            absoluteEpisode: 1,
            malId: "1735",
        });

        expect(identity.episode).toBeUndefined();
        expect(identity.absoluteEpisode).toBe(1);
        expect(isSafeForSync(identity)).toBe(true);
    });

    it("returns false for an empty title", () => {
        const identity = createPlaybackIdentity({ title: "" });
        identity.title = "";

        expect(isSafeForSync(identity)).toBe(false);
    });

    it("returns false for the literal 'N/A' title", () => {
        const identity = createPlaybackIdentity({
            title: "N/A",
            episode: 1,
            imdbId: "tt0000001",
        });

        expect(isSafeForSync(identity)).toBe(false);
    });

    it("returns false when no external id is present", () => {
        const identity = createPlaybackIdentity({ title: "Solo Show", episode: 1 });

        expect(isSafeForSync(identity)).toBe(false);
    });

    it("returns false for a single-character title even with episode and id", () => {
        const identity = createPlaybackIdentity({
            title: "X",
            episode: 1,
            imdbId: "tt0000001",
        });

        expect(isSafeForSync(identity)).toBe(false);
    });

    it("returns true for a non-ASCII-only title when episode and id are present", () => {
        // Regression: the previous ASCII-only `\w` regex treated titles like
        // "進撃の巨人" as having zero word characters and rejected them.
        const identity = createPlaybackIdentity({
            title: "進撃の巨人",
            episode: 1,
            imdbId: "tt0000001",
        });

        expect(isSafeForSync(identity)).toBe(true);
    });

    it("returns true for a Cyrillic-only title when episode and id are present", () => {
        const identity = createPlaybackIdentity({
            title: "Один Кусок",
            episode: 1,
            imdbId: "tt0000001",
        });

        expect(isSafeForSync(identity)).toBe(true);
    });
});
