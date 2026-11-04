import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Several suites dynamically import heavy modules (providers, config, mpv)
        // in their first test; on a cold transform cache that exceeds the 5s default.
        testTimeout: 20000,
        hookTimeout: 20000,
        // Make tests independent of a developer's local .env: dotenv never overrides
        // variables that are already set. axios is mocked, so no real request is made.
        env: {
            USE_GUESSIT_API: "true",
            GUESSIT_API_URL: "https://guessit-api.vercel.app/api/parse",
        },
    },
});
