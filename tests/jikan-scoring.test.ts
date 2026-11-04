import { describe, expect, it } from "vitest";
import { levenshteinDistance, calculateTitleScore, computeAlternativeTitleScore } from "../src/providers/jikan";

describe("levenshteinDistance", () => {
    it("returns 0 for identical strings", () => {
        expect(levenshteinDistance("hello", "hello")).toBe(0);
    });

    it("returns correct distance for single character change", () => {
        expect(levenshteinDistance("bungou", "bungo")).toBe(1);
    });

    it("returns correct distance for empty string vs non-empty", () => {
        expect(levenshteinDistance("", "hello")).toBe(5);
        expect(levenshteinDistance("hello", "")).toBe(5);
    });

    it("handles completely different strings", () => {
        expect(levenshteinDistance("abc", "xyz")).toBe(3);
    });

    it("handles insertion", () => {
        expect(levenshteinDistance("cat", "chat")).toBe(1);
    });

    it("handles deletion", () => {
        expect(levenshteinDistance("chat", "cat")).toBe(1);
    });

    it("handles transpositions as two edits", () => {
        expect(levenshteinDistance("ab", "ba")).toBe(2);
    });

    it("handles both strings empty", () => {
        expect(levenshteinDistance("", "")).toBe(0);
    });

    it("handles case sensitivity correctly (case matters)", () => {
        expect(levenshteinDistance("Attack", "attack")).toBe(1);
    });
});

describe("calculateTitleScore", () => {
    const titles = [
        { type: "Default", title: "Shingeki no Kyojin" },
        { type: "English", title: "Attack on Titan" },
        { type: "Japanese", title: "進撃の巨人" },
        { type: "Synonym", title: "AOT" },
    ];

    it("scores exact match highest", () => {
        const score = calculateTitleScore("attack on titan", "Shingeki no Kyojin", "Attack on Titan");
        expect(score).toBeGreaterThanOrEqual(1000);
    });

    it("scores starting with query high", () => {
        const score = calculateTitleScore("attack", "Shingeki no Kyojin", "Attack on Titan");
        expect(score).toBeGreaterThanOrEqual(500);
    });

    it("boosts with synonym match via titles parameter", () => {
        const scoreWithout = calculateTitleScore("aot", "Shingeki no Kyojin", null);
        const scoreWith = calculateTitleScore("aot", "Shingeki no Kyojin", null, titles);
        expect(scoreWith).toBeGreaterThan(scoreWithout);
    });

    it("boosts with Japanese title match via titles parameter", () => {
        const scoreWithout = calculateTitleScore("進撃の巨人", "Shingeki no Kyojin", "Attack on Titan");
        const scoreWith = calculateTitleScore("進撃の巨人", "Shingeki no Kyojin", "Attack on Titan", titles);
        expect(scoreWith).toBeGreaterThanOrEqual(scoreWithout);
    });

    it("applies Levenshtein boost for typo when score is low", () => {
        // "bungou" vs "bungo" — Levenshtein distance 1, should get fuzzy boost
        const score = calculateTitleScore("bungou stray dogs", "Bungo Stray Dogs", null);
        expect(score).toBeGreaterThan(0);
    });

    it("does not apply Levenshtein boost when score is already high", () => {
        const score = calculateTitleScore("attack on titan", "Shingeki no Kyojin", "Attack on Titan");
        // Should be >= 1000 without any fuzzy boost
        expect(score).toBeGreaterThanOrEqual(1000);
    });

    it("handles null englishTitle gracefully", () => {
        const score = calculateTitleScore("naruto", "Naruto", null);
        expect(score).toBeGreaterThan(0);
    });

    it("penalizes title much longer than query", () => {
        // Query "naruto" starts the title → gets 500 + 350 + 200 = 1050, then -100 penalty = 950
        // The length ratio is 6/48 = 0.125 < 0.3 so the -100 penalty is applied
        const scoreLong = calculateTitleScore("naruto", "Naruto: Shippuden - The Movie 5: The Blood Prison", "Naruto Shipuden");
        expect(scoreLong).toBeLessThan(1000); // penalty applied, without it would be 1050

        // A short non-matching query with length > 1 → ratio 3/48 = 0.0625 < 0.3 → -100 penalty
        // No word-match bonuses since "zzz" isn't in the title
        const scoreShort = calculateTitleScore("zzz", "Naruto: Shippuden - The Movie 5: The Blood Prison", "Naruto Shipuden");
        expect(scoreShort).toBeLessThan(0); // penalty alone with no bonuses
    });

    it("handles empty titles array", () => {
        // Should not throw
        const score = calculateTitleScore("naruto", "Naruto", "Naruto", []);
        expect(score).toBeGreaterThan(0);
    });

    it("handles undefined titles parameter", () => {
        // Should not throw
        const score = calculateTitleScore("naruto", "Naruto", "Naruto");
        expect(score).toBeGreaterThan(0);
    });
});

describe("computeAlternativeTitleScore", () => {
    it("skips Default and English type titles", () => {
        const titles = [
            { type: "Default", title: "Shingeki no Kyojin" },
            { type: "English", title: "Attack on Titan" },
            { type: "Japanese", title: "進撃の巨人" },
        ];
        const score = computeAlternativeTitleScore("進撃の巨人", titles);
        // Should match Japanese title (not Default or English)
        expect(score).toBeGreaterThan(0);
    });

    it("returns 0 for empty titles array", () => {
        expect(computeAlternativeTitleScore("naruto", [])).toBe(0);
    });

    it("returns 0 when no titles match", () => {
        const titles = [
            { type: "Synonym", title: "AOT" },
            { type: "Japanese", title: "進撃の巨人" },
        ];
        const score = computeAlternativeTitleScore("onepiece", titles);
        expect(score).toBe(0);
    });

    it("returns correct weighted score for exact synonym match", () => {
        const titles = [
            { type: "Synonym", title: "AOT" },
        ];
        // "aot" accumulates all scoring: exact(1000) + starts-with(500) +
        // word-match(350) + substring(200) = 2050 → 50% weight = 1025
        const score = computeAlternativeTitleScore("aot", titles);
        expect(score).toBe(1025);
    });

    it("applies 50% weight to alternative title scores", () => {
        const titles = [
            { type: "Japanese", title: "進撃の巨人" },
        ];
        const score = computeAlternativeTitleScore("進撃の巨人", titles);
        // Accumulates: exact(1000) + starts-with(500) + word-match(350) +
        // substring(200) = 2050 → 50% weight = 1025
        expect(score).toBe(1025);
    });

    it("skips entries with non-string or empty title", () => {
        const titles = [
            { type: "Synonym", title: "" },
            { type: "Japanese", title: "進撃の巨人" },
        ];
        const score = computeAlternativeTitleScore("進撃の巨人", titles);
        expect(score).toBeGreaterThan(0);
    });
});
