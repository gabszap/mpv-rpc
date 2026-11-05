import { type MediaInfo, type MediaKind, type MediaProvider, MediaProviderError } from "../providers/media-types";
import { TmdbProvider } from "../providers/tmdb";
import { config } from "./config";
import { normalizeTitleTokens } from "./title-tokens";

const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const MIN_TITLE_OVERLAP = 0.8;
const MAX_YEAR_DIFFERENCE = 1;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;

export interface ResolveMediaInput {
    title: string;
    kindHint: MediaKind | null;
    season: number | null;
    episode: number | null;
    year: number | null;
    imdbId: string | null;
}

export interface ResolvedMedia {
    info: MediaInfo;
    coverUrl: string | null;
    episodeTitle: string | null;
}

interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<unknown>>();
let providerOverride: MediaProvider | null = null;
let defaultProvider: TmdbProvider | null = null;
let authDisabled = false;
let transientCooldownUntil = 0;
let lastTransientWarningAt = 0;

function getProvider(): MediaProvider {
    if (providerOverride) return providerOverride;
    if (!defaultProvider) {
        defaultProvider = new TmdbProvider({
            getApiKey: () => config.tmdb.apiKey,
            getLanguage: () => config.tmdb.language,
        });
    }
    return defaultProvider;
}

/** True when a TMDb key is set and it has not been rejected since the last reload. */
export function isMediaProviderConfigured(): boolean {
    return config.tmdb.apiKey.length > 0 && !authDisabled;
}

/** Re-enables the provider after an auth failure (called by the `.reload` command). */
export function reloadMediaProvider(): void {
    authDisabled = false;
    transientCooldownUntil = 0;
    defaultProvider = null;
}

export function setMediaProviderForTests(provider: MediaProvider | null): void {
    providerOverride = provider;
}

export function clearMediaCacheForTests(): void {
    cache.clear();
    pending.clear();
    transientCooldownUntil = 0;
    lastTransientWarningAt = 0;
}

/**
 * Runs `load` once per key, caching the outcome (24 h for a value, 10 min for `null`) and sharing
 * the pending promise between concurrent callers. A rejection is never cached.
 */
async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T | null;

    const inFlight = pending.get(key);
    if (inFlight) return inFlight as Promise<T | null>;

    const promise = load()
        .then((value) => {
            cache.set(key, { value, expiresAt: Date.now() + (value === null ? MISS_TTL_MS : HIT_TTL_MS) });
            return value;
        })
        .finally(() => {
            pending.delete(key);
        });
    pending.set(key, promise);
    return promise;
}

function titlesMatch(fileTitle: string, info: MediaInfo, yearConfirmed: boolean): boolean {
    const wanted = normalizeTitleTokens(fileTitle);
    if (wanted.length === 0) return false;
    const candidates = [info.title, info.originalTitle].filter((value): value is string => !!value);
    return candidates.some((candidate) => {
        const tokens = normalizeTitleTokens(candidate);
        if (tokens.length === 0) return false;
        const candidateSet = new Set(tokens);
        // A one word title ("Dune", "It") overlaps fully with any longer title that contains it, so without a
        // matching year it must equal the candidate exactly.
        if (!yearConfirmed && Math.min(new Set(wanted).size, candidateSet.size) === 1) {
            return candidateSet.size === new Set(wanted).size && wanted.every((token) => candidateSet.has(token));
        }
        const shared = new Set(wanted.filter((token) => candidateSet.has(token))).size;
        return shared / Math.min(new Set(wanted).size, candidateSet.size) >= MIN_TITLE_OVERLAP;
    });
}

function yearsMatch(fileYear: number | null, info: MediaInfo): boolean {
    if (fileYear === null || info.year === null) return true;
    return Math.abs(fileYear - info.year) <= MAX_YEAR_DIFFERENCE;
}

function warnTransient(message: string): void {
    const now = Date.now();
    if (now - lastTransientWarningAt < TRANSIENT_COOLDOWN_MS) return;
    lastTransientWarningAt = now;
    console.warn(message);
}

function handleFailure(error: unknown): void {
    if (error instanceof MediaProviderError && error.reason === "auth") {
        if (!authDisabled) {
            authDisabled = true;
            console.warn("[Media] TMDb rejected the API key; movie and series metadata disabled until .reload");
        }
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    warnTransient(`[Media] TMDb lookup failed (${message}); will retry later`);
}

async function lookupInfo(
    provider: MediaProvider,
    input: ResolveMediaInput,
    kind: MediaKind,
): Promise<MediaInfo | null> {
    const language = config.tmdb.language;
    if (input.imdbId) {
        const key = `info|imdb|${input.imdbId}|${input.kindHint ?? ""}|${language}`;
        return cached(key, () => provider.findByImdbId(input.imdbId as string, input.kindHint ?? undefined));
    }

    const normalized = normalizeTitleTokens(input.title).join(" ");
    if (normalized.length === 0) return null;
    const key = `info|${kind}|${normalized}|${input.year ?? ""}|${language}`;
    return cached(key, async () => {
        const found = await provider.search(input.title, kind, input.year);
        if (!found) return null;
        const yearConfirmed = input.year !== null && found.year !== null && yearsMatch(input.year, found);
        return titlesMatch(input.title, found, yearConfirmed) && yearsMatch(input.year, found) ? found : null;
    });
}

/** Season poster and episode name, each cached; a failed lookup only loses that piece. */
async function lookupDetail(key: string, load: () => Promise<string | null>): Promise<string | null> {
    try {
        return await cached(key, load);
    } catch (error) {
        handleFailure(error);
        return null;
    }
}

export async function resolveMedia(input: ResolveMediaInput): Promise<ResolvedMedia | null> {
    if (!isMediaProviderConfigured()) return null;
    if (Date.now() < transientCooldownUntil) return null;

    const provider = getProvider();
    const kind: MediaKind = input.kindHint ?? (input.season !== null || input.episode !== null ? "series" : "movie");

    let info: MediaInfo | null;
    try {
        info = await lookupInfo(provider, input, kind);
    } catch (error) {
        handleFailure(error);
        // A failing TMDb is not asked again for a minute, so an outage costs one wait instead of one per update
        if (!(error instanceof MediaProviderError && error.reason === "auth")) {
            transientCooldownUntil = Date.now() + TRANSIENT_COOLDOWN_MS;
        }
        return null;
    }
    if (!info) return null;

    if (info.kind !== "series") {
        return { info, coverUrl: info.posterUrl, episodeTitle: null };
    }

    const language = config.tmdb.language;
    const season = input.season ?? (input.episode !== null ? 1 : null);
    const [seasonPoster, episodeTitle] = await Promise.all([
        season === null
            ? null
            : lookupDetail(`poster|${info.tmdbId}|${season}|${language}`, () =>
                  provider.getSeasonPosterUrl(info.tmdbId, season),
              ),
        season === null || input.episode === null
            ? null
            : lookupDetail(`episode|${info.tmdbId}|${season}|${input.episode}|${language}`, () =>
                  provider.getEpisodeTitle(info.tmdbId, season, input.episode as number),
              ),
    ]);

    return { info, coverUrl: seasonPoster ?? info.posterUrl, episodeTitle };
}
