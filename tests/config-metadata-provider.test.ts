import { afterEach, describe, expect, it, vi } from "vitest";

const originalMetadataProvider = process.env.METADATA_PROVIDER;

function restoreMetadataProviderEnv(): void {
    if (originalMetadataProvider === undefined) {
        delete process.env.METADATA_PROVIDER;
        return;
    }

    process.env.METADATA_PROVIDER = originalMetadataProvider;
}

describe("config metadata provider parsing", () => {
    afterEach(() => {
        restoreMetadataProviderEnv();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("normalizes valid providers from environment", async () => {
        process.env.METADATA_PROVIDER = "  AniList  ";

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { config } = await import("../src/config");

        expect(config.metadataProvider).toBe("anilist");
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("falls back to jikan when provider is invalid", async () => {
        process.env.METADATA_PROVIDER = "mal";

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { config } = await import("../src/config");

        expect(config.metadataProvider).toBe("jikan");
        expect(warnSpy).toHaveBeenCalledWith(
            "[Config] Invalid METADATA_PROVIDER \"mal\". Falling back to \"jikan\"."
        );
    });
});
