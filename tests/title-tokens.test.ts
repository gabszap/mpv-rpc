import { describe, expect, it } from "vitest";
import { filterTitleStopTokens, normalizeTitleTokens } from "../src/core/title-tokens";

describe("title-tokens", () => {
    it("drops parenthesized years and punctuation", () => {
        expect(normalizeTitleTokens("JoJo's Bizarre Adventure (2012)")).toEqual(["jojo", "s", "bizarre", "adventure"]);
    });

    it("treats localized conjunctions as equivalent to being absent", () => {
        expect(normalizeTitleTokens("Rick e Morty")).toEqual(normalizeTitleTokens("Rick and Morty"));
    });

    it("falls back to raw tokens when everything would be filtered", () => {
        expect(filterTitleStopTokens(["2012"])).toEqual(["2012"]);
        expect(filterTitleStopTokens(["and"])).toEqual(["and"]);
    });

    it("returns an empty list for blank input", () => {
        expect(normalizeTitleTokens("   ")).toEqual([]);
    });
});
