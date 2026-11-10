import { expect, it } from "vitest";
import type { MpvData } from "../src/integrations/mpv";
import { resolveSimklIdentity } from "../src/simkl-sync/identity";

function data(fields: Partial<MpvData>): MpvData {
    return {
        series_title: "Title",
        episode: null,
        season: null,
        adjusted_episode: null,
        mal_id: null,
        ...fields,
    } as MpvData;
}
it("identifies movies without an episode", () => {
    expect(resolveSimklIdentity(data({ media_kind: "movie", tmdb_id: 10, year: 2020 }))?.payload).toEqual({
        movie: { ids: { tmdb: "10" }, title: "Title", year: 2020 },
    });
});
it("uses a series ID and defaults its missing season to one", () => {
    expect(resolveSimklIdentity(data({ media_kind: "series", tmdb_id: 20, episode: 3 }))?.payload).toEqual({
        show: { ids: { tmdb: "20" }, title: "Title" },
        episode: { season: 1, number: 3 },
    });
});
it("keeps native cour IDs separate from parent series and uses the adjusted episode", () => {
    expect(
        resolveSimklIdentity(
            data({
                mal_id: 100,
                anime_ids: { mal: "100", anilist: "200" },
                imdb_id: "tt12345",
                season: 4,
                episode: 10,
                adjusted_episode: 4,
            }),
        )?.payload,
    ).toEqual({ anime: { ids: { mal: "100", anilist: "200" }, title: "Title" }, episode: { number: 4 } });
});
it("retains western numbering for a native-ID-less anime", () => {
    expect(
        resolveSimklIdentity(data({ imdb_id: "tt12345", season: 4, episode: 10, adjusted_episode: 4 }))?.payload,
    ).toMatchObject({ show: { ids: { imdb: "tt12345" } }, episode: { season: 4, number: 10 } });
});
it("accepts an explicitly episode-less native anime", () => {
    expect(resolveSimklIdentity(data({ mal_id: 10, parsed_has_episode: false }))?.payload).toEqual({
        anime: { ids: { mal: "10" }, title: "Title" },
    });
});
it.each([
    true,
    undefined,
])("does not turn a failed/unknown episode parse into an anime movie (%s)", (parsed_has_episode) => {
    expect(resolveSimklIdentity(data({ mal_id: 10, parsed_has_episode }))).toBeNull();
});
it.each([
    { media_kind: "series", tmdb_id: 1 },
    { mal_id: -10, episode: 2 },
    { imdb_id: "bad-id", episode: 2 },
    { mal_id: 1, episode: 2.5 },
    { media_kind: "movie", tmdb_id: Number.NaN },
])("rejects incomplete or malformed identity %j", (fields) => {
    expect(resolveSimklIdentity(data(fields as Partial<MpvData>))).toBeNull();
});
it("keeps the key independent of translated titles", () => {
    const a = data({ media_kind: "series", tmdb_id: 10, episode: 1 });
    expect(resolveSimklIdentity(a)?.key).toBe(resolveSimklIdentity({ ...a, series_title: "Translated" })?.key);
});
it("does not supplement a resolved native cour with a parent MAL id", () => {
    expect(
        resolveSimklIdentity(data({ anime_ids: { anilist: "200" }, mal_id: 10, adjusted_episode: 4, episode: 10 }))
            ?.payload.anime?.ids,
    ).toEqual({ anilist: "200" });
});
