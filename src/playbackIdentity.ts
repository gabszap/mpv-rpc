/**
 * Playback Episode Identity
 *
 * Single internal model that captures everything a downstream integration
 * (Discord RPC, Trakt, Stremio, MAL, Auto-Fetch, logs) needs to consistently
 * describe the episode currently being played.
 *
 * Design notes:
 * - All fields beyond `title`, `normalizedTitle`, `parserSource`, and
 *   `confidence` are optional so a partially-parsed filename is still a
 *   valid identity.
 * - `parserSource` records where the structural data (title, season, episode)
 *   came from so we can blame or trust a downstream integration correctly.
 * - `confidence` is the parser's self-assessment and is independent from any
 *   provider match quality.
 * - Provider-resolved identifiers (`imdbId`, `malId`, `traktId`) live on the
 *   identity so a single value object can be passed across subsystems
 *   without re-resolving them.
 */

/**
 * Which subsystem produced the structural fields of an identity.
 *
 * - `guessit`     - GuessIt API or local CLI parser.
 * - `ptt`         - PTT/animetitle heuristics (reserved for future use).
 * - `fallback`    - Local regex fallback when GuessIt is unavailable.
 * - `stremioMeta` - Identity reconstructed from Stremio stream metadata.
 * - `manual`      - User-supplied via the console REPL override.
 */
export type ParserSource = "guessit" | "ptt" | "fallback" | "stremioMeta" | "manual";

/**
 * Parser's self-assessed confidence in the identity it produced.
 *
 * - `low`    - Fallback regex, or insufficient signals.
 * - `medium` - Partial GuessIt result or a single heuristic match.
 * - `high`   - Multiple agreeing signals, or authoritative source.
 */
export type Confidence = "low" | "medium" | "high";

/**
 * Canonical, internal representation of the episode currently being played.
 *
 * Treat instances of this type as immutable: produce new identities via
 * `createPlaybackIdentity` or `mergePlaybackIdentity` rather than mutating
 * fields in place.
 */
export type PlaybackEpisodeIdentity = {
    title: string;
    normalizedTitle: string;

    imdbId?: string;
    malId?: string;
    traktId?: string;

    season?: number;
    episode?: number;
    absoluteEpisode?: number;
    episodeTitle?: string;

    releaseGroup?: string;
    filename?: string;

    parserSource: ParserSource;
    confidence: Confidence;

    providerMetadataSource?: string;
};

/**
 * Manual diacritic map used as a fallback for characters that the runtime's
 * `String.prototype.normalize("NFD")` decomposition does not fold to ASCII
 * (for example, the Turkish dotted/dotless 'i', or some precomposed ligatures).
 *
 * Keyed by the precomposed character; the value is its ASCII replacement.
 */
const MANUAL_DIACRITIC_MAP: Readonly<Record<string, string>> = {
    ç: "c",
    Ç: "C",
    ñ: "n",
    Ñ: "N",
    ø: "o",
    Ø: "O",
    ß: "ss",
    æ: "ae",
    Æ: "AE",
    œ: "oe",
    Œ: "OE",
};

/**
 * Normalize a free-form title into a stable, comparable form.
 *
 * Steps (in order):
 * 1. Trim outer whitespace.
 * 2. Apply the small manual diacritic map (handles cases the NFD pass misses).
 * 3. NFD-decompose and strip combining marks so accented Latin letters fold
 *    to their ASCII base character (e.g. "é" -> "e", "ö" -> "o").
 * 4. Lowercase.
 * 5. Collapse runs of whitespace into a single space.
 * 6. Strip leading/trailing punctuation that is not a word character.
 *
 * @param title - The raw title to normalize. May be empty.
 * @returns A normalized, lowercased, diacritic-free string. Empty in, empty out.
 */
export function normalizeTitle(title: string): string {
    if (!title) {
        return "";
    }

    let working = title.trim();

    // Manual diacritic pass first: characters like "ñ" or "ç" survive NFD in
    // many runtimes, so handle them explicitly before the generic pass.
    let mapped = "";
    for (const ch of working) {
        mapped += MANUAL_DIACRITIC_MAP[ch] ?? ch;
    }
    working = mapped;

    // NFD: split "é" into "e" + combining acute, then drop the combining mark.
    working = working.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    working = working.toLowerCase();

    // Collapse any run of whitespace to a single space.
    working = working.replace(/\s+/g, " ").trim();

    // Strip leading/trailing punctuation that is not a word character so
    // "  - Foo! " becomes "foo" instead of "- foo!".
    working = working.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

    return working;
}

