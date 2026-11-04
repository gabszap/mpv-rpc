// Parses the current Stremio Web route into playback content.

import { log } from "./logging.js";
import { scrapeMetadata } from "./page-scraper.js";

// ==================== URL PARSER ====================
export function isRealImdbId(id) {
    return typeof id === "string" && /^tt\d+$/.test(id);
}

export function getRouteText() {
    return `${window.location.pathname || ""}${window.location.hash || ""}`.toLowerCase();
}

export function isPlayerRoute() {
    const route = getRouteText();
    return /(?:^|[#/])player(?:$|[/?#])/.test(route);
}

export function isDetailRoute() {
    return getRouteText().includes("/detail/");
}

export function parseCurrentURL() {
    const hash = window.location.hash;
    log("Parsing URL:", `${hash.substring(0, 80)}...`);

    if (hash.includes("/player/") && lastValidContent?.episode) {
        log("Using saved content (player mode):", lastValidContent);
        return lastValidContent;
    }

    const uiMeta = scrapeMetadata();
    const decodedHash = decodeURIComponent(hash);

    let seriesId = null;
    const seriesMatch = decodedHash.match(/\/detail\/(?:series|movie)\/([^/]+)/);
    if (seriesMatch) {
        seriesId = seriesMatch[1];
        log("Extracted seriesId:", seriesId);
    }

    const imdbMatch = decodedHash.match(/(tt\d+):(\d+):(\d+)/);
    if (imdbMatch) {
        const videoId = imdbMatch[0];
        const result = {
            type: "series",
            libraryItemId: seriesId || imdbMatch[1],
            imdbId: imdbMatch[1],
            seriesId: seriesId || imdbMatch[1],
            streamId: imdbMatch[1],
            videoId,
            name: uiMeta.seriesName,
            season: parseInt(imdbMatch[2], 10),
            episode: parseInt(imdbMatch[3], 10),
        };
        log("IMDb content found:", result);
        lastValidContent = result;
        return result;
    }

    const kitsuMatch = decodedHash.match(/kitsu[:%]3A(\d+)[:%]3A(\d+)/i) || decodedHash.match(/kitsu:(\d+):(\d+)/i);
    if (kitsuMatch) {
        const streamId = `kitsu:${kitsuMatch[1]}`;
        const result = {
            type: "series",
            libraryItemId: seriesId || streamId,
            imdbId: null,
            seriesId: seriesId || streamId,
            streamId,
            videoId: `${streamId}:${kitsuMatch[2]}`,
            name: uiMeta.seriesName,
            episodeTitle: uiMeta.episodeTitle,
            season: uiMeta.season || 1,
            episode: uiMeta.episode || parseInt(kitsuMatch[2], 10),
        };
        log("Kitsu content found:", result);
        lastValidContent = result;
        return result;
    }

    const genericMatch =
        decodedHash.match(/(\w+)[:%]3A(\d+)[:%]3A(\d+)[:%]3A(\d+)/i) || decodedHash.match(/(\w+):(\d+):(\d+):(\d+)/i);
    if (genericMatch) {
        const streamId = `${genericMatch[1]}:${genericMatch[2]}`;
        const videoId = `${streamId}:${genericMatch[3]}:${genericMatch[4]}`;
        const result = {
            type: "series",
            libraryItemId: seriesId || streamId,
            imdbId: isRealImdbId(streamId) ? streamId : null,
            seriesId: seriesId || streamId,
            streamId,
            videoId,
            name: uiMeta.seriesName,
            season: parseInt(genericMatch[3], 10),
            episode: parseInt(genericMatch[4], 10),
        };
        log("Generic content found:", result);
        lastValidContent = result;
        return result;
    }

    const imdbIdMatch = decodedHash.match(/(tt\d+)/);
    if (imdbIdMatch) {
        return {
            type: "series",
            libraryItemId: seriesId || imdbIdMatch[1],
            imdbId: imdbIdMatch[1],
            seriesId: seriesId || imdbIdMatch[1],
            streamId: imdbIdMatch[1],
            videoId: null,
            name: uiMeta.seriesName,
            season: parseInt(decodedHash.match(/season=(\d+)/)?.[1], 10) || uiMeta.season || null,
            episode: null,
        };
    }
    return lastValidContent || null;
}

let lastValidContent = null;
