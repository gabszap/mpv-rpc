import type { MpvData } from "../integrations/mpv";
import type { SimklIds, SimklPayload } from "./types";

function numericId(value: unknown): string | undefined {
    return /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : undefined;
}

export function resolveSimklIdentity(data: MpvData): { key: string; payload: SimklPayload } | null {
    const native: SimklIds = {};
    for (const name of ["mal", "anilist", "kitsu"] as const) {
        const id = numericId(data.anime_ids ? data.anime_ids[name] : name === "mal" ? data.mal_id : undefined);
        if (id) native[name] = id;
    }
    const western: SimklIds = {};
    if (/^tt\d+$/.test(data.imdb_id ?? "")) western.imdb = data.imdb_id;
    for (const name of ["tmdb", "tvdb"] as const) {
        const id = numericId(name === "tmdb" ? data.tmdb_id : data.tvdb_id);
        if (id) western[name] = id;
    }
    const fields = { title: data.series_title, ...(data.year ? { year: data.year } : {}) };
    let payload: SimklPayload;
    if (data.media_kind === "movie") {
        if (!Object.keys(western).length) return null;
        payload = { movie: { ids: western, ...fields } };
    } else if (!data.media_kind && Object.keys(native).length) {
        const episode = data.adjusted_episode ?? data.episode;
        if (episode !== null && (!Number.isSafeInteger(episode) || episode <= 0)) return null;
        if (episode === null && data.parsed_has_episode !== false) return null;
        payload = { anime: { ids: native, ...fields }, ...(episode !== null ? { episode: { number: episode } } : {}) };
    } else {
        if (!Object.keys(western).length || !Number.isSafeInteger(data.episode) || (data.episode ?? 0) <= 0)
            return null;
        const season = data.season ?? 1;
        if (!Number.isSafeInteger(season) || season < 0) return null;
        payload = { show: { ids: western, ...fields }, episode: { season, number: data.episode as number } };
    }
    const kind = payload.movie ? "movie" : payload.anime ? "anime" : "show";
    const ids = (payload.movie ?? payload.anime ?? payload.show)?.ids;
    return { key: JSON.stringify([kind, ids, payload.episode]), payload };
}
