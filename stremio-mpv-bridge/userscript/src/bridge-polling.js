// Periodic bridge health polling.

import { checkServer } from "./bridge-api.js";
import { log } from "./logging.js";
import { showBridgeConnectedToast } from "./toasts.js";

// ==================== BRIDGE CONNECTION POLLING ====================
// Polls the bridge health endpoint at a fixed interval.
// Shows a toast only on the offline -> online transition to avoid spam.
// The interval is cleared when the modal closes or the script unloads.
let bridgePollInterval = null;

let wasBridgeOnline = false;

export function startBridgePolling() {
    if (bridgePollInterval) return; // already running

    // Seed the initial state BEFORE starting the interval to avoid a race
    // where the first tick fires before we know the true online state.
    checkServer().then((isOnline) => {
        wasBridgeOnline = isOnline;
        log(`[BridgePoll] Initial seed: isOnline=${isOnline}, wasBridgeOnline=${wasBridgeOnline}`);

        bridgePollInterval = setInterval(async () => {
            const isOnline = await checkServer();
            log(`[BridgePoll] Tick: isOnline=${isOnline}, wasBridgeOnline=${wasBridgeOnline}`);
            if (isOnline && !wasBridgeOnline) {
                // Transition: offline -> online
                log("[BridgePoll] Detected offline -> online transition, showing toast");
                showBridgeConnectedToast();
            }
            wasBridgeOnline = isOnline;
        }, 10000);
    });
}

export function stopBridgePolling() {
    if (bridgePollInterval) {
        clearInterval(bridgePollInterval);
        bridgePollInterval = null;
    }
}
