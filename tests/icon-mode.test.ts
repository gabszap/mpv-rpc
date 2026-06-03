import { describe, expect, it } from "vitest";
import { applyIconMode, type IconMode } from "../src/bridge-config-migration";

describe("applyIconMode", () => {
    it("returns the default visibility state for mode 'default'", () => {
        expect(applyIconMode("default")).toEqual({
            containerVisible: true,
            mpvButtonVisible: true,
            configButtonVisible: true,
            configButtonEnlarged: false,
        });
    });

    it("hides the MPV button and keeps the config button at default size for mode 'config-only'", () => {
        expect(applyIconMode("config-only")).toEqual({
            containerVisible: true,
            mpvButtonVisible: false,
            configButtonVisible: true,
            configButtonEnlarged: false,
        });
    });

    it("enlarges the config button and hides the MPV button for mode 'compact'", () => {
        expect(applyIconMode("compact")).toEqual({
            containerVisible: true,
            mpvButtonVisible: false,
            configButtonVisible: true,
            configButtonEnlarged: true,
        });
    });

    it("hides the entire container (and all buttons) for mode 'disabled'", () => {
        expect(applyIconMode("disabled")).toEqual({
            containerVisible: false,
            mpvButtonVisible: false,
            configButtonVisible: false,
            configButtonEnlarged: false,
        });
    });

    it("falls back to 'default' when iconMode is undefined", () => {
        expect(applyIconMode(undefined)).toEqual({
            containerVisible: true,
            mpvButtonVisible: true,
            configButtonVisible: true,
            configButtonEnlarged: false,
        });
    });

    it("falls back to 'default' when iconMode is null", () => {
        expect(applyIconMode(null)).toEqual({
            containerVisible: true,
            mpvButtonVisible: true,
            configButtonVisible: true,
            configButtonEnlarged: false,
        });
    });

    it("falls back to 'default' when iconMode is an unknown string", () => {
        expect(applyIconMode("bogus" as IconMode)).toEqual({
            containerVisible: true,
            mpvButtonVisible: true,
            configButtonVisible: true,
            configButtonEnlarged: false,
        });
    });
});
