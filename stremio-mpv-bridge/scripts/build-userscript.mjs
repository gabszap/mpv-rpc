import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const USERSCRIPT_HEADER_PATH = path.join(bridgeDir, "userscript", "header.txt");
export const USERSCRIPT_ENTRY_PATH = path.join(bridgeDir, "userscript", "src", "main.js");
export const USERSCRIPT_OUTPUT_PATH = path.join(bridgeDir, "stremio-mpv.user.js");

/**
 * Bundles userscript/src/** into the single-file userscript that Violentmonkey
 * installs. The metadata block comes from userscript/header.txt, verbatim.
 */
export async function buildUserscript() {
    const header = (await readFile(USERSCRIPT_HEADER_PATH, "utf8")).replace(/\s+$/, "");
    const result = await build({
        entryPoints: [USERSCRIPT_ENTRY_PATH],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2020",
        charset: "utf8",
        legalComments: "none",
        write: false,
        tsconfigRaw: "{}",
        logLevel: "silent",
    });
    return `${header}\n\n${result.outputFiles[0].text}`;
}

async function main() {
    const output = await buildUserscript();
    if (process.argv.includes("--check")) {
        const current = await readFile(USERSCRIPT_OUTPUT_PATH, "utf8");
        if (current !== output) {
            console.error("stremio-mpv.user.js is out of date. Run: npm run build:userscript");
            process.exit(1);
        }
        console.log("stremio-mpv.user.js is up to date.");
        return;
    }
    await writeFile(USERSCRIPT_OUTPUT_PATH, output, "utf8");
    console.log(`Wrote ${path.relative(process.cwd(), USERSCRIPT_OUTPUT_PATH)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
