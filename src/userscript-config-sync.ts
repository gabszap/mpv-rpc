/**
 * Pending bridge config synchronization helpers.
 *
 * The userscript is the source of truth for user-facing configuration.
 * The bridge is treated as a synchronized runtime cache.
 *
 * This module exposes a tiny pure-logic layer that:
 *   - tracks a pending config object that has not yet been flushed to the bridge
 *   - flushes it (delegating the actual network call to a caller-supplied function)
 *   - wraps a play() function so that any pending config is flushed first
 *
 * The userscript mirrors this same logic inline (Tampermonkey does not run
 * TypeScript directly). The two implementations must stay in sync.
 */

/**
 * A plain JSON-serializable config object to be synced to the bridge.
 */
export type BridgeConfig = Record<string, unknown>;

/**
 * Mutable module-level pending state.
 * Exported as a holder object for tests to reset; production code should
 * use the setter/getter functions below.
 */
const pendingBridgeConfigHolder: { value: BridgeConfig | null } = { value: null };

/**
 * Set the pending bridge config. Replaces any previous pending config.
 */
export function setPendingBridgeConfig(config: BridgeConfig): void {
    pendingBridgeConfigHolder.value = config;
}

/**
 * Get the currently pending bridge config, or null if none is pending.
 */
export function getPendingBridgeConfig(): BridgeConfig | null {
    return pendingBridgeConfigHolder.value;
}

/**
 * Clear the pending bridge config without flushing.
 */
export function clearPendingBridgeConfig(): void {
    pendingBridgeConfigHolder.value = null;
}

/**
 * Test-only: reset module state. Not for production use.
 */
export function __resetPendingBridgeConfigForTests(): void {
    pendingBridgeConfigHolder.value = null;
}

/**
 * Signature of a function that posts a config to the bridge and resolves
 * when the bridge has acknowledged the write.
 */
export type PostBridgeConfig = (config: BridgeConfig) => Promise<void>;

/**
 * Flush the pending config to the bridge.
 *
 * Returns `true` on success (or when there is nothing to flush).
 * Returns `false` if posting failed; the config remains pending for a later retry.
 */
export async function flushPendingBridgeConfigImpl(postBridgeConfig: PostBridgeConfig): Promise<boolean> {
    const configToFlush = pendingBridgeConfigHolder.value;
    if (!configToFlush) {
        return true;
    }

    try {
        await postBridgeConfig(configToFlush);
    } catch {
        return false;
    }

    if (pendingBridgeConfigHolder.value === configToFlush) {
        pendingBridgeConfigHolder.value = null;
    }
    return true;
}

export type WrapPlayResult<T> = { ok: true; value: T } | { ok: false; reason: "flush-failed" };

/**
 * Wrap a play() function so that the pending bridge config is flushed first.
 *
 * If flushing fails, the play is aborted and the error is returned as
 * `{ ok: false, reason: "flush-failed" }`. Otherwise `playFn(item)` is awaited
 * and its result is returned as `{ ok: true, value }`.
 */
export async function wrapPlayWithFlush<T>(
    playFn: (item: unknown) => Promise<T>,
    postBridgeConfig: PostBridgeConfig,
    item: unknown,
): Promise<WrapPlayResult<T>> {
    const flushed = await flushPendingBridgeConfigImpl(postBridgeConfig);
    if (!flushed) {
        return { ok: false, reason: "flush-failed" };
    }

    const value = await playFn(item);
    return { ok: true, value };
}
