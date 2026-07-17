import { describe, expect, it } from "vitest";
import { isInternalNavigationTitle } from "../src/integrations/discord";

describe("isInternalNavigationTitle", () => {
    it("treats a Stremio settings URL as internal navigation", () => {
        expect(isInternalNavigationTitle("settings?section=integration-settings")).toBe(true);
    });

    it("treats a plain http URL as internal navigation", () => {
        expect(isInternalNavigationTitle("http://example.com/foo")).toBe(true);
    });

    it("treats an https detail URL as internal navigation", () => {
        expect(isInternalNavigationTitle("https://stremio.com/detail/series/tt1234567")).toBe(true);
    });

    it("treats a leading-slash path as internal navigation", () => {
        expect(isInternalNavigationTitle("/addons")).toBe(true);
    });

    it("accepts a normal media title", () => {
        expect(isInternalNavigationTitle("Jujutsu Kaisen")).toBe(false);
    });

    it("trims whitespace before evaluating the title", () => {
        expect(isInternalNavigationTitle("  settings?section=foo  ")).toBe(true);
    });

    it("treats the empty string as internal navigation", () => {
        expect(isInternalNavigationTitle("")).toBe(true);
    });

    it("accepts a hyphenated anime title with an episode marker", () => {
        expect(isInternalNavigationTitle("Dr Stone - New World - E05")).toBe(false);
    });

    it("accepts a SxEx-style title", () => {
        expect(isInternalNavigationTitle("OSHI NO KO S03E10")).toBe(false);
    });

    it("treats non-string inputs as internal navigation", () => {
        // The function must guard against malformed input from any caller
        // that ever forgets to coerce the title to a string.
        expect(isInternalNavigationTitle(null as unknown as string)).toBe(true);
        expect(isInternalNavigationTitle(undefined as unknown as string)).toBe(true);
        expect(isInternalNavigationTitle(42 as unknown as string)).toBe(true);
    });
});
