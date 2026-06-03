/**
 * Bridge configuration schema migration.
 *
 * The bridge config (`.config/.stremio-mpv-config.json`) is shared between:
 *   - `stremio-mpv-bridge/server.js` (plain Node, no TypeScript at runtime)
 *   - `stremio-mpv-bridge/stremio-mpv.user.js` (userscript, plain JS)
 *   - `src/stremio-sync/context.ts` (TypeScript, compiled)
 *
 * To keep the bridge side dependency-free, the same `migrateV1ToV2` logic is
 * re-implemented in `server.js` and the userscript. **This file is the
 * authoritative, testable source** — any change to the migration rules must
 * be made here first and then mirrored in the JS copies.
 *
 * @see plans/mpv-rpc-improvements-plan-formatted.md §4.3
 */

/** Current bridge config schema version. Bumped whenever the shape changes. */
export const CURRENT_CONFIG_VERSION = 2 as const;

/** All icon modes understood by the v2 schema. */
export type BridgeIconMode = "default" | "config-only" | "compact" | "disabled";

/**
 * Shape of the legacy v1 icon-related fields. All fields are optional because
 * the bridge always tolerates partial / pre-v1 configs.
 */
export type LegacyIconFields = {
    showMpvIcon?: boolean;
    showConfigIcon?: boolean;
    compactMode?: boolean;
};

/** Full v1 config shape — all fields optional, others preserved. */
export type LegacyBridgeConfigV1 = LegacyIconFields & {
    configVersion?: 1;
    autoFetchEnabled?: boolean;
    extraEpisodes?: number;
    [key: string]: unknown;
};

/** Full v2 config shape. */
export type BridgeConfigV2 = {
    configVersion: 2;
    autoFetch: { enabled: boolean };
    extraEpisodes: number;
    iconMode: BridgeIconMode;
    [key: string]: unknown;
};

const DEFAULT_EXTRA_EPISODES = 2;

/**
 * Derive the v2 `iconMode` enum from the legacy v1 booleans.
 *
 * Rules (from plan §4.3, applied in priority order):
 *   - `showMpvIcon === false && showConfigIcon === true && compactMode === true` → "compact"
 *   - `showMpvIcon === false && showConfigIcon === true` → "config-only"
 *   - `compactMode === true` → "compact"
 *   - `showMpvIcon === false && showConfigIcon === false` → "disabled"
 *   - default → "default"
 *
 * Accepts `undefined` for convenience (empty/missing legacy config).
 */
export function inferIconMode(legacy: LegacyIconFields | undefined): BridgeIconMode {
    if (!legacy) {
        return "default";
    }

    const { showMpvIcon, showConfigIcon, compactMode } = legacy;

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
 * Migrate a v1 (or partial / pre-versioned) config to the v2 shape.
 * Unknown fields are preserved via the spread.
 */
export function migrateV1ToV2(config: LegacyBridgeConfigV1): BridgeConfigV2 {
    return {
        ...config,
        configVersion: CURRENT_CONFIG_VERSION,
        autoFetch: { enabled: config.autoFetchEnabled ?? true },
        extraEpisodes: config.extraEpisodes ?? DEFAULT_EXTRA_EPISODES,
        iconMode: inferIconMode(config),
    };
}

/**
 * Default v2 config used when no prior config exists or the input is not a
 * usable config object (null, non-object, array).
 */
function defaultV2Config(): BridgeConfigV2 {
    return {
        configVersion: CURRENT_CONFIG_VERSION,
        autoFetch: { enabled: true },
        extraEpisodes: DEFAULT_EXTRA_EPISODES,
        iconMode: "default",
    };
}

/**
 * Top-level migration entry point. Safe to call with arbitrary input:
 *   - already-v2 config → returned as-is
 *   - v1 / partial / unversioned object → migrated to v2
 *   - null / non-object / array → fresh v2 defaults
 */
export function migrateBridgeConfig(config: unknown): BridgeConfigV2 {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return defaultV2Config();
    }

    const cfg = config as Record<string, unknown>;
    if (cfg.configVersion === CURRENT_CONFIG_VERSION) {
        return cfg as BridgeConfigV2;
    }

    return migrateV1ToV2(cfg as LegacyBridgeConfigV1);
}

/** All icon visibility modes understood by the v2 schema. */
export type IconMode = "default" | "config-only" | "compact" | "disabled";

/**
 * Visibility state for the floating button container, derived from
 * {@link IconMode}. Pure data — callers are responsible for mutating the DOM.
 */
export type IconVisibilityState = {
    containerVisible: boolean;
    mpvButtonVisible: boolean;
    configButtonVisible: boolean;
    configButtonEnlarged: boolean;
};

/**
 * Resolve the icon visibility state for a given {@link IconMode}.
 *
 * Pure function. `undefined` / `null` / unknown values fall back to `"default"`,
 * which keeps the function safe to call with `GM_getValue` results that may be
 * missing or corrupted.
 *
 * Mirrored verbatim in `stremio-mpv-bridge/stremio-mpv.user.js` (as
 * `applyIconMode`) — any change here MUST be applied there too.
 *
 * @param iconMode The user's configured icon mode (or `undefined` / `null`).
 * @returns The visibility flags the floating UI should apply to the DOM.
 */
export function applyIconMode(iconMode: IconMode | undefined | null): IconVisibilityState {
    const mode: IconMode = iconMode ?? "default";
    switch (mode) {
        case "config-only":
            return {
                containerVisible: true,
                mpvButtonVisible: false,
                configButtonVisible: true,
                configButtonEnlarged: false,
            };
        case "compact":
            return {
                containerVisible: true,
                mpvButtonVisible: false,
                configButtonVisible: true,
                configButtonEnlarged: true,
            };
        case "disabled":
            return {
                containerVisible: false,
                mpvButtonVisible: false,
                configButtonVisible: false,
                configButtonEnlarged: false,
            };
        case "default":
        default:
            return {
                containerVisible: true,
                mpvButtonVisible: true,
                configButtonVisible: true,
                configButtonEnlarged: false,
            };
    }
}
