// Scrapes series metadata from the Stremio Web DOM.

import { log } from "./logging.js";

// ==================== UI SCRAPER ====================
export function scrapeMetadata() {
    const metadata = {
        seriesName: null,
        episodeTitle: null,
        season: null,
        episode: null,
    };

    try {
        // Check cache first for series name
        const cachedSeriesId = window.location.hash.match(/series\/([^/?#]+)/i);
        if (cachedSeriesId?.[1] && seriesNameCache.has(cachedSeriesId[1])) {
            metadata.seriesName = seriesNameCache.get(cachedSeriesId[1]);
        }

        const headerEl = document.querySelector('div[class*="episode-title"]');
        if (headerEl?.innerText) {
            const seMatch = headerEl.innerText.match(/S(\d+)E(\d+)/i);
            if (seMatch) {
                metadata.season = parseInt(seMatch[1], 10);
                metadata.episode = parseInt(seMatch[2], 10);
                log(`Scraped from header: S${metadata.season}E${metadata.episode}`);
            }

            const titlePart = headerEl.innerText.replace(/S\d+E\d+/i, "").trim();
            if (titlePart.length > 2) {
                metadata.episodeTitle = titlePart;
            }
        }

        // Try multiple selectors for series name, in order of reliability
        const nameCandidates = [];

        // 1. Logo inside .meta-info-container (most reliable — actual series name)
        const metaLogoEl = document.querySelector('[class*="meta-info-container"] img[class*="logo"]');
        if (metaLogoEl?.title) {
            nameCandidates.push(metaLogoEl.title.trim());
        } else if (metaLogoEl?.alt) {
            nameCandidates.push(metaLogoEl.alt.trim());
        }

        // 2. Title label element
        const titleEl = document.querySelector('[class*="title-label"]');
        if (titleEl?.innerText) {
            nameCandidates.push(titleEl.innerText.trim());
        }

        // 3. Page title (usually "Series Name - Stremio" or similar)
        if (document.title) {
            const titleMatch = document.title.replace(/\s*[-\u2013\u2014]\s*Stremio\s*$/i, "").trim();
            if (titleMatch && titleMatch.length > 1) {
                nameCandidates.push(titleMatch);
            }
        }

        // 4. Meta tags
        const metaTitle = document.querySelector('meta[property="og:title"]');
        if (metaTitle?.content) {
            nameCandidates.push(metaTitle.content.trim());
        }

        // Filter out invalid names and pick the first valid one
        const invalidPatterns = [
            /you might also like/i,
            /similar to/i,
            /more like/i,
            /recommended/i,
            /trending/i,
            /popular/i,
            /^watch$/i,
            /^stream$/i,
        ];

        for (const candidate of nameCandidates) {
            if (!candidate || candidate.length < 2) continue;
            if (invalidPatterns.some((p) => p.test(candidate))) continue;
            metadata.seriesName = candidate;
            break;
        }

        // Cache the resolved series name keyed by seriesId from URL
        const urlSeriesId = window.location.hash.match(/series\/([^/?#]+)/i);
        if (urlSeriesId?.[1] && metadata.seriesName) {
            seriesNameCache.set(urlSeriesId[1], metadata.seriesName);
        }

        // Season detection fallbacks
        if (!metadata.season) {
            const allMultiselects = document.querySelectorAll('[class*="multiselect-button"]');
            for (const el of allMultiselects) {
                if (el.innerText?.includes("Season")) {
                    const match = el.innerText.match(/Season\s*(\d+)/i);
                    if (match) {
                        metadata.season = parseInt(match[1], 10);
                        break;
                    }
                }
            }
        }

        if (!metadata.season) {
            const urlMatch = window.location.hash.match(/season=(\d+)/i);
            if (urlMatch) metadata.season = parseInt(urlMatch[1], 10);
        }
    } catch (e) {
        console.warn("Scraper error:", e);
    }

    return metadata;
}

const seriesNameCache = new Map();
