import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Several suites dynamically import heavy modules (providers, config, mpv)
        // in their first test; on a cold transform cache that exceeds the 5s default.
        testTimeout: 20000,
        hookTimeout: 20000,
        setupFiles: ["./tests/setup/ptt-importer.ts"],
    },
});