/**
 * Build a new `PlaybackEpisodeIdentity` from a partial input.
 *
 * Required: `title`. Everything else is optional and is preserved as-is when
 * provided. Missing structural fields receive safe defaults:
 * - `parserSource` defaults to `"fallback"` (matches the lowest confidence).
 * - `confidence` defaults to `"low"`.
 * - `normalizedTitle` is recomputed from the input title unless the caller
 *   already provided one.
 *
 * @param input - Partial identity; `title` is the only required field.
 * @returns A complete, fully-typed `PlaybackEpisodeIdentity`.
 */
export function createPlaybackIdentity(
    input: Partial<PlaybackEpisodeIdentity> & { title: string },
): PlaybackEpisodeIdentity {
    const normalizedTitle = input.normalizedTitle ?? normalizeTitle(input.title);

    return {
        title: input.title,
        normalizedTitle,
        imdbId: input.imdbId,
        malId: input.malId,
        traktId: input.traktId,
        season: input.season,
        episode: input.episode,
        absoluteEpisode: input.absoluteEpisode,
        episodeTitle: input.episodeTitle,
        releaseGroup: input.releaseGroup,
        filename: input.filename,
        parserSource: input.parserSource ?? "fallback",
        confidence: input.confidence ?? "low",
        providerMetadataSource: input.providerMetadataSource,
    };
}

/**
 * Merge two identities, with the `overlay` winning for any field it sets to
 * a defined (i.e. non-`undefined`) value.
 *
 * Useful when a higher-confidence source (e.g. Stremio metadata, manual
 * override) needs to enrich a base identity without losing the data we
 * already had.
 *
 * Side effect: when the overlay changes `title`, `normalizedTitle` is
 * recomputed from the new title unless the overlay also supplied an explicit
 * `normalizedTitle`.
 *
 * @param base - The starting identity. Treated as the source of truth for
 *               any field the overlay does not set.
 * @param overlay - Partial identity whose defined fields override `base`.
 * @returns A new `PlaybackEpisodeIdentity` (no mutation of the inputs).
 */
export function mergePlaybackIdentity(
    base: PlaybackEpisodeIdentity,
    overlay: Partial<PlaybackEpisodeIdentity>,
): PlaybackEpisodeIdentity {
    const titleChanged = overlay.title !== undefined && overlay.title !== base.title;
    const nextTitle = overlay.title ?? base.title;
    const nextNormalized = overlay.normalizedTitle ?? (titleChanged ? normalizeTitle(nextTitle) : base.normalizedTitle);

    return {
        title: nextTitle,
        normalizedTitle: nextNormalized,
        imdbId: overlay.imdbId ?? base.imdbId,
        malId: overlay.malId ?? base.malId,
        traktId: overlay.traktId ?? base.traktId,
        season: overlay.season ?? base.season,
        episode: overlay.episode ?? base.episode,
        absoluteEpisode: overlay.absoluteEpisode ?? base.absoluteEpisode,
        episodeTitle: overlay.episodeTitle ?? base.episodeTitle,
        releaseGroup: overlay.releaseGroup ?? base.releaseGroup,
        filename: overlay.filename ?? base.filename,
        parserSource: overlay.parserSource ?? base.parserSource,
        confidence: overlay.confidence ?? base.confidence,
        providerMetadataSource: overlay.providerMetadataSource ?? base.providerMetadataSource,
    };
}

/**
 * Decide whether an identity carries enough information to safely trigger a
 * downstream sync (Trakt scrobble, MAL update, etc.).
 *
 * All three conditions must hold:
 * 1. `title` is a non-empty string, is not the literal `"N/A"`, and contains
 *    at least two word characters. This rules out empty parses, the
 *    not-a-title sentinel, and one-letter false positives.
 * 2. We have a usable episode number. A positive `episode` counts; when
 *    `episode` is missing, a positive `absoluteEpisode` (typical for anime)
 *    is accepted.
 * 3. At least one external identifier (`imdbId`, `malId`, or `traktId`) is
 *    present, so the sync target is unambiguous.
 *
 * Pure function. No console output, no side effects.
 *
 * @param identity - The identity to validate.
 * @returns `true` only if all three conditions above hold.
 */
export function isSafeForSync(identity: PlaybackEpisodeIdentity): boolean {
    const title = identity.title;
    if (!title || title === "N/A") {
        return false;
    }
    // Require at least two word characters so single-letter titles can't slip through.
    const wordChars = title.match(/\w/g);
    if (!wordChars || wordChars.length < 2) {
        return false;
    }

    const episode = identity.episode;
    const absoluteEpisode = identity.absoluteEpisode;
    const hasEpisode =
        (typeof episode === "number" && Number.isInteger(episode) && episode > 0) ||
        (typeof absoluteEpisode === "number" && Number.isInteger(absoluteEpisode) && absoluteEpisode > 0);
    if (!hasEpisode) {
        return false;
    }

    if (!identity.imdbId && !identity.malId && !identity.traktId) {
        return false;
    }

    return true;
}
