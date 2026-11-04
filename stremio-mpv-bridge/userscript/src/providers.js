// Stream provider catalog, defaults and manifest name resolution.

import { log } from "./logging.js";
import { settings } from "./settings.js";

// Available providers organized by category
export const AVAILABLE_PROVIDERS = {
    providers: [
        { id: "torrentio", name: "Torrentio" },
        { id: "comet", name: "Comet" },
        { id: "mediafusion", name: "MediaFusion" },
        { id: "sootio", name: "Sootio" },
        { id: "aiostreams", name: "AIOStreams" },
    ],
    debrid: [
        { id: "torbox", name: "Torbox" },
        { id: "stremthru-store", name: "StremThru Store" },
        { id: "intell-debridsearch", name: "Intell Debrid Search" },
        { id: "real-debrid", name: "Real Debrid" },
    ],
};

/**
 * Get defaults (URL, placeholder, tooltip) for specific providers
 */
export function getProviderDefaults(id) {
    if (id === "stremthru-store") {
        return {
            url: "",
            tooltip:
                "Supported StremThru Store providers:\n- dev 'muniftanjim': https://stremthru.13377001.xyz/stremio/store/\n- elfhosted: https://stremthru.elfhosted.com/stremio/store/\n- midnight: https://stremthrufortheweebs.midnightignite.me/stremio/store/",
            placeholder: "Paste StremThru Store manifest.json link here",
        };
    }
    if (id === "intell-debridsearch") {
        return {
            url: "",
            tooltip: "Intell Debrid Search (store-like addon):\nhttps://intell-debridsearch.nepiraw.com/",
            placeholder: "Paste Intell Debrid Search manifest.json link here",
        };
    }
    return {
        url: "",
        tooltip: "",
        placeholder: "Paste manifest.json link here",
    };
}

// Cache for custom provider names (from manifest.json)
const providerNameCache = new Map();

const CACHE_TTL = 5 * 60 * 1000;

// 5 minutes

/**
 * Get known provider by ID from AVAILABLE_PROVIDERS
 */
function getKnownProvider(id) {
    const allProviders = [...AVAILABLE_PROVIDERS.providers, ...AVAILABLE_PROVIDERS.debrid];
    return allProviders.find((p) => p.id === id) || null;
}

/**
 * Extract provider name from URL domain
 */
function extractNameFromUrl(url) {
    if (!url) return null;
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        const name = hostname.split(".")[0];
        return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
        return null;
    }
}

/**
 * Clean up manifest name - extract the actual provider name from wrapper formats
 * Examples:
 *   "STREMTHRU(TB)(BRAZUCA TORRENTS)" -> "Brazuca Torrents"
 *   "Torbox (Brazuca)" -> "Brazuca"
 *   "My Addon Name" -> "My Addon Name"
 */
function cleanManifestName(name) {
    if (!name) return null;

    // Check for nested parentheses pattern like "WRAPPER(X)(ACTUAL NAME)"
    const nestedMatch = name.match(/\(([^()]+)\)(?:\s*$|(?=\)))/g);
    if (nestedMatch && nestedMatch.length > 0) {
        const lastMatch = nestedMatch[nestedMatch.length - 1];
        const innerName = lastMatch.replace(/^\(|\)$/g, "").trim();
        if (innerName.length > 2) {
            return innerName
                .split(" ")
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(" ");
        }
    }

    return name.trim();
}

/**
 * Fetch provider name from manifest.json for custom providers
 */
async function fetchManifestName(url) {
    return new Promise((resolve) => {
        if (!url) {
            resolve(null);
            return;
        }

        let manifestUrl = url;
        if (!manifestUrl.endsWith("/manifest.json")) {
            manifestUrl = `${manifestUrl.replace(/\/$/, "")}/manifest.json`;
        }

        log(`Fetching manifest from: ${manifestUrl}`);

        GM_xmlhttpRequest({
            method: "GET",
            url: manifestUrl,
            timeout: 5000,
            headers: { Accept: "application/json" },
            onload: (response) => {
                try {
                    if (response.status === 200) {
                        const manifest = JSON.parse(response.responseText);
                        if (manifest.name) {
                            const cleanedName = cleanManifestName(manifest.name);
                            log(`Manifest name: "${manifest.name}" -> cleaned: "${cleanedName}"`);
                            resolve(cleanedName);
                            return;
                        }
                    }
                    resolve(null);
                } catch (e) {
                    log("Failed to parse manifest:", e.message);
                    resolve(null);
                }
            },
            onerror: () => resolve(null),
            ontimeout: () => resolve(null),
        });
    });
}

/**
 * Resolve provider display name with caching
 */
export async function resolveProviderName(provider) {
    const known = getKnownProvider(provider.id);
    if (known) return known.name;

    if (!provider.id.startsWith("custom") && provider.name) return provider.name;

    if (provider.url && providerNameCache.has(provider.url)) {
        const cached = providerNameCache.get(provider.url);
        if (Date.now() - cached.timestamp < CACHE_TTL) return cached.displayName;
    }

    if (provider.url && provider.id.startsWith("custom")) {
        const manifestName = await fetchManifestName(provider.url);

        if (manifestName) {
            const displayName = `Custom (${manifestName})`;
            providerNameCache.set(provider.url, { name: manifestName, displayName, timestamp: Date.now() });
            return displayName;
        }

        const domainName = extractNameFromUrl(provider.url);
        if (domainName) {
            const displayName = `Custom (${domainName})`;
            providerNameCache.set(provider.url, { name: domainName, displayName, timestamp: Date.now() });
            return displayName;
        }
    }

    return provider.name || provider.id;
}

/**
 * Update provider labels in the modal with resolved names
 */
export async function updateProviderLabels(modal) {
    const providerItems = modal.querySelectorAll(".mpv-provider-item");

    for (const item of providerItems) {
        const providerId = item.dataset.id;
        const providerUrl = item.dataset.url;
        const label = item.querySelector(".mpv-provider-label");
        const loadingSpan = item.querySelector(".mpv-loading-name");

        if (providerId.startsWith("custom") && providerUrl && label) {
            if (loadingSpan) loadingSpan.textContent = "(loading...)";

            const provider = settings.providers.find((p) => p.id === providerId);
            if (provider) {
                const resolvedName = await resolveProviderName(provider);
                label.textContent = resolvedName;
                if (loadingSpan) loadingSpan.remove();
            }
        }
    }
}

/**
 * Update a single provider label when URL changes
 */
export async function updateSingleProviderLabel(modal, providerId, url) {
    const item = modal.querySelector(`.mpv-provider-item[data-id="${providerId}"]`);
    if (!item) return;

    const label = item.querySelector(".mpv-provider-label");
    if (!label) return;

    item.dataset.url = url;

    if (providerId.startsWith("custom") && url) {
        const originalText = label.textContent;
        label.innerHTML = `${originalText.split("(")[0].trim()} <span style="font-size: 10px; opacity: 0.6;">(loading...)</span>`;

        const provider = { id: providerId, url: url, name: originalText };
        const resolvedName = await resolveProviderName(provider);
        label.textContent = resolvedName;
    }
}
