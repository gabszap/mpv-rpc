import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const primaryJikanSearchAnimeMock = vi.fn();
const primaryJikanGetAnimeByIdMock = vi.fn();
const primaryJikanGetEpisodeTitleMock = vi.fn();

const fallbackKitsuSearchAnimeMock = vi.fn();
const fallbackKitsuGetEpisodeTitleMock = vi.fn();

vi.mock("../src/config", () => ({
    config: {
        metadataProvider: "mal",
        tvdb: {
            apiKey: "",
        },
        debug: false,
    },
}));

vi.mock("../src/providers/jikan", () => ({
    JikanProvider: class {
        readonly name = "jikan";
        searchAnime = primaryJikanSearchAnimeMock;
        getAnimeById = primaryJikanGetAnimeByIdMock;
        getEpisodeTitle = primaryJikanGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
    },
}));

vi.mock("../src/providers/kitsu", () => ({
    KitsuProvider: class {
        readonly name = "kitsu";
        searchAnime = fallbackKitsuSearchAnimeMock;
        getAnimeById = vi.fn();
        getEpisodeTitle = fallbackKitsuGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
    },
}));

vi.mock("../src/providers/anilist", () => ({
    AniListProvider: class {
        readonly name = "anilist";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
    },
}));

vi.mock("../src/providers/tvdb", () => ({
    TvdbProvider: class {
        readonly name = "tvdb";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
    },
}));

describe("Anime module with invalid metadata provider config", () => {
    let testCwd: string;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        primaryJikanSearchAnimeMock.mockReset();
        primaryJikanGetAnimeByIdMock.mockReset();
        primaryJikanGetEpisodeTitleMock.mockReset();
        fallbackKitsuSearchAnimeMock.mockReset();
        fallbackKitsuGetEpisodeTitleMock.mockReset();

        testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-anime-invalid-provider-"));
        vi.spyOn(process, "cwd").mockReturnValue(testCwd);
    });

    afterEach(() => {
        fs.rmSync(testCwd, { recursive: true, force: true });
    });

    it("uses jikan as effective primary provider and never retries jikan as fallback", async () => {
        primaryJikanSearchAnimeMock.mockResolvedValue({
            id: 101,
            title: "Attack on Titan",
            title_english: "Attack on Titan",
            type: "TV",
            coverImage: null,
        });
        primaryJikanGetAnimeByIdMock.mockResolvedValue({
            id: 101,
            mal_id: 101,
            title_romaji: "Shingeki no Kyojin",
            title_english: "Attack on Titan",
            cover_url: null,
        });
        primaryJikanGetEpisodeTitleMock.mockResolvedValue(null);

        fallbackKitsuSearchAnimeMock.mockResolvedValue({
            id: 202,
            title: "Attack on Titan",
            title_english: "Attack on Titan",
            type: "TV",
            coverImage: null,
        });
        fallbackKitsuGetEpisodeTitleMock.mockResolvedValue("To You, in 2000 Years");

        const { getEpisodeTitle, providerName } = await import("../src/anime");
        const title = await getEpisodeTitle("Attack on Titan", 1, 1);

        expect(providerName).toBe("jikan");
        expect(title).toBe("To You, in 2000 Years");
        expect(primaryJikanSearchAnimeMock).toHaveBeenCalledTimes(1);
        expect(fallbackKitsuSearchAnimeMock).toHaveBeenCalledTimes(1);

        const cachePath = path.join(testCwd, ".anime_cache", "anime_cache.json");
        const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, unknown>;
        expect(cacheData["jikan:attack on titan:1"]).toBeDefined();
        expect(cacheData["mal:attack on titan:1"]).toBeUndefined();
    });
});
