/**
 * Phase 4 log cleanup smoke tests.
 *
 * These tests verify the production log wording changes from the
 * mpv-rpc improvement plan. They do not exercise runtime behavior
 * of the modules (which have heavy side effects on import); they
 * only assert that the source files contain the expected strings
 * after the rename/wording cleanup.
 *
 * The strategy is intentionally simple: read the source files as
 * strings and assert presence/absence of key phrases. This keeps
 * the test fully isolated and free of mocking/side-effect concerns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(__dirname, "..", "src");

function readSource(relativePath: string): string {
    const absolute = path.join(SRC_DIR, relativePath);
    return fs.readFileSync(absolute, "utf-8");
}

describe("Phase 4 log cleanup", () => {
    describe("src/stremio-sync/sync.ts — 'Watched marked' → 'Marked as watched'", () => {
        const source = readSource(path.join("stremio-sync", "sync.ts"));

        it("contains the renamed '[Stremio] Marked as watched:' prefix", () => {
            expect(source).toContain("[Stremio] Marked as watched:");
        });

        it("no longer contains the old '[Stremio] Watched marked:' prefix", () => {
            expect(source).not.toContain("[Stremio] Watched marked:");
        });
    });

    describe("src/trakt-sync/sync.ts — explicit 'Marked as watched' after scrobble stop", () => {
        const source = readSource(path.join("trakt-sync", "sync.ts"));

        it("contains the '[Trakt] Marked as watched:' log pattern", () => {
            expect(source).toContain("[Trakt] Marked as watched:");
        });

        it("emits the 'Marked as watched' log on every successful scrobbleStop path", () => {
            // Four scrobbleStop success paths expected: metadata-key-change, idle, playing, paused
            const matches = source.match(/\[Trakt\] Marked as watched:/g) ?? [];
            expect(matches.length).toBe(4);
        });
    });

    describe("src/index.ts — MVP framing removed from Stremio logs", () => {
        const source = readSource("index.ts");

        it("no longer mentions 'Watched badges are not updated by the MVP'", () => {
            expect(source).not.toContain("Watched badges are not updated by the MVP");
        });

        it("no longer mentions 'Continue Watching MVP'", () => {
            expect(source).not.toContain("Continue Watching MVP");
        });

        it("uses the new concise 'Continue Watching synced' log template", () => {
            // The source uses a template literal; match the exact text via regex to
            // sidestep the linter's template-curly rule (which would treat the
            // dollar-brace sequence as a placeholder in a normal string).
            const expected =
                /Continue Watching synced: \$\{data\.series_title\} \(\$\{Math\.round\(data\.percent_pos\)\}%\)/;
            expect(source).toMatch(expected);
        });

        it("no longer contains the old verbose 'Continue Watching synced' template with libraryItemId and MVP", () => {
            expect(source).not.toContain("Watched badges are not updated");
        });
    });

    describe("src/index.ts — formatStremioSkipReason progress-interval branch simplified", () => {
        const source = readSource("index.ts");

        it("uses the simplified 'progress interval' phrasing", () => {
            expect(source).toContain("progress interval (${");
        });

        it("no longer references 'STREMIO_PROGRESS_INTERVAL_MS (' in src/index.ts", () => {
            expect(source).not.toContain("STREMIO_PROGRESS_INTERVAL_MS (");
        });
    });
});
