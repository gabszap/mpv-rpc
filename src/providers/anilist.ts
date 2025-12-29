/**
 * AniList API Provider - Fetches anime metadata via GraphQL
 * API Docs: https://anilist.gitbook.io/anilist-apiv2-docs/
 */

import axios from "axios";
import { logApiCall } from "./types";
import type { AnimeProvider, AnimeInfo, AnimeSearchResult } from "./types";

const ANILIST_API = "https://graphql.anilist.co";

// Rate limiting (AniList allows 90 req/min, but we'll be conservative)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 400;

// Circuit Breaker
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    threshold: 5,
    cooldown: 30000,
    isOpen(): boolean {
        if (this.failures < this.threshold) return false;
        if (Date.now() - this.lastFailure >= this.cooldown) {
            this.failures = 0;
            return false;
        }
        return true;
    },
    recordFailure(): void {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) {
            console.log(`[AniList] Circuit breaker OPEN - waiting ${this.cooldown / 1000}s`);
        }
    },
    recordSuccess(): void {
        this.failures = 0;
    },
};

/**
 * Make a GraphQL request to AniList
 */
async function anilistRequest(query: string, variables: Record<string, any>, operation = "query"): Promise<any> {
    if (circuitBreaker.isOpen()) {
        logApiCall("AniList", operation, variables, "CIRCUIT_OPEN", "blocked");
        throw new Error("Circuit breaker open");
    }

    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();

    try {
        const response = await axios.post(ANILIST_API, {
            query,
            variables,
        }, {
            headers: { "Content-Type": "application/json" },
            timeout: 10000,
        });

        circuitBreaker.recordSuccess();
        logApiCall("AniList", operation, variables, "200 OK", "");
        return response.data;
    } catch (e: any) {
        if (e.response?.status === 429) {
            logApiCall("AniList", operation, variables, "429 RATE_LIMITED", "retrying in 2s");
            console.log("[AniList] Rate limited, waiting 2s...");
            circuitBreaker.recordFailure();
            await new Promise(resolve => setTimeout(resolve, 2000));
            return anilistRequest(query, variables, operation);
        }

        logApiCall("AniList", operation, variables, "ERROR", e.message || "unknown");
        circuitBreaker.recordFailure();
        throw e;
    }
}

// GraphQL Queries
const SEARCH_QUERY = `
query ($search: String) {
    Media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
        id
        idMal
        title {
            romaji
            english
        }
        coverImage {
            extraLarge
            large
        }
        format
    }
}
`;

const GET_BY_ID_QUERY = `
query ($id: Int) {
    Media(id: $id, type: ANIME) {
        id
        idMal
        title {
            romaji
            english
        }
        coverImage {
            extraLarge
            large
        }
        format
        episodes
        relations {
            edges {
                relationType
                node {
                    id
                    title {
                        romaji
                        english
                    }
                    format
                }
            }
        }
    }
}
`;

const EPISODE_QUERY = `
query ($id: Int) {
    Media(id: $id, type: ANIME) {
        streamingEpisodes {
            title
        }
    }
}
`;

function extractSeasonNumber(title: string): number | null {
    const patterns = [
        /(?:season|s)\s*(\d+)/i,
        /(\d+)(?:st|nd|rd|th)\s*season/i,
    ];
    for (const pattern of patterns) {
        const match = title.match(pattern);
        if (match) return parseInt(match[1], 10);
    }
    return null;
}

function isPartOfSameSeason(title: string): boolean {
    return /\bpart\s*\d+/i.test(title) || /\bcour\s*\d+/i.test(title);
}

export class AniListProvider implements AnimeProvider {
    readonly name = "anilist";

    async searchAnime(title: string): Promise<AnimeSearchResult | null> {
        try {
            const response = await anilistRequest(SEARCH_QUERY, { search: title }, "search");
            const media = response?.data?.Media;

            if (!media) {
                logApiCall("AniList", "search", { search: title }, "DETAIL", "0 results");
                return null;
            }

            logApiCall("AniList", "search", { search: title }, "DETAIL", `"${media.title.romaji}" (ID:${media.id})`);

            return {
                id: media.id,
                title: media.title.romaji,
                title_english: media.title.english,
                type: this.mapFormat(media.format),
                coverImage: media.coverImage?.extraLarge || media.coverImage?.large || null,
            };
        } catch (e) {
            console.error("[AniList] Search error:", e);
            return null;
        }
    }

