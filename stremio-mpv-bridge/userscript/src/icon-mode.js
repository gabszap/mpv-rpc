// Icon mode enum: legacy inference and applying it to the page.

/**
 * Derive the v2 `iconMode` enum from legacy v1 booleans.
 * Mirrors `inferIconMode` in src/bridge-config-migration.ts and
 * server.js. Any change here MUST be applied to the other two.
 */
export function inferIconMode(legacy) {
    if (!legacy || typeof legacy !== "object") {
        return "default";
    }
    const showMpvIcon = legacy.showMpvIcon;
    const showConfigIcon = legacy.showConfigIcon;
    const compactMode = legacy.compactMode;

    if (showMpvIcon === false && showConfigIcon === true && compactMode === true) {
        return "compact";
    }
    if (showMpvIcon === false && showConfigIcon === true) {
        return "config-only";
    }
    if (compactMode === true) {
        return "compact";
    }
    if (showMpvIcon === false && showConfigIcon === false) {
        return "disabled";
    }
    return "default";
}

/**
 * Resolve the visibility state for the floating button container given an
 * `iconMode` string. Pure function — callers mutate the DOM based on the
 * returned flags.
 *
 * Mirrors src/bridge-config-migration.ts — keep in sync.
 */
export function applyIconMode(iconMode) {
    const mode = iconMode || "default";
    switch (mode) {
        case "config-only":
            return {
                containerVisible: true,
                mpvButtonVisible: false,
                configButtonVisible: true,
                configButtonEnlarged: true,
                configButtonSize: "large",
                containerPosition: "bottom-right",
            };
        case "compact":
            return {
                containerVisible: true,
                mpvButtonVisible: false,
                configButtonVisible: true,
                configButtonEnlarged: false,
                configButtonSize: "small",
                containerPosition: "top-right",
            };
        case "disabled":
            return {
                containerVisible: false,
                mpvButtonVisible: false,
                configButtonVisible: false,
                configButtonEnlarged: false,
                configButtonSize: "small",
                containerPosition: "bottom-right",
            };
        default:
            return {
                containerVisible: true,
                mpvButtonVisible: true,
                configButtonVisible: true,
                configButtonEnlarged: false,
                configButtonSize: "small",
                containerPosition: "bottom-right",
            };
    }
}
