import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const primaryJikanGetSequelInfoMock = vi.fn();
const primaryJikanGetAnimeByIdMock = vi.fn();
const primaryJikanSearchAnimeMock = vi.fn();
const primaryJikanGetEpisodeTitleMock = vi.fn();
const primaryJikanFindSeasonAnimeMock = vi.fn();

const kitsuGetSequelInfoMock = vi.fn();
const kitsuGetAnimeByIdMock = vi.fn();

vi.mock("../src/config", () => ({
    config: {
        metadataProvider: "jikan",
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
        findSeasonAnime = primaryJikanFindSeasonAnimeMock;
        getSequelInfo = primaryJikanGetSequelInfoMock;
    },
}));

vi.mock("../src/providers/kitsu", () => ({
    KitsuProvider: class {
        readonly name = "kitsu";
        searchAnime = vi.fn();
        getAnimeById = kitsuGetAnimeByIdMock;
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
        getSequelInfo = kitsuGetSequelInfoMock;
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

vi.mock("../src/providers/tvdb", () => ({
    TvdbProvider: class {
        readonly name = "tvdb";
        searchAnime = vi.fn();
        getAnimeById = vi.fn();
        getEpisodeTitle = vi.fn();
        findSeasonAnime = vi.fn();
        getSequelInfo = vi.fn();
    },
}));

describe("resolveOverflowEpisode", () => {
    let testCwd: string;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        primaryJikanGetSequelInfoMock.mockReset();
        primaryJikanGetAnimeByIdMock.mockReset();
        primaryJikanSearchAnimeMock.mockReset();
        primaryJikanGetEpisodeTitleMock.mockReset();
        primaryJikanFindSeasonAnimeMock.mockReset();
        kitsuGetSequelInfoMock.mockReset();
        kitsuGetAnimeByIdMock.mockReset();

        testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-overflow-test-"));
        vi.spyOn(process, "cwd").mockReturnValue(testCwd);
    });

    afterEach(() => {
        fs.rmSync(testCwd, { recursive: true, force: true });
    });

    it("returns null when episode fits within total_episodes", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
            total_episodes: 11,
        };

        const result = await resolveOverflowEpisode(animeInfo, 5, 1);

        expect(result).toBeNull();
        expect(primaryJikanGetSequelInfoMock).not.toHaveBeenCalled();
    });

    it("returns null when total_episodes is undefined", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
        };

        const result = await resolveOverflowEpisode(animeInfo, 12, 1);

        expect(result).toBeNull();
        expect(primaryJikanGetSequelInfoMock).not.toHaveBeenCalled();
    });

    it("returns null when total_episodes is 0", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
            total_episodes: 0,
        };

        const result = await resolveOverflowEpisode(animeInfo, 12, 1);

        expect(result).toBeNull();
        expect(primaryJikanGetSequelInfoMock).not.toHaveBeenCalled();
    });

    it("resolves single cour overflow: EP 12 of 11-episode anime → sequel EP 1", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone: New World",
            title_english: "Dr. STONE: New World",
            cover_url: null,
            total_episodes: 11,
        };

        primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
            id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            total_episodes: 11,
            is_split_cour: true,
        });

        primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
            id: 2,
            mal_id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            cover_url: null,
            total_episodes: 11,
        });

        const result = await resolveOverflowEpisode(animeInfo, 12, 2);

        expect(result).not.toBeNull();
        expect(result!.animeInfo.id).toBe(2);
        expect(result!.adjustedEpisode).toBe(1);
        expect(result!.originalEpisode).toBe(12);
        expect(result!.overflowDepth).toBe(1);
    });

    it("resolves multi-cour overflow: EP 23 across 11+11 episode cours → third cour EP 1", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone",
            title_english: "Dr. STONE",
            cover_url: null,
            total_episodes: 11,
        };

        // First sequel: 11 episodes (EP 12-22)
        primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
            id: 2,
            title_romaji: "Dr Stone: Stone Wars",
            title_english: "Dr. STONE: Stone Wars",
            total_episodes: 11,
            is_split_cour: true,
        });

        primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
            id: 2,
            mal_id: 2,
            title_romaji: "Dr Stone: Stone Wars",
            title_english: "Dr. STONE: Stone Wars",
            cover_url: null,
            total_episodes: 11,
        });

        // Second sequel: 12 episodes (EP 23-34)
        primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
            id: 3,
            title_romaji: "Dr Stone: New World",
            title_english: "Dr. STONE: New World",
            total_episodes: 12,
            is_split_cour: false,
        });

        primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
            id: 3,
            mal_id: 3,
            title_romaji: "Dr Stone: New World",
            title_english: "Dr. STONE: New World",
            cover_url: null,
            total_episodes: 12,
        });

        const result = await resolveOverflowEpisode(animeInfo, 23, 1);

        expect(result).not.toBeNull();
        expect(result!.animeInfo.id).toBe(3);
        expect(result!.adjustedEpisode).toBe(1);
        expect(result!.originalEpisode).toBe(23);
        expect(result!.overflowDepth).toBe(2);
    });

    it("stops when cycle detected in sequel chain", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Loop Anime",
            title_english: "Loop Anime",
            cover_url: null,
            total_episodes: 11,
        };

        // Sequel of anime 1 is anime 2
        primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
            id: 2,
            title_romaji: "Loop Anime 2",
            title_english: "Loop Anime 2",
            total_episodes: 11,
            is_split_cour: true,
        });

        primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
            id: 2,
            mal_id: 2,
            title_romaji: "Loop Anime 2",
            title_english: "Loop Anime 2",
            cover_url: null,
            total_episodes: 11,
        });

        // Sequel of anime 2 loops back to anime 1 (cycle)
        primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
            id: 1,
            title_romaji: "Loop Anime",
            title_english: "Loop Anime",
            total_episodes: 11,
            is_split_cour: true,
        });

        primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
            id: 1,
            mal_id: 1,
            title_romaji: "Loop Anime",
            title_english: "Loop Anime",
            cover_url: null,
            total_episodes: 11,
        });

        // EP 35 → subtract 11 (anime 1) = 24 remaining, depth 1
        // → subtract 11 (anime 2) = 13 remaining, depth 2
        // → currentAnime cycles back to id:1, remaining(13) > total(11)
        // → cycle detected at id:1, breaks out of loop
        // Best guess: anime 1 (cycled back), EP 13, depth 2
        const result = await resolveOverflowEpisode(animeInfo, 35, 1);

        expect(result).not.toBeNull();
        expect(result!.animeInfo.id).toBe(1);
        expect(result!.adjustedEpisode).toBe(13);
        expect(result!.originalEpisode).toBe(35);
        expect(result!.overflowDepth).toBe(2);
    });

    it("stops after max depth of 5", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Long Chain Anime",
            title_english: "Long Chain Anime",
            cover_url: null,
            total_episodes: 10,
        };

        // Create a chain of 6 sequels (depth 0→1→2→3→4→5→6)
        // But max depth is 5, so it should stop at depth 5
        for (let i = 1; i <= 6; i++) {
            primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
                id: i + 1,
                title_romaji: `Long Chain Anime ${i + 1}`,
                title_english: `Long Chain Anime ${i + 1}`,
                total_episodes: 10,
                is_split_cour: true,
            });

            primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
                id: i + 1,
                mal_id: i + 1,
                title_romaji: `Long Chain Anime ${i + 1}`,
                title_english: `Long Chain Anime ${i + 1}`,
                cover_url: null,
                total_episodes: 10,
            });
        }

        // EP 65 = 6 cours × 10 + 5 remaining
        // After 5 steps: remaining = 65 - 50 = 15, still > 10
        // Should return best guess at depth 5
        const result = await resolveOverflowEpisode(animeInfo, 65, 1);

        expect(result).not.toBeNull();
        expect(result!.animeInfo.id).toBe(6);
        expect(result!.overflowDepth).toBe(5);
        expect(result!.originalEpisode).toBe(65);
        // remaining = 65 - (10 * 5) = 15, but anime 6 has 10 episodes
        // So it's a best guess: anime 6, EP 15
        expect(result!.adjustedEpisode).toBe(15);
    });

    it("returns null when no sequel exists", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Standalone Anime",
            title_english: "Standalone Anime",
            cover_url: null,
            total_episodes: 11,
        };

        primaryJikanGetSequelInfoMock.mockResolvedValueOnce(null);

        const result = await resolveOverflowEpisode(animeInfo, 12, 1);

        expect(result).toBeNull();
    });

    it("returns best guess when sequel has no episode count", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone: New World",
            title_english: "Dr. STONE: New World",
            cover_url: null,
            total_episodes: 11,
        };

        primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
            id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            total_episodes: undefined,
            is_split_cour: true,
        });

        primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
            id: 2,
            mal_id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            cover_url: null,
            // No total_episodes — can't determine if remaining episode fits
        });

        const result = await resolveOverflowEpisode(animeInfo, 12, 2);

        expect(result).not.toBeNull();
        expect(result!.animeInfo.id).toBe(2);
        expect(result!.adjustedEpisode).toBe(1);
        expect(result!.originalEpisode).toBe(12);
        expect(result!.overflowDepth).toBe(1);
    });

    it("seeds sequel lookup with sourceProviderName, preferring that provider first", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone: New World",
            title_english: "Dr. STONE: New World",
            cover_url: null,
            total_episodes: 11,
        };

        // When sourceProviderName is "kitsu", the kitsu provider should be
        // tried first for getSequelInfo, even though jikan is the primary.
        kitsuGetSequelInfoMock.mockResolvedValueOnce({
            id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            total_episodes: 11,
            is_split_cour: true,
        });

        kitsuGetAnimeByIdMock.mockResolvedValueOnce({
            id: 2,
            mal_id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            cover_url: null,
            total_episodes: 11,
        });

        const result = await resolveOverflowEpisode(animeInfo, 12, 2, "kitsu");

        expect(result).not.toBeNull();
        expect(result!.animeInfo.id).toBe(2);
        expect(result!.adjustedEpisode).toBe(1);
        // The kitsu provider should have been called for getSequelInfo
        expect(kitsuGetSequelInfoMock).toHaveBeenCalledWith(1);
        // Jikan should NOT have been called for getSequelInfo since kitsu succeeded first
        expect(primaryJikanGetSequelInfoMock).not.toHaveBeenCalled();
    });

    it("sourceProviderName produces different cache keys, preventing cross-provider collisions", async () => {
        const { resolveOverflowEpisode } = await import("../src/anime");

        const animeInfo = {
            id: 1,
            title_romaji: "Dr Stone: New World",
            title_english: "Dr. STONE: New World",
            cover_url: null,
            total_episodes: 11,
        };

        // First call with sourceProviderName="jikan" — jikan resolves the sequel
        primaryJikanGetSequelInfoMock.mockResolvedValueOnce({
            id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            total_episodes: 11,
            is_split_cour: true,
        });

        primaryJikanGetAnimeByIdMock.mockResolvedValueOnce({
            id: 2,
            mal_id: 2,
            title_romaji: "Dr Stone: New World Part 2",
            title_english: "Dr. STONE: New World Part 2",
            cover_url: null,
            total_episodes: 11,
        });

        const resultJikan = await resolveOverflowEpisode(animeInfo, 12, 2, "jikan");
        expect(resultJikan).not.toBeNull();
        expect(resultJikan!.sourceProvider).toBe("jikan");

        // Second call with sourceProviderName="kitsu" — should NOT return the
        // cached jikan result because the cache key includes the provider name.
        // It should call kitsu's getSequelInfo instead.
        kitsuGetSequelInfoMock.mockResolvedValueOnce({
            id: 3,
            title_romaji: "Dr Stone: New World Part 2 (Kitsu)",
            title_english: "Dr. STONE: New World Part 2 (Kitsu)",
            total_episodes: 11,
            is_split_cour: true,
        });

        kitsuGetAnimeByIdMock.mockResolvedValueOnce({
            id: 3,
            mal_id: 3,
            title_romaji: "Dr Stone: New World Part 2 (Kitsu)",
            title_english: "Dr. STONE: New World Part 2 (Kitsu)",
            cover_url: null,
            total_episodes: 11,
        });

        const resultKitsu = await resolveOverflowEpisode(animeInfo, 12, 2, "kitsu");
        expect(resultKitsu).not.toBeNull();
        // The kitsu result should have a different anime ID (3 vs 2)
        // proving the cache didn't return the jikan result
        expect(resultKitsu!.animeInfo.id).toBe(3);
        expect(resultKitsu!.sourceProvider).toBe("kitsu");
    });
});