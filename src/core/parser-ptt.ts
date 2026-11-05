/**
 * PTT adapter: loads the native TypeScript release-name parser
 * (`@aiostreams/release-parser`, formerly `@viren070/parse-torrent-title`)
 * and converts its result into a small structure the filename parser consumes.
 */

import type { ParsedResult } from "@aiostreams/release-parser";

export interface PttParsed {
    title: string;
    season: number | null;
    episode: number | null;
    episodeTitle: string | null;
    releaseGroup?: string;
    resolution?: string;
    source?: string;
    codec?: string;
}

type PttModule = { parseTorrentTitle: (title: string) => unknown };
type PttImporter = () => Promise<PttModule>;

// The package is ESM-only (its exports map has only an "import" condition) and this
// project compiles to CommonJS. With `module: CommonJS`, tsc rewrites a literal
// `import()` into `require()`, which cannot load the package on any Node version, so
// the dynamic import goes through `Function` to survive compilation.
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PttModule>;
const productionImporter: PttImporter = () => importEsm("@aiostreams/release-parser");

// Test runners that execute modules inside a vm context (Vitest) cannot run the
// Function-based import, so the test setup replaces the default importer.
let defaultImporter: PttImporter = productionImporter;
let importer: PttImporter = defaultImporter;
let loadedModule: PttModule | null = null;
let hasWarnedAboutLoadFailure = false;

/**
 * Load the PTT module once. Only a successful load is kept: a failed attempt is
 * not remembered, so a later call can still succeed. The warning is logged once.
 */
async function loadPtt(): Promise<PttModule | null> {
    if (loadedModule) {
        return loadedModule;
    }

    try {
        const imported = await importer();
        if (typeof imported?.parseTorrentTitle !== "function") {
            throw new Error("parseTorrentTitle is not exported");
        }
        loadedModule = imported;
        return loadedModule;
    } catch (error) {
        if (!hasWarnedAboutLoadFailure) {
            hasWarnedAboutLoadFailure = true;
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[Parser] Failed to load PTT (${reason}); using the regex fallback`);
        }
        return null;
    }
}

function firstNumber(values: unknown): number | null {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }

    const first: unknown = values[0];
    return typeof first === "number" && Number.isFinite(first) ? first : null;
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * True once the PTT module has been loaded. While it is false, a parse result came
 * from the regex fallbacks because PTT was unavailable, and must not be cached.
 */
export function isPttLoaded(): boolean {
    return loadedModule !== null;
}

/**
 * Parse a release name with PTT. Returns null when PTT cannot be loaded, throws
 * on this input, or finds no title.
 */
export async function parseWithPtt(filename: string): Promise<PttParsed | null> {
    const ptt = await loadPtt();
    if (!ptt) {
        return null;
    }

    let raw: Partial<ParsedResult> | null;
    try {
        raw = ptt.parseTorrentTitle(filename) as Partial<ParsedResult> | null;
    } catch {
        return null;
    }

    const title = readString(raw?.title);
    if (!raw || !title) {
        return null;
    }

    const parsed: PttParsed = {
        title,
        season: firstNumber(raw.seasons),
        episode: firstNumber(raw.episodes),
        episodeTitle: readString(raw.episodeTitle) ?? null,
    };

    const releaseGroup = readString(raw.group);
    const resolution = readString(raw.resolution);
    const source = readString(raw.quality);
    const codec = readString(raw.codec);
    if (releaseGroup) parsed.releaseGroup = releaseGroup;
    if (resolution) parsed.resolution = resolution;
    if (source) parsed.source = source;
    if (codec) parsed.codec = codec;

    return parsed;
}

/**
 * Test hook: replace the module loader. Passing null restores the default importer
 * and resets the loaded module and the one-time warning.
 */
export function setPttImporterForTests(replacement: PttImporter | null): void {
    importer = replacement ?? defaultImporter;
    loadedModule = null;
    hasWarnedAboutLoadFailure = false;
}

/**
 * Test hook: replace the default importer (the one restored by
 * `setPttImporterForTests(null)`). Passing null restores the production importer.
 */
export function setDefaultPttImporterForTests(replacement: PttImporter | null): void {
    defaultImporter = replacement ?? productionImporter;
    setPttImporterForTests(null);
}
