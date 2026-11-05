import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("PTT production loader", () => {
    // Vitest runs modules inside a vm context, where the Function-based import used in
    // production cannot work, so the unit tests inject a different importer. This test
    // runs the production mechanism in plain Node against the real package.
    it("loads the real package through an indirect dynamic import in plain Node", () => {
        const output = execFileSync(
            process.execPath,
            [
                "-e",
                "new Function('s', 'return import(s)')('@aiostreams/release-parser').then(m => console.log(typeof m.parseTorrentTitle))",
            ],
            { cwd: process.cwd(), encoding: "utf8" },
        );

        expect(output.trim()).toBe("function");
    });
});
