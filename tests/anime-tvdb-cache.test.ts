import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tvdbSearchAnimeMock = vi.fn();
const tvdbGetAnimeByIdMock = vi.fn();
const tvdbGetEpisodeTitleMock = vi.fn();

const configMock = {
    metadataProvider: "tvdb",
    tvdb: {
        apiKey: "test-tvdb-key",
        language: "eng",
    },
    debug: false,
};

function normalizeTestTvdbLanguageCode(rawLanguage: string | null | undefined): string {
    const normalizedInput = (rawLanguage || "eng").trim().toLowerCase().replace(/_/g, "-");
    const mappedLanguages: Record<string, string> = {
        en: "eng",
        pt: "por",
        "pt-br": "por",
        ptbr: "por",
    };

    return mappedLanguages[normalizedInput] ?? normalizedInput;
}

vi.mock("../src/core/config", () => ({
    config: configMock,
}));

vi.mock("../src/providers/tvdb", () => ({
    TvdbProvider: class {
        readonly name = "tvdb";
        getEpisodeCacheKeyScope = () => normalizeTestTvdbLanguageCode(configMock.tvdb.language);
        searchAnime = tvdbSearchAnimeMock;
        getAnimeById = tvdbGetAnimeByIdMock;
        getEpisodeTitle = tvdbGetEpisodeTitleMock;
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

vi.mock("../src/providers/jikan", () => ({
    JikanProvider: class {
        readonly name = "jikan";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

vi.mock("../src/providers/kitsu", () => ({
    KitsuProvider: class {
        readonly name = "kitsu";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

vi.mock("../src/providers/anilist", () => ({
    AniListProvider: class {
        readonly name = "anilist";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

describe("Anime TVDB episode cache", () => {
    let testCwd: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        configMock.tvdb.language = "eng";
        tvdbSearchAnimeMock.mockReset();
        tvdbGetAnimeByIdMock.mockReset();
        tvdbGetEpisodeTitleMock.mockReset();

        testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-tvdb-episode-cache-"));
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(testCwd);
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        fs.rmSync(testCwd, { recursive: true, force: true });
    });

    it("does not reuse an English TVDB episode title after switching to Portuguese", async () => {
        tvdbSearchAnimeMock.mockResolvedValue({
            id: 377543,
            title: "Jujutsu Kaisen",
            title_english: "Jujutsu Kaisen",
            type: "series",
            coverImage: null,
        });
        tvdbGetAnimeByIdMock.mockResolvedValue({
            id: 377543,
            title_romaji: "Jujutsu Kaisen",
            title_english: "Jujutsu Kaisen",
            cover_url: null,
        });
        tvdbGetEpisodeTitleMock.mockResolvedValueOnce("Hidden Inventory").mockResolvedValueOnce("Inventário Oculto");

        const { getEpisodeTitle } = await import("../src/core/anime");

        await expect(getEpisodeTitle("Jujutsu Kaisen", 2, 1)).resolves.toBe("Hidden Inventory");

        configMock.tvdb.language = "pt";

        await expect(getEpisodeTitle("Jujutsu Kaisen", 2, 1)).resolves.toBe("Inventário Oculto");
        expect(tvdbGetEpisodeTitleMock).toHaveBeenCalledTimes(2);
    });
});
