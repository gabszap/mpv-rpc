import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: vi.fn(() => ({})) }));
beforeEach(() => {
    vi.stubEnv("SIMKL_SYNC", "");
    vi.stubEnv("SIMKL_CLIENT_ID", "");
    vi.stubEnv("SIMKL_SYNC_THRESHOLD", "");
    vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

it("defaults Simkl to disabled with an empty client id and an 80 percent stop threshold", async () => {
    const { config } = await import("../src/core/config");
    expect(config.simkl).toEqual({ enabled: false, clientId: "", syncThreshold: 80 });
});
it.each([
    ["49", 50],
    ["101", 100],
    ["90", 90],
    ["broken", 80],
    ["80.9", 80],
])("validates threshold %s as %s", async (value, expected) => {
    vi.stubEnv("SIMKL_SYNC_THRESHOLD", value);
    const { config } = await import("../src/core/config");
    expect(config.simkl.syncThreshold).toBe(expected);
});
it("reloads all Simkl options", async () => {
    const { config, reloadConfig } = await import("../src/core/config");
    vi.stubEnv("SIMKL_SYNC", "true");
    vi.stubEnv("SIMKL_CLIENT_ID", "new-client");
    vi.stubEnv("SIMKL_SYNC_THRESHOLD", "85");
    expect(reloadConfig()).toEqual(
        expect.arrayContaining([
            "SIMKL_SYNC: false -> true",
            "SIMKL_CLIENT_ID changed",
            "SIMKL_SYNC_THRESHOLD: 80 -> 85",
        ]),
    );
    expect(config.simkl).toEqual({ enabled: true, clientId: "new-client", syncThreshold: 85 });
});
