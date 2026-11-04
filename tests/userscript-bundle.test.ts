import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM build script without type declarations
import { buildUserscript, USERSCRIPT_OUTPUT_PATH } from "../stremio-mpv-bridge/scripts/build-userscript.mjs";

describe("userscript bundle", () => {
    it("keeps the committed single-file userscript in sync with userscript/src", async () => {
        const built: string = await buildUserscript();
        const committed = await readFile(USERSCRIPT_OUTPUT_PATH, "utf8");
        expect(committed, "run `npm run build:userscript` and commit the result").toBe(built);
    });

    it("starts with a Violentmonkey metadata block and has no module syntax", async () => {
        const built: string = await buildUserscript();
        expect(built.startsWith("// ==UserScript==")).toBe(true);
        expect(built).toContain("// ==/UserScript==");
        expect(built).toMatch(/^\/\/ @version\s+\d+\.\d+\.\d+/m);
        expect(built).not.toMatch(/^\s*(import|export)\s/m);
    });
});
