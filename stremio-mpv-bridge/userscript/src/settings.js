// User settings persisted with GM_setValue, plus the v1 -> v2 migration.

import { inferIconMode } from "./icon-mode.js";

// Default active providers (only torrentio + custom)
export const DEFAULT_ACTIVE = [
    { id: "torrentio", name: "Torrentio", url: "", enabled: true },
    { id: "custom", name: "Custom", url: "", enabled: true },
];

// Bridge config schema version. Mirrors CURRENT_CONFIG_VERSION in
// stremio-mpv-bridge/server.js and src/bridge-config-migration.ts.
// Bumped whenever the GM_setValue / disk shape changes.
export const CURRENT_CONFIG_VERSION = 2;

/**
 * Migrate the userscript-side GM_setValue mirror from v1 (or unversioned)
 * to v2. Mirrors `migrateV1ToV2` in server.js and
 * src/bridge-config-migration.ts. Persists the migrated values back to
 * GM_setValue so subsequent reads are fast.
 */
function migrateLocalConfigToV2() {
    const storedVersion = GM_getValue("configVersion", null);
    if (storedVersion === CURRENT_CONFIG_VERSION) {
        return;
    }

    const legacy = {
        autoFetch: GM_getValue("autoFetchEnabled", undefined),
        extraEpisodes: GM_getValue("extraEpisodes", undefined),
        showMpvIcon: GM_getValue("showMpvIcon", undefined),
        showConfigIcon: GM_getValue("showConfigIcon", undefined),
        compactMode: GM_getValue("compactMode", undefined),
    };
    const hasLegacyValue = Object.values(legacy).some((v) => v !== undefined);

    if (hasLegacyValue) {
        const autoFetch = legacy.autoFetch !== false;
        const extraEpisodes = typeof legacy.extraEpisodes === "number" ? legacy.extraEpisodes : 2;
        const iconMode = inferIconMode(legacy);
        GM_setValue("autofetch", autoFetch);
        GM_setValue("extraEpisodes", extraEpisodes);
        GM_setValue("iconMode", iconMode);
    }

    GM_setValue("configVersion", CURRENT_CONFIG_VERSION);
}

// Apply any pending migration before reading other values so the rest
// of the script sees a v2 mirror.
migrateLocalConfigToV2();

function loadProviders() {
    const storedProviders = GM_getValue("providers", []);
    if (storedProviders.length > 0) {
        const providers = storedProviders.filter((p) => p.id !== "torbox");
        if (providers.length !== storedProviders.length) {
            GM_setValue("providers", providers);
        }
        return providers;
    }
    return [...DEFAULT_ACTIVE];
}

/**
 * Mutable user settings. ES module bindings cannot be reassigned from other
 * modules, so every setting lives on this object (settings.autoFetch = ...).
 */
export const settings = {
    // Default to 2 episodes (unified with bridge + RPC); user can override 1..25
    autoFetch: GM_getValue("autofetch", GM_getValue("autoFetchEnabled", true)),
    extraEpisodes: GM_getValue("extraEpisodes", 2),
    playlistMode: GM_getValue("playlistMode", "batch"),
    mpvShortcut: GM_getValue("mpvShortcut", "v"),
    preferredGroup: GM_getValue("preferredGroup", ""),
    preferredQuality: GM_getValue("preferredQuality", ""),
    mpvArgsStr: GM_getValue("mpvArgsStr", ""),
    providers: loadProviders(),
};