    async getAnimeById(id: number): Promise<AnimeInfo | null> {
        try {
            const response = await anilistRequest(GET_BY_ID_QUERY, { id }, "getById");
            const media = response?.data?.Media;

            if (!media) return null;

            logApiCall("AniList", "getById", { id }, "DETAIL", `"${media.title.english || media.title.romaji}" (${media.format})`);

            return {
                id: media.id,
                mal_id: media.idMal || undefined,
                title_english: media.title.english,
                title_romaji: media.title.romaji,
                cover_url: media.coverImage?.extraLarge || media.coverImage?.large || null,
                total_episodes: media.episodes || undefined,
            };
        } catch {
            return null;
        }
    }

    async getEpisodeTitle(animeId: number, episode: number): Promise<string | null> {
        try {
            const response = await anilistRequest(EPISODE_QUERY, { id: animeId }, "getEpisode");
            const episodes = response?.data?.Media?.streamingEpisodes;

            if (episodes && episodes.length >= episode) {
                // AniList episode titles often include "Episode X - Title" format
                const epData = episodes[episode - 1];
                if (epData?.title) {
                    // Try to extract just the title part
                    const match = epData.title.match(/Episode\s*\d+\s*[-:]\s*(.+)/i);
                    const title = match ? match[1] : epData.title;
                    logApiCall("AniList", "getEpisode", { id: animeId, ep: episode }, "DETAIL", `"${title}"`);
                    return title;
                }
            }
            logApiCall("AniList", "getEpisode", { id: animeId, ep: episode }, "DETAIL", "no episode data");
            return null;
        } catch {
            return null;
        }
    }

    async findSeasonAnime(baseId: number, targetSeason: number): Promise<AnimeInfo | null> {
        if (targetSeason <= 1) {
            return this.getAnimeById(baseId);
        }

        const visited = new Set<number>();
        let currentId = baseId;
        let currentSeason = 1;
        let lastValidId = baseId;

        while (currentSeason < targetSeason) {
            if (visited.has(currentId)) break;
            visited.add(currentId);

            const response = await anilistRequest(GET_BY_ID_QUERY, { id: currentId }, "findSeason");
            const media = response?.data?.Media;
            if (!media) break;

            // Find sequel in relations
            const sequel = this.findSequel(media.relations?.edges || []);
            if (!sequel) {
                logApiCall("AniList", "findSeason", { id: currentId }, "DETAIL", "no sequel found");
                break;
            }

            logApiCall("AniList", "findSeason", { id: currentId }, "DETAIL", `sequel: "${sequel.title.romaji}" (ID:${sequel.id})`);

            currentId = sequel.id;
            lastValidId = currentId;

            const seasonInTitle = extractSeasonNumber(sequel.title.romaji) ||
                extractSeasonNumber(sequel.title.english || "");
            if (seasonInTitle === targetSeason) {
                return this.getAnimeById(currentId);
            }

            const isPart = isPartOfSameSeason(sequel.title.romaji) ||
                isPartOfSameSeason(sequel.title.english || "");
            if (!isPart && sequel.format === "TV") {
                currentSeason++;
            }
        }

        return this.getAnimeById(lastValidId);
    }

    private findSequel(edges: any[]): { id: number; title: { romaji: string; english: string | null }; format: string } | null {
        for (const edge of edges) {
            if (edge.relationType === "SEQUEL") {
                const node = edge.node;
                // Prefer TV format
                if (node.format === "TV") {
                    return node;
                }
            }
        }
        // Fallback: any sequel
        for (const edge of edges) {
            if (edge.relationType === "SEQUEL") {
                return edge.node;
            }
        }
        return null;
    }

    private mapFormat(format: string): string {
        const formatMap: Record<string, string> = {
            TV: "TV",
            TV_SHORT: "TV",
            MOVIE: "Movie",
            SPECIAL: "Special",
            OVA: "OVA",
            ONA: "ONA",
            MUSIC: "Music",
        };
        return formatMap[format] || format;
    }
}
