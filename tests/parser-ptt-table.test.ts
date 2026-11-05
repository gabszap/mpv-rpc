import * as child_process from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFilename } from "../src/core/parser";
import { setPttImporterForTests } from "../src/core/parser-ptt";

vi.mock("node:child_process", async () => {
    return {
        execFile: vi.fn(),
    };
});

// No GuessIt answer is available: every row below must be resolved by PTT alone.
vi.mock("axios", async () => {
    const post = vi.fn().mockRejectedValue(new Error("GuessIt API mocked to fail"));
    return {
        default: { post },
        post,
    };
});

type Row = {
    file: string;
    title: string;
    season: number | null;
    episode: number | null;
    group?: string;
    episodeTitle?: string;
};

// Expected values were checked by hand against the PTT output. Several rows are
// names the GuessIt API got wrong (title truncated, season left in the title,
// episode read from the title).
const ROWS: Row[] = [
    {
        file: "[Erai-raws] Oshi no Ko 3rd Season - 09 [1080p][Multiple Subtitle][ABCD1234].mkv",
        title: "Oshi no Ko",
        season: 3,
        episode: 9,
        group: "Erai-raws",
    },
    {
        file: "[SubsPlease] Sousou no Frieren - 12 (1080p) [A1B2C3D4].mkv",
        title: "Sousou no Frieren",
        season: null,
        episode: 12,
        group: "SubsPlease",
    },
    {
        file: "[Judas] Dr. Stone - S04E35 [1080p][HEVC x265 10bit][Multi-Subs].mkv",
        title: "Dr Stone",
        season: 4,
        episode: 35,
        group: "Judas",
    },
    {
        file: "[Erai-raws] Dr Stone - New World - 02 [1080p][HEVC].mkv",
        title: "Dr Stone - New World",
        season: null,
        episode: 2,
    },
    { file: "Dr Stone - New World - E02.mkv", title: "Dr Stone - New World", season: null, episode: 2 },
    {
        file: "[Erai-raws] Dr Stone - Science Future Part 3 - 06.mkv",
        title: "Dr Stone - Science Future Part 3",
        season: null,
        episode: 6,
    },
    {
        file: "[Erai-raws] Kimetsu no Yaiba - Katanakaji no Sato-hen - 03 [1080p].mkv",
        title: "Kimetsu no Yaiba - Katanakaji no Sato-hen",
        season: null,
        episode: 3,
    },
    {
        file: "[Erai-raws] Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen - 05 [1080p].mkv",
        title: "Jujutsu Kaisen - Shimetsu Kaiyuu - Zenpen",
        season: null,
        episode: 5,
    },
    { file: "[Group] 86 - Eighty Six - 11 [1080p].mkv", title: "86 - Eighty Six", season: null, episode: 11 },
    {
        file: "[Trix] Oshi no Ko S03E09 [WEBRip 1080p AV1] (Multi Subs).mkv",
        title: "Oshi no Ko",
        season: 3,
        episode: 9,
        group: "Trix",
    },
    {
        file: "OSHI.NO.KO.S03E10.Private.Audition.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv",
        title: "OSHI NO KO",
        season: 3,
        episode: 10,
        group: "VARYG",
    },
    { file: "[Group] Fate Zero 2nd Season - 03 [1080p].mkv", title: "Fate Zero", season: 2, episode: 3 },
    {
        file: "[Group] Re Zero kara Hajimeru Isekai Seikatsu 3rd Season - 05v2 [720p].mkv",
        title: "Re Zero kara Hajimeru Isekai Seikatsu",
        season: 3,
        episode: 5,
    },
    {
        file: "Dr.STONE.S04E33.Wanting.Everything.1080p.CR.WEB-DL.MULTi.AAC2.0.H.264-VARYG.mkv",
        title: "Dr STONE",
        season: 4,
        episode: 33,
        episodeTitle: "Wanting Everything",
    },
    { file: "[Group] One Piece - 1090 [1080p].mkv", title: "One Piece", season: null, episode: 1090 },
    { file: "One Piece - Episode 1000.mkv", title: "One Piece", season: null, episode: 1000 },
    { file: "[Group] Naruto Shippuuden - 220 [BD 1080p].mkv", title: "Naruto Shippuuden", season: null, episode: 220 },
    {
        file: "[ToonsHub] Attack on Titan The Final Season Part 2 - 78.mkv",
        title: "Attack on Titan The Final Season Part 2",
        season: null,
        episode: 78,
    },
    {
        file: "Steel.Ball.Run.JoJos.Bizarre.Adventure.S06E01.1080p.WEB-DL.mkv",
        title: "Steel Ball Run JoJos Bizarre Adventure",
        season: 6,
        episode: 1,
    },
    {
        file: "Frieren.Beyond.Journeys.End.S01E12.JPN.WEB-DL.1080p.mkv",
        title: "Frieren Beyond Journeys End",
        season: 1,
        episode: 12,
    },
    {
        file: "Rick.and.Morty.S01E02.1080p.BluRay.x264-GRP.mkv",
        title: "Rick and Morty",
        season: 1,
        episode: 2,
        group: "GRP",
    },
    {
        file: "[DB] Rick and Morty - S01E02 [1080p][HEVC].mkv",
        title: "Rick and Morty",
        season: 1,
        episode: 2,
        group: "DB",
    },
    { file: "My_Hero_Academia_S03E12.mp4", title: "My Hero Academia", season: 3, episode: 12 },
    { file: "[Group] Bocchi the Rock! - 05 [1080p].mkv", title: "Bocchi the Rock!", season: null, episode: 5 },
    {
        file: "[Group] Kaguya-sama wa Kokurasetai - Ultra Romantic - 11 [1080p].mkv",
        title: "Kaguya-sama wa Kokurasetai - Ultra Romantic",
        season: null,
        episode: 11,
    },
    // No episode marker: must be accepted, not rejected for lacking an episode.
    { file: "Movie.Name.2020.1080p.BluRay.x264-YIFY.mkv", title: "Movie Name", season: null, episode: null },
    { file: "Example Movie.mkv", title: "Example Movie", season: null, episode: null },
];

beforeEach(() => {
    vi.mocked(child_process.execFile).mockImplementation(((...args: unknown[]) => {
        const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
        callback(new Error("guessit not installed"), "", "");
        return {} as never;
    }) as never);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    setPttImporterForTests(null);
    vi.restoreAllMocks();
});

describe("PTT acceptance table", () => {
    it.each(ROWS)("parses $file", async (row) => {
        const result = await parseFilename(row.file);

        expect(result.parseMethod).toBe("ptt");
        expect(result.series_title).toBe(row.title);
        expect(result.season).toBe(row.season);
        expect(result.episode).toBe(row.episode);
        if (row.group) {
            expect(result.releaseGroup).toBe(row.group);
        }
        if (row.episodeTitle) {
            expect(result.episode_title).toBe(row.episodeTitle);
        }
    });
});
