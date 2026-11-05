// Click handler that resolves streams for the current content and sends them to MPV.

import { checkServer, sendToMPV } from "./bridge-api.js";
import { createConfigModal } from "./config-modal.js";
import { log } from "./logging.js";
import { settings } from "./settings.js";
import { buildStreamUrl, fetchStreamList, mapWithConcurrency, STREAM_FETCH_CONCURRENCY } from "./stream-fetch.js";
import { extractReleaseGroup, findBestStream } from "./stream-selection.js";
import { notify, showNowPlayingWidget, showToast } from "./toasts.js";
import { parseCurrentURL } from "./url-parser.js";

// ==================== MAIN LOGIC ====================
export async function handleMPVClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const activeProviders = settings.providers.filter((p) => p.enabled && p.url);
    if (activeProviders.length === 0) {
        createConfigModal();
        return;
    }

    const btn = document.getElementById("stremio-mpv-btn");
    btn.classList.add("loading");

    try {
        if (!(await checkServer())) {
            showToast("Server offline! (npm start)", "error");
            return;
        }

        const content = parseCurrentURL();
        if (!content?.episode) {
            showToast("Please select an episode", "error");
            return;
        }

        const limit =
            settings.playlistMode === "all" ? 50 : settings.playlistMode === "single" ? 0 : settings.extraEpisodes;
        const modeText =
            settings.playlistMode === "all"
                ? "Load All"
                : settings.playlistMode === "single"
                  ? "Single"
                  : `Batch | Extra: ${settings.extraEpisodes}`;
        notify(`Mode: ${modeText}`, "info");

        const playlist = await collectStreams(content, limit);

        if (playlist.length === 0) {
            showToast("No streams found", "error");
            return;
        }

        await sendToMPV(playlist, content);
        showToast(`Opening ${playlist.length} item(s) in MPV`, "success");
        showNowPlayingWidget(playlist[0].title || content.name || "Unknown Video");
    } catch (error) {
        log("Error:", error);
        showToast(error.message, "error");
    } finally {
        btn.classList.remove("loading");
    }
}

async function fetchSeriesMeta(baseUrl, imdbId) {
    return new Promise((resolve) => {
        const url = `${baseUrl}/meta/series/${imdbId}.json`;
        log(`Fetching series meta from: ${url}`);

        GM_xmlhttpRequest({
            method: "GET",
            url: url,
            timeout: 15000,
            headers: { Accept: "application/json" },
            onload: (response) => {
                try {
                    if (response.status !== 200) {
                        log(`Series meta fetch returned status ${response.status}`);
                        resolve([]);
                        return;
                    }
                    const data = JSON.parse(response.responseText);
                    const meta = data.meta;
                    if (meta?.videos) {
                        const episodes = meta.videos
                            .map((v) => {
                                const match = v.id.match(/:(\d+):(\d+)$/);
                                if (match) {
                                    return {
                                        season: parseInt(match[1], 10),
                                        episode: parseInt(match[2], 10),
                                        title: v.title || null,
                                    };
                                }
                                log("Skipping video entry with unrecognized ID format:", v.id);
                                return null;
                            })
                            .filter((ep) => ep !== null);
                        log(`Series meta returned ${episodes.length} episodes`);
                        resolve(episodes);
                        return;
                    }
                    resolve([]);
                } catch (e) {
                    log("Failed to parse series meta:", e.message);
                    resolve([]);
                }
            },
            onerror: () => {
                log("Series meta request error");
                resolve([]);
            },
            ontimeout: () => {
                log("Series meta request timeout");
                resolve([]);
            },
        });
    });
}

