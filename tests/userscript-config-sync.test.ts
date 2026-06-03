import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    __resetPendingBridgeConfigForTests,
    clearPendingBridgeConfig,
    flushPendingBridgeConfigImpl,
    getPendingBridgeConfig,
    setPendingBridgeConfig,
    wrapPlayWithFlush,
} from "../src/userscript-config-sync";

describe("userscript-config-sync", () => {
    beforeEach(() => {
        __resetPendingBridgeConfigForTests();
    });

    it("setPendingBridgeConfig + getPendingBridgeConfig round-trip", () => {
        expect(getPendingBridgeConfig()).toBeNull();

        const config = { providers: ["torrentio"], extraEpisodes: 2 };
        setPendingBridgeConfig(config);

        expect(getPendingBridgeConfig()).toBe(config);
    });

    it("clearPendingBridgeConfig drops the pending value", () => {
        setPendingBridgeConfig({ a: 1 });
        clearPendingBridgeConfig();
        expect(getPendingBridgeConfig()).toBeNull();
    });

    it("flushPendingBridgeConfigImpl returns true and clears pending when postBridgeConfig resolves", async () => {
        setPendingBridgeConfig({ x: 1 });
        const post = vi.fn().mockResolvedValue(undefined);

        const result = await flushPendingBridgeConfigImpl(post);

        expect(result).toBe(true);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith({ x: 1 });
        expect(getPendingBridgeConfig()).toBeNull();
    });

    it("flushPendingBridgeConfigImpl does not clear newer pending config when an older flush resolves", async () => {
        const configA = { x: "A" };
        const configB = { x: "B" };
        let resolvePost: (() => void) | undefined;
        const post = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolvePost = resolve;
                }),
        );

        setPendingBridgeConfig(configA);
        const flushPromise = flushPendingBridgeConfigImpl(post);

        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith(configA);

        setPendingBridgeConfig(configB);
        if (!resolvePost) {
            throw new Error("Deferred config POST was not started");
        }
        resolvePost();

        await expect(flushPromise).resolves.toBe(true);
        expect(getPendingBridgeConfig()).toBe(configB);
    });

    it("flushPendingBridgeConfigImpl returns false and keeps pending when postBridgeConfig rejects", async () => {
        setPendingBridgeConfig({ x: 1 });
        const post = vi.fn().mockRejectedValue(new Error("bridge down"));

        const result = await flushPendingBridgeConfigImpl(post);

        expect(result).toBe(false);
        expect(post).toHaveBeenCalledTimes(1);
        expect(getPendingBridgeConfig()).toEqual({ x: 1 });
    });

    it("flushPendingBridgeConfigImpl returns true (no-op) when no pending config", async () => {
        const post = vi.fn().mockResolvedValue(undefined);

        const result = await flushPendingBridgeConfigImpl(post);

        expect(result).toBe(true);
        expect(post).not.toHaveBeenCalled();
    });

    it("wrapPlayWithFlush does not call playFn when flush fails", async () => {
        setPendingBridgeConfig({ x: 1 });
        const post = vi.fn().mockRejectedValue(new Error("bridge down"));
        const play = vi.fn().mockResolvedValue("played");

        const result = await wrapPlayWithFlush(play, post, { item: "thing" });

        expect(result).toEqual({ ok: false, reason: "flush-failed" });
        expect(play).not.toHaveBeenCalled();
    });

    it("wrapPlayWithFlush calls playFn with the item and returns its result when flush succeeds", async () => {
        setPendingBridgeConfig({ x: 1 });
        const post = vi.fn().mockResolvedValue(undefined);
        const play = vi.fn().mockResolvedValue("played");
        const item = { id: "abc" };

        const result = await wrapPlayWithFlush(play, post, item);

        expect(result).toEqual({ ok: true, value: "played" });
        expect(play).toHaveBeenCalledTimes(1);
        expect(play).toHaveBeenCalledWith(item);
        expect(getPendingBridgeConfig()).toBeNull();
    });
});
