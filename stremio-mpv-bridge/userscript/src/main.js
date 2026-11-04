// Entry point: initializes the userscript.

import { checkServer } from "./bridge-api.js";
import { startBridgePolling } from "./bridge-polling.js";
import { createConfigModal } from "./config-modal.js";
import {
    createFloatingButton,
    schedulePositionCompactConfigButton,
    scheduleUpdateButtonInfo,
    updateButtonInfo,
} from "./floating-ui.js";
import { log } from "./logging.js";
import { handleMPVClick } from "./playback.js";
import { resolveProviderName } from "./providers.js";
import { settings } from "./settings.js";
import { notify, showBridgeConnectedToast } from "./toasts.js";
import { isDetailRoute } from "./url-parser.js";

async function init() {
    const version = GM_info.script.version;

    // Resolve provider names asynchronously for logging
    const activeProviders = settings.providers.filter((p) => p.enabled && p.url);
    let providerSummary = "None";
    if (activeProviders.length > 0) {
        const resolvedNames = await Promise.all(activeProviders.map((p) => resolveProviderName(p)));
        providerSummary = resolvedNames.join(", ");
    }

    const modeText =
        settings.playlistMode === "all"
            ? "Load All"
            : settings.playlistMode === "single"
              ? "Single"
              : `Batch | Extra: ${settings.extraEpisodes}`;

    notify(`v${version} initialized — ${providerSummary} — ${modeText}`);

    if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Open MPV Bridge Settings", () => {
            createConfigModal();
        });
    }

    // Check bridge server and show connected toast
    try {
        const isOnline = await checkServer();
        if (isOnline) {
            showBridgeConnectedToast();
        }
    } catch {
        // Silently ignore - server status is non-critical for initialization
    }

    createFloatingButton();

    // Start polling for bridge connection status
    startBridgePolling();

    window.addEventListener("keydown", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        if (e.key.toLowerCase() === settings.mpvShortcut) {
            if (isDetailRoute()) {
                handleMPVClick(e);
            }
        }
    });

    let lastHash = window.location.hash;
    const hashCheckInterval = setInterval(() => {
        if (window.location.hash !== lastHash) {
            lastHash = window.location.hash;
            log("URL changed:", `${lastHash.substring(0, 60)}...`);
            updateButtonInfo();
            if (GM_getValue("iconMode", "default") === "compact") {
                schedulePositionCompactConfigButton();
                setTimeout(() => {
                    schedulePositionCompactConfigButton();
                }, 300);
            }
        }
    }, 500);

    const scheduleFloatingButtonLayout = () => {
        if (GM_getValue("iconMode", "default") === "compact") {
            schedulePositionCompactConfigButton();
            return;
        }

        scheduleUpdateButtonInfo();
    };

    window.addEventListener("resize", scheduleFloatingButtonLayout);

    window.addEventListener("beforeunload", () => {
        clearInterval(hashCheckInterval);
        window.removeEventListener("resize", scheduleFloatingButtonLayout);
    });
    let compactRepositionTimer = null;
    new MutationObserver(() => {
        if (!document.getElementById("stremio-mpv-floating")) createFloatingButton();
        if (GM_getValue("iconMode", "default") === "compact") {
            schedulePositionCompactConfigButton();
            if (compactRepositionTimer !== null) {
                clearTimeout(compactRepositionTimer);
            }
            compactRepositionTimer = setTimeout(() => {
                compactRepositionTimer = null;
                schedulePositionCompactConfigButton();
            }, 300);
        }
    }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "complete") init();
else window.addEventListener("load", init);