async function collectStreams(content, limit) {
    const items = [];
    const seenKeys = new Set();

    const addItem = (item) => {
        const key = `${item.season}:${item.episode}`;
        if (seenKeys.has(key)) {
            log(`Skipping duplicate episode ${key}`);
            return false;
        }
        seenKeys.add(key);
        items.push(item);
        return true;
    };

    let inferredGroup = null;

    const fetchWithProviders = async (season, ep) => {
        for (const p of settings.providers) {
            if (!p.enabled || !p.url) continue;
            log(`Trying ${p.name || p.id} for S${season}E${ep}...`);
            const providerSeriesId = content.streamId || content.imdbId || content.seriesId;
            if (!providerSeriesId) continue;

            const streams = await fetchStreams(p.url, providerSeriesId, season, ep);
            const streamItem = findBestStream(streams, season, ep, inferredGroup, content.name);
            if (streamItem) {
                if (!inferredGroup && streamItem.title) {
                    inferredGroup = extractReleaseGroup(streamItem.title);
                }
                log(`Found on ${p.name || p.id}`);
                return {
                    ...streamItem,
                    imdbId: content.imdbId,
                    streamId: providerSeriesId,
                    season: season,
                    episode: ep,
                    type: content.type,
                };
            }
        }
        return null;
    };

    notify(`Fetching S${content.season}E${content.episode}...`);
    const firstItem = await fetchWithProviders(content.season, content.episode);
    if (firstItem) addItem(firstItem);

    if (content.type === "series" && limit > 0) {
        // Try fetching series metadata from providers to discover episodes
        let discoveredEpisodes = [];

        for (const p of settings.providers) {
            if (!p.enabled || !p.url) continue;
            const providerSeriesId = content.streamId || content.imdbId || content.seriesId;
            if (!providerSeriesId) continue;

            const episodes = await fetchSeriesMeta(p.url, providerSeriesId);
            if (episodes.length > 0) {
                discoveredEpisodes = episodes;
                log(`Discovered ${episodes.length} episodes from ${p.name || p.id} meta`);
                break;
            }
        }

        if (discoveredEpisodes.length > 0) {
            const sameSeasonEpisodes = discoveredEpisodes.filter((ep) => ep.season === content.season);
            if (sameSeasonEpisodes.length > 0) {
                content.episodesInSeason = sameSeasonEpisodes.length;
            }

            // Filter to episodes after the current one
            const nextEpisodes = discoveredEpisodes
                .filter((ep) => {
                    if (ep.season == null || ep.episode == null) return false;
                    if (ep.season > content.season) return true;
                    if (ep.season === content.season && ep.episode > content.episode) return true;
                    return false;
                })
                .sort((a, b) => {
                    if (a.season !== b.season) return a.season - b.season;
                    return a.episode - b.episode;
                })
                .slice(0, limit);

            // The episodes are independent, so fetch a few at a time instead of one after
            // the other (each request to a slow provider takes around 10 seconds). Results
            // keep the episode order.
            const nextItems = await mapWithConcurrency(nextEpisodes, STREAM_FETCH_CONCURRENCY, async (ep) => {
                notify(`Fetching S${ep.season}E${ep.episode}${ep.title ? ` - ${ep.title}` : ""}...`);
                return fetchWithProviders(ep.season, ep.episode);
            });
            nextEpisodes.forEach((ep, index) => {
                const nextItem = nextItems[index];
                if (nextItem) {
                    addItem(nextItem);
                } else {
                    log(`Episode S${ep.season}E${ep.episode} not found on any provider.`);
                }
            });
        } else {
            // Fallback: sequential episode increment
            log("No series meta available, falling back to sequential episode increment");
            let failures = 0;
            for (let i = 1; i <= limit; i++) {
                const nextEp = content.episode + i;
                notify(`Fetching S${content.season}E${nextEp}...`);
                const nextItem = await fetchWithProviders(content.season, nextEp);
                if (nextItem) {
                    const added = addItem(nextItem);
                    if (added) failures = 0;
                } else {
                    log(`Episode ${nextEp} not found on any provider.`);
                    failures++;
                    if (settings.playlistMode === "all" && failures >= 3) {
                        log("Too many consecutive failures, stopping search.");
                        break;
                    }
                }
            }
        }
    }
    return items;
}

function gmRequest(url, timeoutMs) {
    return new Promise((resolve) => {
        log(`Fetching streams from: ${url}`);
        GM_xmlhttpRequest({
            method: "GET",
            url,
            timeout: timeoutMs,
            onload: (r) => {
                if (r.status !== 200) {
                    log(`Stream fetch returned status ${r.status}`);
                }
                resolve({ kind: "response", status: r.status, body: r.responseText });
            },
            onerror: () => {
                log("Stream fetch error");
                resolve({ kind: "error" });
            },
            ontimeout: () => {
                log(`Stream fetch timeout after ${timeoutMs} ms`);
                resolve({ kind: "timeout" });
            },
        });
    });
}

async function fetchStreams(baseUrl, id, season, episode) {
    const url = buildStreamUrl(baseUrl, id, season, episode);
    return fetchStreamList(url, gmRequest, {
        onRetry: (attempt, attempts) =>
            notify(`Retrying stream fetch for S${season}E${episode} (attempt ${attempt}/${attempts})...`),
        onSlow: () => notify(`Still waiting for S${season}E${episode}: this provider is slow...`),
    });
}
