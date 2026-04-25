// ==UserScript==
// @name         Stremio MPV Bridge
// @namespace    https://github.com/gabszap/mpv-rpc
// @version      1.10.0
// @icon         https://www.stremio.com/website/stremio-purple-small.png
// @description  Open Stremio Web streams directly in MPV with playlist support
// @homepage     https://github.com/gabszap/mpv-rpc
// @updateURL    https://github.com/gabszap/mpv-rpc/raw/refs/heads/main/stremio-mpv-bridge/stremio-mpv.user.js
// @downloadURL  https://github.com/gabszap/mpv-rpc/raw/refs/heads/main/stremio-mpv-bridge/stremio-mpv.user.js
// @author       gabszap
// @match        https://web.stremio.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
    const CONFIG = {
        SERVER_URL: "http://localhost:9632",
    };

    // Available providers organized by category
    const AVAILABLE_PROVIDERS = {
        providers: [
            { id: "torrentio", name: "Torrentio" },
            { id: "comet", name: "Comet" },
            { id: "mediafusion", name: "MediaFusion" },
            { id: "sootio", name: "Sootio" },
            { id: "aiostreams", name: "AIOStreams" },
        ],
        debrid: [
            { id: "torbox", name: "Torbox" },
            { id: "real-debrid", name: "Real Debrid" },
        ],
    };

    // Cache for custom provider names (from manifest.json)
    const providerNameCache = new Map();
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
    async function resolveProviderName(provider) {
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
    async function updateProviderLabels(modal) {
        const providerItems = modal.querySelectorAll(".mpv-provider-item");

        for (const item of providerItems) {
            const providerId = item.dataset.id;
            const providerUrl = item.dataset.url;
            const label = item.querySelector(".mpv-provider-label");
            const loadingSpan = item.querySelector(".mpv-loading-name");

            if (providerId.startsWith("custom") && providerUrl && label) {
                if (loadingSpan) loadingSpan.textContent = "(loading...)";

                const provider = providers.find((p) => p.id === providerId);
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
    async function updateSingleProviderLabel(modal, providerId, url) {
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

    // Default active providers (only torrentio + custom)
    const DEFAULT_ACTIVE = [
        { id: "torrentio", name: "Torrentio", url: "", enabled: true },
        { id: "custom", name: "Custom", url: "", enabled: true },
    ];

    let extraEpisodes = GM_getValue("extraEpisodes", 2);
    let playlistMode = GM_getValue("playlistMode", "batch");
    let mpvShortcut = GM_getValue("mpvShortcut", "v");
    let preferredGroup = GM_getValue("preferredGroup", "");
    let preferredQuality = GM_getValue("preferredQuality", "");
    let mpvArgsStr = GM_getValue("mpvArgsStr", "");
    const storedProviders = GM_getValue("providers", []);
    let providers;

    if (storedProviders.length > 0) {
        providers = [...storedProviders];
    } else {
        providers = [...DEFAULT_ACTIVE];
    }

    function log(...args) {
        if (GM_getValue("debug", false)) {
            console.log("%c[Stremio-MPV]", "color: #8b5cf6; font-weight: bold;", ...args);
        }
    }

    function info(...args) {
        console.log("%c[Stremio-MPV]", "color: #22c55e; font-weight: bold;", ...args);
    }

    function notify(msg, type = "info") {
        info(msg);
        showToast(msg, type);
    }

    // ==================== CUSTOM CONFIRM MODAL ====================
    function showConfirmModal(title, message, onConfirm, confirmText = "Yes", cancelText = "Cancel") {
        if (document.getElementById("stremio-mpv-confirm")) return;

        const overlay = document.createElement("div");
        overlay.id = "stremio-mpv-confirm";

        overlay.innerHTML = `
            <style>
                #stremio-mpv-confirm {
                    position: fixed; inset: 0; z-index: 100005;
                    background: rgba(0, 0, 0, 0.4);
                    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                    display: flex; align-items: center; justify-content: center;
                    font-family: 'Roboto', sans-serif;
                    opacity: 0; transition: opacity 0.2s ease;
                    color-scheme: dark;
                }
                .mpv-confirm-content {
                    background: rgba(15, 15, 15, 0.85);
                    color: #eee;
                    padding: 24px;
                    border-radius: 20px;
                    width: 320px; max-width: 90vw;
                    border: 1px solid rgba(139, 92, 246, 0.3);
                    box-shadow: 0 25px 50px rgba(0,0,0,0.6), 0 0 40px rgba(239, 68, 68, 0.15);
                    display: flex; flex-direction: column; align-items: center; text-align: center;
                    transform: scale(0.9); transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
                }
                #stremio-mpv-confirm.active { opacity: 1; }
                #stremio-mpv-confirm.active .mpv-confirm-content { transform: scale(1); }

                .mpv-confirm-icon { font-size: 32px; margin-bottom: 12px; }
                .mpv-confirm-title { font-size: 18px; font-weight: bold; margin-bottom: 8px; color: #fff; }
                .mpv-confirm-message { font-size: 14px; opacity: 0.8; margin-bottom: 24px; line-height: 1.4; }
                .mpv-confirm-actions { display: flex; gap: 12px; width: 100%; }

                .mpv-confirm-btn {
                    flex: 1; padding: 10px; border-radius: 8px; cursor: pointer;
                    border: none; font-weight: 600; font-size: 14px; transition: all 0.2s ease;
                }
                .mpv-confirm-cancel {
                    background: rgba(255, 255, 255, 0.05); color: #aaa; border: 1px solid rgba(255,255,255,0.1);
                }
                .mpv-confirm-cancel:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
                .mpv-confirm-cancel:focus { outline: none; border-color: #8b5cf6; box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.3); }

                .mpv-confirm-yes {
                    background: #ef4444; color: white; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
                }
                .mpv-confirm-yes:hover {
                    background: #dc2626; transform: translateY(-1px); box-shadow: 0 6px 15px rgba(239, 68, 68, 0.4);
                }
                .mpv-confirm-yes:focus { outline: none; box-shadow: 0 0 0 2px #fff, 0 0 0 4px #ef4444; }
            </style>
            <div class="mpv-confirm-content">
                <div class="mpv-confirm-icon">⚠️</div>
                <div class="mpv-confirm-title">${title}</div>
                <div class="mpv-confirm-message">${message}</div>
                <div class="mpv-confirm-actions">
                    <button class="mpv-confirm-btn mpv-confirm-cancel">${cancelText}</button>
                    <button class="mpv-confirm-btn mpv-confirm-yes">${confirmText}</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const cancelBtn = overlay.querySelector(".mpv-confirm-cancel");
        const yesBtn = overlay.querySelector(".mpv-confirm-yes");

        requestAnimationFrame(() => {
            overlay.classList.add("active");
            cancelBtn.focus();
        });

        const close = () => {
            overlay.classList.remove("active");
            document.removeEventListener("keydown", handleEscape);
            setTimeout(() => overlay.remove(), 200);
        };

        const handleEscape = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
        };

        document.addEventListener("keydown", handleEscape);

        cancelBtn.addEventListener("click", close);
        yesBtn.addEventListener("click", () => {
            onConfirm();
            close();
        });

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close();
        });
    }

    // ==================== CONFIGURATION UI ====================
    function createConfigModal() {
        if (document.getElementById("stremio-mpv-modal")) return;

        const modal = document.createElement("div");
        modal.id = "stremio-mpv-modal";

        const providersHTML = providers
            .map((p, _index) => {
                const isCustom = p.id.startsWith("custom");
                const loadingIndicator =
                    isCustom && p.url
                        ? '<span class="mpv-loading-name" style="font-size: 10px; opacity: 0.6; margin-left: 4px;"></span>'
                        : "";
                return `
            <div class="mpv-form-group mpv-provider-item ${p.enabled ? "" : "mpv-provider-disabled"}" data-id="${p.id}" data-url="${p.url || ""}" draggable="true" style="transition: transform 0.2s, opacity 0.2s;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
                        <button type="button" class="mpv-drag-handle" title="Drag to reorder" style="background: transparent; border: none; color: #666; cursor: grab; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s; font-size: 16px; flex-shrink: 0;">☰</button>
                        <div class="mpv-toggle-track mpv-provider-toggle" data-id="${p.id}" data-enabled="${p.enabled ? "true" : "false"}" role="switch" aria-checked="${p.enabled ? "true" : "false"}" tabindex="0" title="${p.enabled ? "Enabled" : "Disabled"}">
                            <div class="mpv-toggle-thumb"></div>
                        </div>
                        <label class="mpv-label mpv-provider-label" data-id="${p.id}" style="margin: 0; cursor: pointer; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}${loadingIndicator}</label>
                    </div>
                    <div style="display: flex; gap: 4px; flex-shrink: 0;">
                        <button type="button" class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">🗑</button>
                    </div>
                </div>
                <input type="text" data-id="${p.id}" class="mpv-input mpv-provider-input"
                       placeholder="Paste manifest.json link here" value="${p.url}"
                       style="${!p.enabled ? "opacity: 0.5; pointer-events: none;" : ""}">
            </div>
        `;
            })
            .join("");

        modal.innerHTML = `
            <style>
                #stremio-mpv-modal {
                    position: fixed; inset: 0; z-index: 100000;
                    background: rgba(0,0,0,0.25);
                    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                    display: flex; align-items: center; justify-content: center;
                    font-family: 'Roboto', sans-serif;
                    opacity: 0; transition: opacity 0.3s ease;
                    color-scheme: dark;
                }
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                .mpv-modal-content {
                    background: rgba(15, 15, 15, 0.65); color: #eee;
                    padding: 24px; border-radius: 20px;
                    width: 450px; max-width: 90vw;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    box-shadow: 0 20px 50px rgba(0,0,0,0.6);
                    max-height: 90vh; overflow: hidden;
                    display: flex; flex-direction: column;
                    transform: scale(0.9); transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                }
                #stremio-mpv-modal.active { opacity: 1; }
                #stremio-mpv-modal.active .mpv-modal-content { transform: scale(1); }

                .mpv-modal-header {
                    font-size: 22px; font-weight: bold; margin-bottom: 24px;
                    display: flex; align-items: center;
                }
                .mpv-modal-title {
                    background: linear-gradient(45deg, #a78bfa, #8b5cf6);
                    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                }
                .mpv-tab-nav {
                    display: flex; gap: 8px;
                    margin: -6px 0 16px;
                    padding: 5px;
                    border-radius: 12px;
                    background: rgba(255, 255, 255, 0.03);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                }
                .mpv-tab-btn {
                    flex: 1;
                    border: 1px solid transparent;
                    border-radius: 8px;
                    background: transparent;
                    color: #b8b8c2;
                    font-size: 13px;
                    font-weight: 600;
                    padding: 10px 8px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    line-height: 1;
                    margin: 0;
                }
                .mpv-tab-btn:hover {
                    color: #fff;
                    background: rgba(139, 92, 246, 0.15);
                }
                .mpv-tab-btn.active {
                    color: #fff;
                    background: linear-gradient(135deg, rgba(139, 92, 246, 0.35), rgba(124, 58, 237, 0.2));
                    border-color: rgba(139, 92, 246, 0.45);
                    box-shadow: 0 6px 16px rgba(139, 92, 246, 0.25);
                }
                .mpv-modal-body {
                    flex: 1;
                    min-height: 0;
                    overflow-y: auto;
                    padding-right: 2px;
                }
                .mpv-tab-panel { display: none; animation: tabFade 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
                .mpv-tab-panel.active { display: block; }
                @keyframes tabFade {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .mpv-form-group { margin-bottom: 18px; }
                .mpv-label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 500; color: #a78bfa; text-transform: uppercase; letter-spacing: 0.5px; }
                .mpv-input {
                    width: 100%; padding: 12px; background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
                    color: white; font-size: 14px; transition: all 0.2s ease;
                }
                .mpv-input:focus { outline: none; border-color: #8b5cf6; background: rgba(255, 255, 255, 0.08); box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.2); }
                .mpv-help { font-size: 12px; opacity: 0.5; margin-top: 6px; line-height: 1.4; }
                .mpv-actions {
                    display: flex; justify-content: flex-end; gap: 12px; margin-top: 18px;
                    padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08);
                    flex-shrink: 0;
                }
                .mpv-btn {
                    padding: 10px 20px; border-radius: 8px; cursor: pointer;
                    border: none; font-weight: 600; font-size: 14px; transition: all 0.2s ease;
                }
                .mpv-btn-cancel { background: transparent; color: #aaa; }
                .mpv-btn-cancel:hover { color: white; background: rgba(255,255,255,0.05); }
                .mpv-btn-save { background: #8b5cf6; color: white; box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3); }
                .mpv-btn-save:hover { background: #7c3aed; transform: translateY(-1px); box-shadow: 0 6px 15px rgba(139, 92, 246, 0.4); }

                .mpv-checkbox-group {
                    display: flex; align-items: center; gap: 12px;
                    background: rgba(255, 255, 255, 0.03); padding: 12px; border-radius: 10px;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
                .mpv-checkbox {
                    width: 18px; height: 18px; min-width: 18px; min-height: 18px;
                    cursor: pointer; accent-color: #8b5cf6;
                    appearance: auto; -webkit-appearance: checkbox;
                    margin: 0; filter: invert(0.8) hue-rotate(180deg) brightness(0.7);
                }
                .mpv-drag-handle:hover { color: #fff !important; }
                .mpv-provider-item.dragging { opacity: 0.4; transform: scale(0.98); border-radius: 8px; background: rgba(139, 92, 246, 0.05); }
                .mpv-provider-item.drag-over { background: rgba(139, 92, 246, 0.05); }
                .mpv-provider-item.mpv-provider-disabled { opacity: 0.55; }
                .mpv-provider-item.mpv-provider-disabled .mpv-provider-label { color: #888; }
                .mpv-toggle-track {
                    width: 36px; height: 20px; min-width: 36px;
                    background: rgba(255,255,255,0.1);
                    border-radius: 10px;
                    position: relative;
                    cursor: pointer;
                    transition: background 0.25s ease, box-shadow 0.25s ease;
                    outline: none;
                    flex-shrink: 0;
                }
                .mpv-toggle-track:focus-visible { box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.5); }
                .mpv-toggle-track[data-enabled="true"] { background: #8b5cf6; }
                .mpv-toggle-thumb {
                    width: 16px; height: 16px;
                    background: white;
                    border-radius: 50%;
                    position: absolute; top: 2px; left: 2px;
                    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
                    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                }
                .mpv-toggle-track[data-enabled="true"] .mpv-toggle-thumb { transform: translateX(16px); }
                .mpv-btn-add { background: transparent; border: 1px dashed rgba(139, 92, 246, 0.5); color: #a78bfa; padding: 8px 16px; width: 100%; margin-bottom: 8px; position: relative; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
                .mpv-btn-add:hover { border-color: #8b5cf6; background: rgba(139, 92, 246, 0.1); color: #fff; }
                .mpv-btn-remove { background: transparent; border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; width: 28px; height: 28px; font-size: 14px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer; transition: all 0.2s ease; }
                .mpv-btn-remove:hover { background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #fff; transform: scale(1.05); }
                .mpv-dropdown { position: relative; display: inline-block; width: 100%; margin-bottom: 8px; }
                .mpv-dropdown-content {
                    display: none; position: fixed;
                    top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95);
                    opacity: 0;
                    background: rgba(15, 15, 20, 0.95);
                    backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);
                    border: 1px solid rgba(139, 92, 246, 0.4);
                    border-radius: 16px; padding: 20px; z-index: 100002;
                    min-width: 320px; max-width: 400px;
                    max-height: 80vh; overflow-y: auto;
                    box-shadow: 0 25px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08) inset, 0 0 60px rgba(139, 92, 246, 0.15);
                }
                  .mpv-dropdown-content.show { display: block; animation: submenuPop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
                  @keyframes submenuPop { from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
                .mpv-dropdown-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100001; display: none; }
                .mpv-dropdown-overlay.show { display: block; animation: overlayFade 0.2s ease; }
                @keyframes overlayFade { from { opacity: 0; } to { opacity: 1; } }
                .mpv-dropdown-title { font-size: 16px; font-weight: 600; color: #fff; text-align: center; margin-bottom: 12px; }
                .mpv-dropdown-category {
                    padding: 10px 16px 6px; font-size: 10px; color: #a78bfa;
                    text-transform: uppercase; letter-spacing: 1px; font-weight: 600;
                    margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 14px;
                }
                .mpv-dropdown-category:first-of-type { margin-top: 0; border-top: none; padding-top: 6px; }
                .mpv-dropdown-item {
                    padding: 10px 16px; cursor: pointer; border-radius: 10px; transition: all 0.2s ease;
                    display: flex; align-items: center; justify-content: space-between; font-size: 14px; color: #eee;
                }
                .mpv-dropdown-item:hover { background: linear-gradient(90deg, rgba(139, 92, 246, 0.2), rgba(139, 92, 246, 0.05)); color: #fff; padding-left: 20px; }
                .mpv-dropdown-item.disabled { opacity: 0.4; cursor: not-allowed; text-decoration: line-through; }
                .mpv-radio {
                    appearance: none; -webkit-appearance: none;
                    width: 18px; height: 18px; border: 2px solid rgba(139, 92, 246, 0.4);
                    border-radius: 50%; outline: none; transition: all 0.2s ease;
                    position: relative; cursor: pointer; flex-shrink: 0;
                    margin: 0;
                    display: flex; align-items: center; justify-content: center;
                    box-sizing: border-box;
                }
                .mpv-radio:checked { border-color: #8b5cf6; background: rgba(139, 92, 246, 0.2); }
                .mpv-radio:checked::after {
                    content: '';
                    width: 8px; height: 8px; border-radius: 50%; background: #8b5cf6;
                    box-shadow: 0 0 5px rgba(139, 92, 246, 0.5);
                    display: block;
                }
                .mpv-radio-option label { line-height: 1; }
                .mpv-pill-btn {
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    color: #ccc;
                    padding: 8px 14px;
                    border-radius: 20px;
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .mpv-pill-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                    color: white;
                }
                .mpv-pill-btn.active {
                    background: rgba(139, 92, 246, 0.8);
                    color: white;
                    border-color: #8b5cf6;
                    box-shadow: 0 0 10px rgba(139, 92, 246, 0.3);
                }
                #mpv-release-groups-dropdown .mpv-group-option:hover {
                    background: rgba(139, 92, 246, 0.2) !important;
                }
            </style>
            <div class="mpv-modal-content">
                <div class="mpv-modal-header">
                    <span class="mpv-modal-title">MPV Bridge Settings</span>
                    <span style="font-size: 14px; opacity: 0.6; font-weight: normal; margin-left: 8px;">v${GM_info.script.version}</span>
                    <span id="mpv-server-status" title="Checking server status..." style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #fbbf24; margin-left: auto; box-shadow: 0 0 8px rgba(251, 191, 36, 0.4); transition: all 0.3s ease; flex-shrink: 0; cursor: help;"></span>
                </div>

                <div class="mpv-tab-nav" role="tablist" aria-label="Settings Tabs">
                    <button type="button" class="mpv-tab-btn active" data-tab="providers" role="tab" aria-selected="true">Providers</button>
                    <button type="button" class="mpv-tab-btn" data-tab="playback" role="tab" aria-selected="false">Playback</button>
                    <button type="button" class="mpv-tab-btn" data-tab="advanced" role="tab" aria-selected="false">Advanced</button>
                </div>

                <div class="mpv-modal-body">
                    <div class="mpv-tab-panel active" data-tab-panel="providers" role="tabpanel">
                        <div id="mpv-providers-container">
                            ${providersHTML}
                        </div>

                        <div class="mpv-dropdown">
                            <button class="mpv-btn mpv-btn-add" id="mpv-add-provider-btn">+ Add Provider</button>
                            <div class="mpv-dropdown-overlay" id="mpv-dropdown-overlay"></div>
                            <div class="mpv-dropdown-content" id="mpv-provider-dropdown">
                                <div class="mpv-dropdown-title">Select Provider</div>
                                <div class="mpv-dropdown-category">Providers</div>
                                ${AVAILABLE_PROVIDERS.providers.map((p) => `<div class="mpv-dropdown-item" data-id="${p.id}" data-name="${p.name}">${p.name}</div>`).join("")}
                                <div class="mpv-dropdown-category">Debrid Services</div>
                                ${AVAILABLE_PROVIDERS.debrid.map((p) => `<div class="mpv-dropdown-item" data-id="${p.id}" data-name="${p.name}">${p.name}</div>`).join("")}
                                <div style="margin-top: 16px; padding: 12px 16px; font-size: 12px; color: #666; text-align: center; border-top: 1px solid rgba(255,255,255,0.08);">
                                    Missing your favorite service? <a href="https://github.com/gabszap/mpv-rpc/issues" target="_blank" style="color: #8b7bba; text-decoration: underline; font-size: 13px;">open an issue</a>
                                </div>
                            </div>
                        </div>
                        <button class="mpv-btn mpv-btn-add" id="mpv-add-custom">+ Add Custom</button>
                        <div class="mpv-help" style="margin-bottom: 20px; color: #aaa;">Copy the link from the addon's "Share" button.</div>
                    </div>

                    <div class="mpv-tab-panel" data-tab-panel="playback" role="tabpanel">
                        <div class="mpv-form-group">
                            <label class="mpv-label">Stream Mode</label>

                            <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; margin-bottom: 8px; background: ${playlistMode === "single" ? "rgba(139, 92, 246, 0.12)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${playlistMode === "single" ? "rgba(139, 92, 246, 0.4)" : "rgba(255,255,255,0.08)"}; transition: all 0.2s ease;">
                                <input type="radio" name="mpv-stream-mode" id="mpv-mode-single" value="single" class="mpv-radio" ${playlistMode === "single" ? "checked" : ""}>
                                <div style="pointer-events: none; flex: 1;">
                                    <label for="mpv-mode-single" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Single Episode</label>
                                    <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Load only the selected episode</div>
                                </div>
                            </div>

                            <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; margin-bottom: 8px; background: ${playlistMode === "batch" ? "rgba(139, 92, 246, 0.12)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${playlistMode === "batch" ? "rgba(139, 92, 246, 0.4)" : "rgba(255,255,255,0.08)"}; transition: all 0.2s ease;">
                                <input type="radio" name="mpv-stream-mode" id="mpv-mode-batch" value="batch" class="mpv-radio" ${playlistMode === "batch" ? "checked" : ""}>
                                <div style="pointer-events: none; flex: 1;">
                                    <label for="mpv-mode-batch" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Batch Episodes</label>
                                    <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Load selected + next episodes</div>
                                </div>
                            </div>

                            <div id="mpv-group-count" style="margin-bottom: 15px; padding-left: 42px; ${playlistMode !== "batch" ? "display:none" : ""}">
                                <label class="mpv-label" style="font-size: 11px; color: #a78bfa; margin-bottom: 4px;">Next episodes to load</label>
                                <input type="number" id="mpv-ep-count" class="mpv-input" value="${extraEpisodes}" min="1" max="25" style="width: 70px; padding: 8px;">
                            </div>

                            <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; background: ${playlistMode === "all" ? "rgba(139, 92, 246, 0.12)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${playlistMode === "all" ? "rgba(139, 92, 246, 0.4)" : "rgba(255,255,255,0.08)"}; transition: all 0.2s ease;">
                                <input type="radio" name="mpv-stream-mode" id="mpv-mode-all" value="all" class="mpv-radio" ${playlistMode === "all" ? "checked" : ""}>
                                <div style="pointer-events: none; flex: 1;">
                                    <label for="mpv-mode-all" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Load All</label>
                                    <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Loads all remaining episodes (may take a while)</div>
                                </div>
                            </div>
                        </div>

                        <div class="mpv-form-group">
                            <label class="mpv-label">Preferred Release Group</label>
                            <div style="position: relative;">
                                <input type="text" id="mpv-preferred-group" class="mpv-input" placeholder="e.g. subsplease, judas" value="${preferredGroup}">
                                <div id="mpv-release-groups-dropdown" style="display: none; position: fixed; max-height: 200px; overflow-y: auto; background: #151515; border: 1px solid rgba(139, 92, 246, 0.4); border-radius: 8px; z-index: 100003; box-shadow: 0 4px 15px rgba(0,0,0,0.5);"></div>
                            </div>
                            <div class="mpv-help" style="margin-top: 4px;">Bridge will try to pick streams from this group.</div>
                        </div>

                        <div class="mpv-form-group">
                            <label class="mpv-label">Preferred Quality</label>
                            <div class="mpv-quality-pills" style="display: flex; gap: 8px; flex-wrap: wrap;">
                                ${["4K", "2K", "1080p", "720p", "Unknown"]
                                    .map((q) => {
                                        const isActive = preferredQuality
                                            .split(",")
                                            .map((s) => s.trim())
                                            .includes(q);
                                        return `<button type="button" class="mpv-pill-btn ${isActive ? "active" : ""}" data-quality="${q}">${q}</button>`;
                                    })
                                    .join("")}
                            </div>
                            <input type="hidden" id="mpv-preferred-quality" value="${preferredQuality}">
                            <div class="mpv-help" style="margin-top: 6px;">Bridge will prioritize these resolutions.</div>
                        </div>

                        <div class="mpv-form-group">
                            <label class="mpv-label">Keyboard Shortcut</label>
                            <button type="button" id="mpv-shortcut-btn" class="mpv-input" style="width: 80px; text-align: center; text-transform: uppercase; font-weight: bold; cursor: pointer; border: 1px dashed rgba(139, 92, 246, 0.5);">${mpvShortcut.toUpperCase()}</button>
                            <input type="hidden" id="mpv-shortcut" value="${mpvShortcut}">
                            <div class="mpv-help" style="margin-top: 4px;">Click and press a key</div>
                        </div>
                    </div>

                    <div class="mpv-tab-panel" data-tab-panel="advanced" role="tabpanel">
                        <div class="mpv-form-group">
                            <label class="mpv-label">Debug Mode</label>
                            <div class="mpv-checkbox-group" style="justify-content: space-between;">
                                <span style="font-size: 13px; color: #ccc;">Log detailed info to browser console</span>
                                <div class="mpv-toggle-track mpv-debug-toggle" data-enabled="${GM_getValue("debug", false) ? "true" : "false"}" role="switch" aria-checked="${GM_getValue("debug", false) ? "true" : "false"}" tabindex="0" title="${GM_getValue("debug", false) ? "Enabled" : "Disabled"}">
                                    <div class="mpv-toggle-thumb"></div>
                                </div>
                            </div>
                        </div>

                        <div class="mpv-form-group">
                            <label class="mpv-label">Direct Link</label>
                            <div style="display: flex; gap: 8px;">
                                <input type="text" id="mpv-direct-link" class="mpv-input" placeholder="Paste stream URL here..." style="flex: 1;">
                                <button class="mpv-btn mpv-btn-save" id="mpv-open-link" style="padding: 10px 16px; white-space: nowrap;">▶ Open</button>
                            </div>
                            <div class="mpv-help" style="margin-top: 4px;">Open any URL directly in MPV</div>
                        </div>

                        <div class="mpv-form-group" style="margin-top: 30px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 20px;">
                            <label class="mpv-label">Custom MPV Arguments</label>
                            <input type="text" id="mpv-custom-args" class="mpv-input" placeholder="e.g. --fs --volume=50" value="${mpvArgsStr}">
                            <div class="mpv-help" style="margin-top: 4px;">Pass extra flags to MPV. See <a href="https://github.com/mpv-player/mpv/blob/master/DOCS/man/options.rst" target="_blank" style="color: #a78bfa;">MPV manual</a></div>
                            <div style="margin-top: 12px;">
                                <span style="font-size: 11px; color: #a78bfa; margin-bottom: 6px; display: block; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Presets</span>
                                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                    <button type="button" class="mpv-btn mpv-preset-btn" data-preset="--profile=gpu-hq --hwdec=auto --video-sync=display-resample --interpolation --tscale=oversample" style="flex: 1; font-size: 13px; padding: 10px 14px; background: rgba(255,255,255,0.05); color: #eee; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; transition: all 0.2s;">High Quality</button>
                                    <button type="button" class="mpv-btn mpv-preset-btn" data-preset="--profile=high-quality --hwdec=auto --deband=yes --prefetch-playlist=yes --cache=yes --demuxer-max-bytes=400MiB --demuxer-max-back-bytes=50MiB --user-agent=&quot;Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko&quot;" style="flex: 1; font-size: 13px; padding: 10px 14px; background: rgba(255,255,255,0.05); color: #eee; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; transition: all 0.2s;">Anime</button>
                                    <button type="button" class="mpv-btn mpv-preset-btn" data-preset="--profile=fast --hwdec=auto" style="flex: 1; font-size: 13px; padding: 10px 14px; background: rgba(255,255,255,0.05); color: #eee; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; transition: all 0.2s;">Low End</button>
                                </div>
                            </div>
                        </div>

                        <div class="mpv-form-group" style="margin-top: 30px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 20px;">
                            <label class="mpv-label" style="color: #ef4444;">Danger Zone</label>
                            <button class="mpv-btn" id="mpv-reset-defaults" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; width: 100%; font-weight: 600; padding: 12px; transition: all 0.2s ease;">Reset to Defaults</button>
                            <div class="mpv-help" style="margin-top: 6px; text-align: center;">Reset all settings and providers to their default values</div>
                        </div>
                    </div>
                </div>

                <div class="mpv-actions">
                    <button class="mpv-btn mpv-btn-cancel" id="mpv-cancel">Cancel</button>
                    <button class="mpv-btn mpv-btn-save" id="mpv-save">Save</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        requestAnimationFrame(() => modal.classList.add("active"));

        // Populate release group dropdown
        try {
            const groupInput = modal.querySelector("#mpv-preferred-group");
            const groupDropdown = modal.querySelector("#mpv-release-groups-dropdown");
            if (groupInput && groupDropdown) {
                // Break out of overflow by appending directly to the modal
                if (groupDropdown.parentElement !== modal) {
                    modal.appendChild(groupDropdown);
                }

                const POPULAR_GROUPS = [
                    "ASW",
                    "Cleo",
                    "Commie",
                    "EMBER",
                    "Erai-raws",
                    "Golumpa",
                    "HorribleSubs",
                    "Judas",
                    "Kitten",
                    "MTBB",
                    "NoobSubs",
                    "Seadex",
                    "SubsPlease",
                    "ToonsHub",
                    "VARYG",
                    "Yameii",
                    "Yousei-raws",
                ];

                const updateDropdown = () => {
                    const val = groupInput.value;
                    const parts = val.split(",");
                    const currentTerm = parts[parts.length - 1].trim().toLowerCase();

                    const selectedGroups = parts.slice(0, parts.length - 1).map((p) => p.trim().toLowerCase());
                    const availableGroups = POPULAR_GROUPS.filter((g) => !selectedGroups.includes(g.toLowerCase()));

                    let matches = availableGroups;
                    if (currentTerm) {
                        const startsWithMatch = [];
                        const includesMatch = [];
                        for (const g of availableGroups) {
                            const lowerG = g.toLowerCase();
                            if (lowerG.startsWith(currentTerm)) {
                                startsWithMatch.push(g);
                            } else if (lowerG.includes(currentTerm)) {
                                includesMatch.push(g);
                            }
                        }
                        matches = [...startsWithMatch, ...includesMatch];
                    }

                    if (matches.length === 0) {
                        groupDropdown.style.display = "none";
                        return;
                    }

                    groupDropdown.innerHTML = matches
                        .map(
                            (g) =>
                                `<div class="mpv-group-option" style="padding: 8px 12px; cursor: pointer; color: #eee; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.2s;">${g}</div>`,
                        )
                        .join("");
                    groupDropdown.style.display = "block";

                    const rect = groupInput.getBoundingClientRect();
                    groupDropdown.style.left = `${rect.left}px`;
                    groupDropdown.style.width = `${rect.width}px`;

                    const dropdownHeight = groupDropdown.offsetHeight;
                    if (rect.bottom + dropdownHeight + 4 > window.innerHeight) {
                        groupDropdown.style.top = `${rect.top - dropdownHeight - 4}px`;
                    } else {
                        groupDropdown.style.top = `${rect.bottom + 4}px`;
                    }

                    groupDropdown.querySelectorAll(".mpv-group-option").forEach((opt) => {
                        opt.addEventListener("click", (e) => {
                            e.stopPropagation();
                            parts[parts.length - 1] = (parts.length > 1 ? " " : "") + opt.textContent;
                            groupInput.value = `${parts.join(",").trim()}, `;
                            groupInput.focus();
                            updateDropdown(); // Refresh options after selection
                        });
                    });
                };

                groupInput.addEventListener("input", updateDropdown);
                groupInput.addEventListener("focus", updateDropdown);

                // Hide when scrolling the modal body so the fixed dropdown doesn't float away
                const modalBody = modal.querySelector(".mpv-modal-body");
                if (modalBody) {
                    modalBody.addEventListener("scroll", () => {
                        if (groupDropdown.style.display === "block") {
                            groupDropdown.style.display = "none";
                            groupInput.blur();
                        }
                    });
                }

                document.addEventListener("click", (e) => {
                    if (e.target !== groupInput && !groupDropdown.contains(e.target)) {
                        groupDropdown.style.display = "none";
                    }
                });
            }
        } catch (e) {
            console.warn("Error populating release groups:", e);
        }

        // Resolve and update custom provider names asynchronously
        updateProviderLabels(modal);

        // Check server status
        const statusDot = modal.querySelector("#mpv-server-status");
        if (statusDot) {
            checkServer().then((isOnline) => {
                if (isOnline) {
                    statusDot.style.background = "#10b981";
                    statusDot.style.boxShadow = "0 0 8px rgba(16, 185, 129, 0.4)";
                    statusDot.title = "Server Online";
                } else {
                    statusDot.style.background = "#ef4444";
                    statusDot.style.boxShadow = "0 0 8px rgba(239, 68, 68, 0.4)";
                    statusDot.title = "Server Offline. Start the bridge: npm run bridge";
                }
            });
        }

        const tabButtons = modal.querySelectorAll(".mpv-tab-btn");
        const tabPanels = modal.querySelectorAll(".mpv-tab-panel");
        const providerDropdown = modal.querySelector("#mpv-provider-dropdown");
        const dropdownOverlay = modal.querySelector("#mpv-dropdown-overlay");

        const switchTab = (tabName) => {
            tabButtons.forEach((button) => {
                const isActive = button.dataset.tab === tabName;
                button.classList.toggle("active", isActive);
                button.setAttribute("aria-selected", isActive ? "true" : "false");
            });

            tabPanels.forEach((panel) => {
                panel.classList.toggle("active", panel.dataset.tabPanel === tabName);
            });

            providerDropdown?.classList.remove("show");
            dropdownOverlay?.classList.remove("show");
            const groupDropdown = modal.querySelector("#mpv-release-groups-dropdown");
            if (groupDropdown) groupDropdown.style.display = "none";
        };

        tabButtons.forEach((button, index) => {
            button.addEventListener("click", () => switchTab(button.dataset.tab));

            // Accessibility: Keyboard navigation for tabs
            button.addEventListener("keydown", (e) => {
                let nextIndex = index;
                if (e.key === "ArrowRight") {
                    nextIndex = (index + 1) % tabButtons.length;
                    e.preventDefault();
                } else if (e.key === "ArrowLeft") {
                    nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
                    e.preventDefault();
                }

                if (nextIndex !== index) {
                    tabButtons[nextIndex].focus();
                    switchTab(tabButtons[nextIndex].dataset.tab);
                }
            });
        });

        const countGroup = modal.querySelector("#mpv-group-count");
        const radioButtons = modal.querySelectorAll('input[name="mpv-stream-mode"]');
        const radioOptions = modal.querySelectorAll(".mpv-radio-option");

        const updateRadioStyles = () => {
            radioOptions.forEach((option, _index) => {
                const radio = option.querySelector('input[type="radio"]');
                if (radio.checked) {
                    option.style.background = "rgba(139, 92, 246, 0.15)";
                    option.style.borderColor = "rgba(139, 92, 246, 0.4)";
                } else {
                    option.style.background = "transparent";
                    option.style.borderColor = "rgba(255,255,255,0.08)";
                }
            });
            // Show count input only for batch mode
            const batchRadio = modal.querySelector("#mpv-mode-batch");
            countGroup.style.display = batchRadio.checked ? "block" : "none";
        };

        radioButtons.forEach((radio) => {
            radio.addEventListener("change", updateRadioStyles);
        });

        radioOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const radio = option.querySelector('input[type="radio"]');
                radio.checked = true;
                updateRadioStyles();
            });
        });

        // Quality Pill Buttons
        const pillBtns = modal.querySelectorAll(".mpv-pill-btn");
        const qualityInput = modal.querySelector("#mpv-preferred-quality");
        pillBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                btn.classList.toggle("active");
                const activeQualities = Array.from(modal.querySelectorAll(".mpv-pill-btn.active")).map(
                    (b) => b.dataset.quality,
                );
                qualityInput.value = activeQualities.join(",");
            });
        });

        const closeModal = () => {
            modal.classList.remove("active");
            setTimeout(() => modal.remove(), 300);
            document.removeEventListener("keydown", handleEsc);
            stopBridgePolling();
        };

        // Track initial MPV args value to detect unsaved changes
        const initialMpvArgs = mpvArgsStr;
        const hasUnsavedMpvArgsChanges = () => {
            const currentArgsInput = modal.querySelector("#mpv-custom-args");
            return currentArgsInput && currentArgsInput.value.trim() !== initialMpvArgs;
        };

        const attemptClose = () => {
            if (hasUnsavedMpvArgsChanges()) {
                showConfirmModal(
                    "Unsaved Changes",
                    "You have unsaved changes. Discard them?",
                    () => closeModal(),
                    "Discard",
                    "Stay",
                );
            } else {
                closeModal();
            }
        };

        const handleEsc = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                attemptClose();
            }
        };
        document.addEventListener("keydown", handleEsc);

        // Presets logic — apply to the input only; persist on Save
        modal.querySelectorAll(".mpv-preset-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                const preset = e.target.dataset.preset;
                const input = modal.querySelector("#mpv-custom-args");
                if (input) {
                    input.value = preset;
                }
            });
        });

        modal.querySelector("#mpv-cancel").addEventListener("click", attemptClose);
        modal.querySelector("#mpv-save").addEventListener("click", () => {
            saveConfig();
            closeModal();
        });

        modal.querySelector("#mpv-reset-defaults")?.addEventListener("click", () => {
            showConfirmModal(
                "Reset Settings",
                "Are you sure you want to reset all settings to their defaults? This cannot be undone.",
                () => {
                    GM_setValue("providers", DEFAULT_ACTIVE);
                    GM_setValue("playlistMode", "batch");
                    GM_setValue("extraEpisodes", 2);
                    GM_setValue("mpvShortcut", "v");
                    GM_setValue("preferredGroup", "");
                    GM_setValue("preferredQuality", "");
                    GM_setValue("mpvArgsStr", "");

                    GM_setValue("debug", false);

                    providers = [...DEFAULT_ACTIVE];
                    playlistMode = "batch";
                    extraEpisodes = 2;
                    mpvShortcut = "v";
                    preferredGroup = "";
                    preferredQuality = "";
                    mpvArgsStr = "";

                    showToast("Settings reset to defaults", "success");
                    closeModal();
                },
                "Yes, Reset",
            );
        });

        // Hover effect for reset button since it's inline styled mainly
        const resetBtn = modal.querySelector("#mpv-reset-defaults");
        if (resetBtn) {
            resetBtn.addEventListener("mouseenter", () => {
                resetBtn.style.background = "rgba(239, 68, 68, 0.25)";
            });
            resetBtn.addEventListener("mouseleave", () => {
                resetBtn.style.background = "rgba(239, 68, 68, 0.15)";
            });
        }

        // Direct Link functionality
        const openDirectLink = async (forceOpen = false) => {
            const linkInput = modal.querySelector("#mpv-direct-link");
            const url = linkInput?.value?.trim();
            const directLinkGroup = linkInput?.closest(".mpv-form-group");

            // Remove any existing "Open Anyway" button
            const existingForceBtn = directLinkGroup?.querySelector(".mpv-force-open-btn");
            if (existingForceBtn) existingForceBtn.remove();

            if (!url) {
                showToast("Please paste a URL first", "error");
                return;
            }

            // Block URLs with URL-encoded characters (broken links) - unless forced
            if (!forceOpen && /%[0-9A-Fa-f]{2}/.test(url)) {
                showToast("URL contains encoded characters - may not work correctly", "error");

                // Add "Open Anyway" button
                const forceBtn = document.createElement("button");
                forceBtn.className = "mpv-btn mpv-force-open-btn";
                forceBtn.textContent = "⚠️ Open Anyway";
                forceBtn.style.cssText =
                    "margin-top: 8px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #ef4444; width: 100%; padding: 8px;";
                forceBtn.addEventListener("click", () => openDirectLink(true));

                directLinkGroup?.appendChild(forceBtn);
                return;
            }

            // Extract title from URL
            let title;
            try {
                const urlObj = new URL(url);
                const pathname = urlObj.pathname;
                const filename = pathname.split("/").pop() || "";
                title = filename
                    .replace(/\.[^.]+$/, "")
                    .replace(/[._-]/g, " ")
                    .trim();
                if (!title || title.length < 3) {
                    title = urlObj.hostname;
                }
            } catch {
                title = "Direct Link";
            }

            try {
                if (!(await checkServer())) {
                    showToast("Server offline! Run: npm run bridge", "error");
                    return;
                }

                const openBtn = modal.querySelector("#mpv-open-link");
                openBtn.textContent = "⏳";
                openBtn.disabled = true;

                await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "POST",
                        url: `${CONFIG.SERVER_URL}/play`,
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({
                            playlist: [{ url, title }],
                            contentTitle: title,
                            args: mpvArgsStr,
                        }),
                        onload: (r) => (r.status === 200 ? resolve() : reject(new Error("Server error"))),
                        onerror: () => reject(new Error("Connection failed")),
                    });
                });

                showToast("Opening in MPV...", "success");
                linkInput.value = "";
                openBtn.textContent = "▶ Open";
                openBtn.disabled = false;
            } catch (err) {
                showToast(`Failed: ${err.message}`, "error");
                const openBtn = modal.querySelector("#mpv-open-link");
                openBtn.textContent = "▶ Open";
                openBtn.disabled = false;
            }
        };

        modal.querySelector("#mpv-open-link").addEventListener("click", () => openDirectLink(false));

        // Keyboard shortcut capture
        const shortcutBtn = modal.querySelector("#mpv-shortcut-btn");
        const shortcutInput = modal.querySelector("#mpv-shortcut");
        let capturingShortcut = false;

        shortcutBtn.addEventListener("click", () => {
            capturingShortcut = true;
            shortcutBtn.textContent = "...";
            shortcutBtn.style.borderColor = "#8b5cf6";
            shortcutBtn.style.animation = "pulse 1s infinite";
        });

        document.addEventListener(
            "keydown",
            (e) => {
                if (!capturingShortcut) return;
                e.preventDefault();
                e.stopPropagation();

                const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
                shortcutInput.value = key;
                shortcutBtn.textContent = key.toUpperCase();
                shortcutBtn.style.borderColor = "rgba(139, 92, 246, 0.5)";
                shortcutBtn.style.animation = "";
                capturingShortcut = false;
            },
            true,
        );

        modal.querySelectorAll(".mpv-provider-toggle").forEach((toggle) => {
            toggle.addEventListener("click", (e) => {
                const track = e.currentTarget;
                const isEnabled = track.dataset.enabled === "true";
                const newEnabled = !isEnabled;
                track.dataset.enabled = newEnabled ? "true" : "false";
                track.setAttribute("aria-checked", newEnabled ? "true" : "false");
                track.title = newEnabled ? "Enabled" : "Disabled";
                const item = track.closest(".mpv-provider-item");
                if (item) item.classList.toggle("mpv-provider-disabled", !newEnabled);
                const input = modal.querySelector(`.mpv-provider-input[data-id="${track.dataset.id}"]`);
                if (input) {
                    input.style.opacity = newEnabled ? "1" : "0.5";
                    input.style.pointerEvents = newEnabled ? "auto" : "none";
                }
            });
            toggle.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle.click();
                }
            });
        });

        const debugToggle = modal.querySelector(".mpv-debug-toggle");
        if (debugToggle) {
            debugToggle.addEventListener("click", () => {
                const isEnabled = debugToggle.dataset.enabled === "true";
                const newEnabled = !isEnabled;
                debugToggle.dataset.enabled = newEnabled ? "true" : "false";
                debugToggle.setAttribute("aria-checked", newEnabled ? "true" : "false");
                debugToggle.title = newEnabled ? "Enabled" : "Disabled";
                GM_setValue("debug", newEnabled);
            });
            debugToggle.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    debugToggle.click();
                }
            });
        }

        // Update provider name when URL input changes (on blur)
        modal.querySelectorAll(".mpv-provider-input").forEach((input) => {
            input.addEventListener("blur", (e) => {
                const providerId = e.target.dataset.id;
                const url = e.target.value.trim();
                if (providerId.startsWith("custom") && url) {
                    updateSingleProviderLabel(modal, providerId, url);
                }
            });
        });

        // Add Provider dropdown
        const addProviderBtn = modal.querySelector("#mpv-add-provider-btn");

        if (addProviderBtn && providerDropdown) {
            const showDropdown = () => {
                // Update disabled state for already added providers
                const container = modal.querySelector("#mpv-providers-container");
                providerDropdown.querySelectorAll(".mpv-dropdown-item").forEach((item) => {
                    const exists = container.querySelector(`[data-id="${item.dataset.id}"]`);
                    item.classList.toggle("disabled", !!exists);
                });

                // Break out of overflow:hidden by appending to the modal root
                modal.appendChild(dropdownOverlay);
                modal.appendChild(providerDropdown);

                providerDropdown.classList.add("show");
                dropdownOverlay?.classList.add("show");
            };

            const hideDropdown = () => {
                providerDropdown.classList.remove("show");
                dropdownOverlay?.classList.remove("show");
            };

            addProviderBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (providerDropdown.classList.contains("show")) {
                    hideDropdown();
                } else {
                    showDropdown();
                }
            });

            dropdownOverlay?.addEventListener("click", hideDropdown);
        }

        providerDropdown.addEventListener("click", (e) => {
            const item = e.target.closest(".mpv-dropdown-item");
            if (!item || item.classList.contains("disabled")) return;

            const id = item.dataset.id;
            const name = item.dataset.name;
            const container = modal.querySelector("#mpv-providers-container");

            const newProviderHTML = `
                <div class="mpv-form-group mpv-provider-item" data-id="${id}" draggable="true" style="transition: transform 0.2s, opacity 0.2s;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
                            <button type="button" class="mpv-drag-handle" title="Drag to reorder" style="background: transparent; border: none; color: #666; cursor: grab; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s; font-size: 16px; flex-shrink: 0;">☰</button>
                            <div class="mpv-toggle-track mpv-provider-toggle" data-id="${id}" data-enabled="true" role="switch" aria-checked="true" tabindex="0" title="Enabled">
                                <div class="mpv-toggle-thumb"></div>
                            </div>
                            <label class="mpv-label" style="margin: 0; cursor: pointer; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name}</label>
                        </div>
                        <div style="display: flex; gap: 4px; flex-shrink: 0;">
                            <button type="button" class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">🗑</button>
                        </div>
                    </div>
                    <input type="text" data-id="${id}" class="mpv-input mpv-provider-input" placeholder="Paste manifest.json link here" value="">
                </div>
            `;

            // Insert before custom providers
            const firstCustom = container.querySelector('[data-id^="custom"]');
            if (firstCustom) {
                firstCustom.insertAdjacentHTML("beforebegin", newProviderHTML);
            } else {
                container.insertAdjacentHTML("beforeend", newProviderHTML);
            }

            providerDropdown.classList.remove("show");
            dropdownOverlay?.classList.remove("show");
        });

        // Add Custom Provider button
        modal.querySelector("#mpv-add-custom").addEventListener("click", () => {
            const container = modal.querySelector("#mpv-providers-container");
            const existingCustoms = container.querySelectorAll('[data-id^="custom"]');
            // Find the highest existing custom number
            let maxNum = 0;
            existingCustoms.forEach((el) => {
                const num = parseInt(el.dataset.id.replace("custom", ""), 10) || 0;
                if (num > maxNum) maxNum = num;
            });
            const newNum = maxNum + 1;
            const newId = `custom${newNum}`;

            const newProviderHTML = `
                <div class="mpv-form-group mpv-provider-item" data-id="${newId}" draggable="true" style="transition: transform 0.2s, opacity 0.2s;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
                            <button type="button" class="mpv-drag-handle" title="Drag to reorder" style="background: transparent; border: none; color: #666; cursor: grab; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s; font-size: 16px; flex-shrink: 0;">☰</button>
                            <div class="mpv-toggle-track mpv-provider-toggle" data-id="${newId}" data-enabled="true" role="switch" aria-checked="true" tabindex="0" title="Enabled">
                                <div class="mpv-toggle-thumb"></div>
                            </div>
                            <label class="mpv-label" style="margin: 0; cursor: pointer; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Custom ${newNum}</label>
                        </div>
                        <div style="display: flex; gap: 4px; flex-shrink: 0;">
                            <button type="button" class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">🗑</button>
                        </div>
                    </div>
                    <input type="text" data-id="${newId}" class="mpv-input mpv-provider-input" placeholder="Paste manifest.json link here" value="">
                </div>
            `;
            container.insertAdjacentHTML("beforeend", newProviderHTML);

            // Add toggle listener to new provider
            const newToggle = container.querySelector(`[data-id="${newId}"].mpv-provider-toggle`);
            newToggle?.addEventListener("click", (e) => {
                const track = e.currentTarget;
                const isEnabled = track.dataset.enabled === "true";
                const newEnabled = !isEnabled;
                track.dataset.enabled = newEnabled ? "true" : "false";
                track.setAttribute("aria-checked", newEnabled ? "true" : "false");
                track.title = newEnabled ? "Enabled" : "Disabled";
                const item = track.closest(".mpv-provider-item");
                if (item) item.classList.toggle("mpv-provider-disabled", !newEnabled);
                const input = container.querySelector(`.mpv-provider-input[data-id="${track.dataset.id}"]`);
                if (input) {
                    input.style.opacity = newEnabled ? "1" : "0.5";
                    input.style.pointerEvents = newEnabled ? "auto" : "none";
                }
            });
            newToggle?.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    newToggle.click();
                }
            });
        });

        // Remove provider buttons (delegated)
        modal.addEventListener("click", (e) => {
            const removeBtn = e.target.closest(".mpv-remove-provider");
            if (removeBtn) {
                const item = removeBtn.closest(".mpv-provider-item");
                if (item) item.remove();
            }
            if (e.target === modal) attemptClose();
        });

        // Drag and Drop Logic
        let draggedItem = null;

        modal.addEventListener("dragstart", (e) => {
            const item = e.target.closest(".mpv-provider-item");
            if (!item) return;
            draggedItem = item;
            setTimeout(() => item.classList.add("dragging"), 0);
            e.dataTransfer.effectAllowed = "move";
        });

        modal.addEventListener("dragend", (e) => {
            const item = e.target.closest(".mpv-provider-item");
            if (!item) return;
            item.classList.remove("dragging");
            draggedItem = null;
            modal.querySelectorAll(".mpv-provider-item").forEach((el) => {
                el.classList.remove("drag-over");
            });
        });

        modal.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";

            const item = e.target.closest(".mpv-provider-item");
            if (!item || item === draggedItem) return;

            const rect = item.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;

            modal.querySelectorAll(".mpv-provider-item").forEach((el) => {
                el.classList.remove("drag-over");
            });

            if (e.clientY < midpoint) {
                item.style.borderTop = "2px solid #8b5cf6";
                item.style.borderBottom = "";
            } else {
                item.style.borderTop = "";
                item.style.borderBottom = "2px solid #8b5cf6";
            }
            item.classList.add("drag-over");
        });

        modal.addEventListener("dragleave", (e) => {
            const item = e.target.closest(".mpv-provider-item");
            if (item) {
                item.style.borderTop = "";
                item.style.borderBottom = "";
                item.classList.remove("drag-over");
            }
        });

        modal.addEventListener("drop", (e) => {
            e.preventDefault();
            if (!draggedItem) return;

            const container = modal.querySelector("#mpv-providers-container");
            const item = e.target.closest(".mpv-provider-item");

            if (item && item !== draggedItem && container.contains(item)) {
                const rect = item.getBoundingClientRect();
                const midpoint = rect.top + rect.height / 2;
                if (e.clientY < midpoint) {
                    container.insertBefore(draggedItem, item);
                } else {
                    container.insertBefore(draggedItem, item.nextElementSibling);
                }
            }

            modal.querySelectorAll(".mpv-provider-item").forEach((el) => {
                el.style.borderTop = "";
                el.style.borderBottom = "";
                el.classList.remove("drag-over");
            });
        });
    }

    function saveConfig() {
        const modal = document.getElementById("stremio-mpv-modal");
        const countInput = modal.querySelector("#mpv-ep-count");
        const selectedMode = modal.querySelector('input[name="mpv-stream-mode"]:checked');
        const shortcutInput = modal.querySelector("#mpv-shortcut");
        const preferredGroupInput = modal.querySelector("#mpv-preferred-group");
        const preferredQualityInput = modal.querySelector("#mpv-preferred-quality");
        const customArgsInput = modal.querySelector("#mpv-custom-args");

        const providerItems = Array.from(modal.querySelectorAll(".mpv-provider-item"));

        providers = providerItems.map((item) => {
            const id = item.dataset.id;
            const input = item.querySelector(".mpv-provider-input");
            const toggle = item.querySelector(".mpv-provider-toggle");
            const label = item.querySelector(".mpv-label");
            let url = input ? input.value.trim() : "";
            if (url?.includes("/manifest.json")) {
                url = url.split("/manifest.json")[0];
            }
            const allProviders = [...AVAILABLE_PROVIDERS.providers, ...AVAILABLE_PROVIDERS.debrid];
            const knownProvider = allProviders.find((d) => d.id === id);
            const isEnabled = toggle ? toggle.dataset.enabled === "true" : true;
            return {
                id: id,
                name: knownProvider ? knownProvider.name : label?.textContent || id,
                url: url,
                enabled: isEnabled,
            };
        });

        GM_setValue("providers", providers);

        extraEpisodes = Math.max(1, Math.min(25, parseInt(countInput.value, 10) || 2));
        GM_setValue("extraEpisodes", extraEpisodes);

        playlistMode = selectedMode ? selectedMode.value : "batch";
        GM_setValue("playlistMode", playlistMode);

        mpvShortcut = (shortcutInput.value || "v").toLowerCase();
        GM_setValue("mpvShortcut", mpvShortcut);

        preferredGroup = preferredGroupInput ? preferredGroupInput.value.trim() : "";
        GM_setValue("preferredGroup", preferredGroup);

        preferredQuality = preferredQualityInput ? preferredQualityInput.value.trim() : "";
        GM_setValue("preferredQuality", preferredQuality);

        mpvArgsStr = customArgsInput ? customArgsInput.value.trim() : "";
        GM_setValue("mpvArgsStr", mpvArgsStr);

        const debugToggle = modal.querySelector(".mpv-debug-toggle");
        const debugEnabled = debugToggle ? debugToggle.dataset.enabled === "true" : GM_getValue("debug", false);
        GM_setValue("debug", debugEnabled);

        showToast("Settings saved!", "success");
    }

    // ==================== UI SCRAPER ====================
    function scrapeMetadata() {
        const metadata = {
            seriesName: null,
            episodeTitle: null,
            season: null,
            episode: null,
        };

        try {
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

            const titleEl = document.querySelector('[class*="title-label"]');
            if (titleEl?.innerText) {
                metadata.seriesName = titleEl.innerText.trim();
            } else {
                const logoEl = document.querySelector('img[class*="logo"]');
                if (logoEl?.title) {
                    metadata.seriesName = logoEl.title.trim();
                } else if (logoEl?.alt) {
                    metadata.seriesName = logoEl.alt.trim();
                }
            }

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

    // ==================== URL PARSER ====================
    function parseCurrentURL() {
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
            const result = {
                type: "series",
                imdbId: imdbMatch[1],
                seriesId: seriesId || imdbMatch[1],
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
            const result = {
                type: "series",
                imdbId: `kitsu:${kitsuMatch[1]}`,
                seriesId: seriesId || `kitsu:${kitsuMatch[1]}`,
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
            decodedHash.match(/(\w+)[:%]3A(\d+)[:%]3A(\d+)[:%]3A(\d+)/i) ||
            decodedHash.match(/(\w+):(\d+):(\d+):(\d+)/i);
        if (genericMatch) {
            const result = {
                type: "series",
                imdbId: `${genericMatch[1]}:${genericMatch[2]}`,
                seriesId: seriesId || `${genericMatch[1]}:${genericMatch[2]}`,
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
                imdbId: imdbIdMatch[1],
                seriesId: seriesId || imdbIdMatch[1],
                name: uiMeta.seriesName,
                season: parseInt(decodedHash.match(/season=(\d+)/)?.[1], 10) || uiMeta.season || null,
                episode: null,
            };
        }
        return lastValidContent || null;
    }

    let lastValidContent = null;

    // ==================== FLOATING UI ====================
    const MPV_ICON = `<svg viewBox="0 0 64 64" width="48" height="48" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="o" x1="13" y1="0" x2="53" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f9f9f9"/><stop offset="1" stop-color="#b9b9b9"/></linearGradient><linearGradient id="m" x1="44" y1="43" x2="18" y2="-2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#451b4c"/><stop offset="1" stop-color="#6c3c76"/></linearGradient><linearGradient id="i" x1="25" y1="5" x2="49" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2f0e35"/><stop offset="1" stop-color="#732e7d"/></linearGradient><linearGradient id="c" x1="24" y1="12" x2="42" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f1f0f1"/><stop offset="1" stop-color="#ada7af"/></linearGradient><linearGradient id="p" x1="29" y1="18" x2="33" y2="23" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#66386f"/><stop offset="1" stop-color="#461d4d"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#o)"/><circle cx="33" cy="31" r="28" fill="url(#m)"/><circle cx="35" cy="29" r="21" fill="url(#i)"/><circle cx="32" cy="32" r="14" fill="url(#c)"/><path d="M28 25v12l10-6z" fill="url(#p)"/></svg>`;
    const GEAR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" style="fill: currentColor;"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0 .59-.22L2.74 8.87c-.04.17 0 .42.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;

    function createFloatingButton() {
        if (document.getElementById("stremio-mpv-floating")) return;

        const container = document.createElement("div");
        container.id = "stremio-mpv-floating";
        container.innerHTML = `
            <style>
                #stremio-mpv-floating {
                    position: fixed; bottom: 100px; right: 20px; z-index: 99999;
                    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
                }
                .s-btn {
                    border: none; border-radius: 50%; width: 56px; height: 56px;
                    cursor: pointer; display: flex; align-items: center; justify-content: center;
                    color: white; transition: all 0.3s ease; background: transparent;
                }
                #stremio-mpv-btn { width: 48px; height: 48px; }
                #stremio-mpv-btn:hover { transform: scale(1.1); filter: drop-shadow(0 4px 10px rgba(139, 92, 246, 0.5)); }
                #stremio-mpv-config { background: rgba(0,0,0,0.8); width: 32px; height: 32px; opacity: 0.6; }
                #stremio-mpv-config:hover { opacity: 1; transform: rotate(45deg); }
                #stremio-mpv-info {
                    background: rgba(0,0,0,0.8); color: #22c55e; padding: 4px 8px;
                    border-radius: 4px; font-size: 10px; margin-bottom: 4px;
                }
                .loading { opacity: 0.7; animation: pulse 1s infinite; pointer-events: none; }
                @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }
            </style>
            <div id="stremio-mpv-info" style="display:none"></div>
            <button id="stremio-mpv-config" title="Settings" class="s-btn">${GEAR_ICON}</button>
            <button id="stremio-mpv-btn" title="Open in MPV" class="s-btn">${MPV_ICON}</button>
        `;
        document.body.appendChild(container);

        container.querySelector("#stremio-mpv-btn").addEventListener("click", handleMPVClick);
        container.querySelector("#stremio-mpv-config").addEventListener("click", createConfigModal);
        updateButtonInfo();
    }

    function updateButtonInfo() {
        const container = document.getElementById("stremio-mpv-floating");
        if (!container) return;

        const hash = window.location.hash;
        const isDetail = hash.includes("/detail/");
        const isAddons = hash.includes("/addons");

        if (!isDetail && !isAddons) {
            container.style.display = "none";
            return;
        }

        container.style.display = "flex";

        const playBtn = document.getElementById("stremio-mpv-btn");
        if (playBtn) playBtn.style.display = isDetail ? "flex" : "none";

        const configBtn = document.getElementById("stremio-mpv-config");
        if (configBtn) {
            const svg = configBtn.querySelector("svg");
            if (isAddons) {
                configBtn.style.width = "48px";
                configBtn.style.height = "48px";
                configBtn.style.opacity = "1";
                if (svg) {
                    svg.setAttribute("width", "24");
                    svg.setAttribute("height", "24");
                }
            } else {
                configBtn.style.width = "32px";
                configBtn.style.height = "32px";
                configBtn.style.opacity = "0.6";
                if (svg) {
                    svg.setAttribute("width", "14");
                    svg.setAttribute("height", "14");
                }
            }
        }

        const info = document.getElementById("stremio-mpv-info");
        if (isDetail) {
            const content = parseCurrentURL();
            if (content?.episode) {
                info.textContent = `S${content.season}E${content.episode}`;
                info.style.display = "block";
            } else {
                info.style.display = "none";
            }
        } else {
            info.style.display = "none";
        }
    }

    // ==================== MAIN LOGIC ====================
    async function handleMPVClick(e) {
        e.preventDefault();
        e.stopPropagation();

        const activeProviders = providers.filter((p) => p.enabled && p.url);
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

            const limit = playlistMode === "all" ? 50 : playlistMode === "single" ? 0 : extraEpisodes;
            const modeText =
                playlistMode === "all"
                    ? "Load All"
                    : playlistMode === "single"
                      ? "Single"
                      : `Batch | Extra: ${extraEpisodes}`;
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

    async function checkServer() {
        return new Promise((r) =>
            GM_xmlhttpRequest({
                method: "GET",
                url: `${CONFIG.SERVER_URL}/health`,
                timeout: 5000,
                onload: (res) => r(res.status === 200),
                onerror: () => r(false),
                ontimeout: () => r(false),
            }),
        );
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

        const fetchWithProviders = async (season, ep) => {
            for (const p of providers) {
                if (!p.enabled || !p.url) continue;
                log(`Trying ${p.name || p.id} for S${season}E${ep}...`);
                const streams = await fetchStreams(p.url, content.imdbId, season, ep);
                const streamItem = findBestStream(streams);
                if (streamItem) {
                    log(`Found on ${p.name || p.id}`);
                    return {
                        ...streamItem,
                        imdbId: content.imdbId,
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

            for (const p of providers) {
                if (!p.enabled || !p.url) continue;
                const episodes = await fetchSeriesMeta(p.url, content.imdbId);
                if (episodes.length > 0) {
                    discoveredEpisodes = episodes;
                    log(`Discovered ${episodes.length} episodes from ${p.name || p.id} meta`);
                    break;
                }
            }

            if (discoveredEpisodes.length > 0) {
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

                for (const ep of nextEpisodes) {
                    notify(`Fetching S${ep.season}E${ep.episode}${ep.title ? ` - ${ep.title}` : ""}...`);
                    const nextItem = await fetchWithProviders(ep.season, ep.episode);
                    if (nextItem) {
                        addItem(nextItem);
                    } else {
                        log(`Episode S${ep.season}E${ep.episode} not found on any provider.`);
                    }
                }
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
                        if (playlistMode === "all" && failures >= 3) {
                            log("Too many consecutive failures, stopping search.");
                            break;
                        }
                    }
                }
            }
        }
        return items;
    }

    async function fetchStreams(baseUrl, id, season, episode) {
        const isKitsu = id.startsWith("kitsu:");
        const url = isKitsu
            ? `${baseUrl}/stream/series/${id}:${episode}.json`
            : `${baseUrl}/stream/series/${id}:${season}:${episode}.json`;

        const MAX_RETRIES = 2;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                notify(
                    `Retrying stream fetch for S${season}E${episode} (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`,
                );
                await new Promise((r) => setTimeout(r, 1000));
            }

            const result = await new Promise((resolve) => {
                log(`Fetching streams from: ${url}`);
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    timeout: 10000,
                    onload: (r) => {
                        if (r.status !== 200) {
                            log(`Stream fetch returned status ${r.status} for S${season}E${episode}`);
                            resolve({ retry: true, data: [] });
                            return;
                        }
                        try {
                            const data = JSON.parse(r.responseText);
                            resolve({ retry: false, data: data.streams || [] });
                        } catch (e) {
                            log(`Failed to parse stream response for S${season}E${episode}:`, e.message);
                            resolve({ retry: false, data: [] });
                        }
                    },
                    onerror: () => {
                        log(`Stream fetch error for S${season}E${episode}`);
                        resolve({ retry: true, data: [] });
                    },
                    ontimeout: () => {
                        log(`Stream fetch timeout for S${season}E${episode}`);
                        resolve({ retry: true, data: [] });
                    },
                });
            });

            if (!result.retry || attempt === MAX_RETRIES) {
                return result.data;
            }
        }
        return [];
    }

    function parseSingleStream(stream) {
        let url = stream.url || stream.externalUrl;
        if (!url && stream.infoHash) {
            url = `magnet:?xt=urn:btih:${stream.infoHash}`;
            if (stream.sources)
                stream.sources.forEach((s) => {
                    url += `&tr=${encodeURIComponent(s)}`;
                });
        }

        let title =
            stream.behaviorHints?.filename ||
            (stream.title ? stream.title.split("\n")[0].split("\\n")[0] : null) ||
            stream.name ||
            "Video";
        if (title.length > 200) title = `${title.substring(0, 200)}...`;

        return { url, title };
    }

    function findBestStream(streams) {
        if (!streams?.length) return null;

        const validStreams = streams.filter((s) => (s.url || s.externalUrl || "").startsWith("http") || s.infoHash);
        if (!validStreams.length) return null;

        const preferredGroups = (preferredGroup || "")
            .split(",")
            .map((g) => g.trim().toLowerCase())
            .filter((g) => g.length > 0);
        const selectedQualities = (preferredQuality || "")
            .split(",")
            .map((q) => q.trim().toLowerCase())
            .filter((q) => q.length > 0);

        if (preferredGroups.length > 0 || selectedQualities.length > 0) {
            let bestStream = validStreams[0];
            let bestScore = -1;

            for (const s of validStreams) {
                const t = (s.title || s.description || s.name || s.id || "").toLowerCase();
                const normalizedTitle = t.replace(/[[\]]/g, "");
                let score = 0;

                if (preferredGroups.length > 0) {
                    if (preferredGroups.some((g) => normalizedTitle.includes(g.replace(/[[\]]/g, "")))) {
                        score += 2;
                    }
                }

                if (selectedQualities.length > 0) {
                    if (selectedQualities.some((q) => t.includes(q))) {
                        score += 1;
                    }
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestStream = s;
                }
            }

            if (bestStream) {
                log(`Found preferred stream matching criteria (Score: ${bestScore > -1 ? bestScore : 0})`);
                return parseSingleStream(bestStream);
            }
        }

        return parseSingleStream(validStreams[0]);
    }

    function sendToMPV(playlist, title) {
        return new Promise((resolve, reject) => {
            const profile = JSON.parse(localStorage.getItem("profile") || "{}");
            const authKey = profile.auth?.key;

            log(
                `Bridge: Sending payload with authKey: ${authKey ? "Found" : "MISSING"} | seriesId: ${title.seriesId} | imdbId: ${title.imdbId}`,
            );

            GM_xmlhttpRequest({
                method: "POST",
                url: `${CONFIG.SERVER_URL}/play`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({
                    playlist,
                    contentTitle: title.imdbId,
                    args: mpvArgsStr,
                    stremioAuth: authKey,
                    stremioContext: {
                        seriesId: title.seriesId,
                        imdbId: title.imdbId,
                        name: title.name,
                        episodeTitle: title.episodeTitle,
                        season: title.season,
                        episode: title.episode,
                        type: title.type,
                    },
                }),
                onload: (r) => (r.status === 200 ? resolve() : reject(new Error("Server error"))),
                onerror: () => reject(new Error("Connection failed")),
            });
        });
    }

    let toastCounter = 0;
    const MAX_TOASTS = 5;
    const TOAST_DURATION = 3000;

    function getToastContainer() {
        let container = document.getElementById("stremio-mpv-toast-container");
        if (!container) {
            container = document.createElement("div");
            container.id = "stremio-mpv-toast-container";
            container.style.cssText = `
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                display: flex;
                flex-direction: column-reverse;
                align-items: center;
                gap: 8px;
                z-index: 999999;
                pointer-events: none;
            `;
            document.body.appendChild(container);
        }
        return container;
    }

    function showToast(message, type = "info") {
        const container = getToastContainer();
        const color = type === "error" ? "#ef4444" : type === "success" ? "#22c55e" : "#3b82f6";

        // Enforce max toasts
        const toasts = container.querySelectorAll(".stremio-mpv-toast");
        if (toasts.length >= MAX_TOASTS) {
            toasts[toasts.length - 1].remove(); // remove oldest (last in column-reverse = bottom)
        }

        const id = `stremio-mpv-toast-${++toastCounter}`;
        const toast = document.createElement("div");
        toast.id = id;
        toast.className = "stremio-mpv-toast";
        toast.style.cssText = `
            background: ${color};
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-family: 'Roboto', sans-serif;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            pointer-events: auto;
            cursor: pointer;
            animation: mpv-toast-in 0.25s ease-out;
            transition: opacity 0.2s ease, transform 0.2s ease;
        `;
        toast.textContent = message;

        // Click to dismiss
        toast.addEventListener("click", () => dismissToast(toast));

        // Inject keyframes once
        if (!document.getElementById("mpv-toast-styles")) {
            const style = document.createElement("style");
            style.id = "mpv-toast-styles";
            style.textContent = `
                @keyframes mpv-toast-in {
                    from { opacity: 0; transform: translateY(12px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
                @keyframes mpv-toast-out {
                    from { opacity: 1; transform: scale(1); }
                    to   { opacity: 0; transform: scale(0.95); }
                }
            `;
            document.head.appendChild(style);
        }

        // prepend so newest is at top (column-reverse makes it bottom but visually top of stack)
        container.prepend(toast);

        // Auto-dismiss
        const timer = setTimeout(() => dismissToast(toast), TOAST_DURATION);
        toast._dismissTimer = timer;
    }

    function dismissToast(toast) {
        if (toast._dismissed) return;
        toast._dismissed = true;
        clearTimeout(toast._dismissTimer);
        toast.style.animation = "mpv-toast-out 0.2s ease forwards";
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
    }

    function showNowPlayingWidget(title) {
        const existing = document.getElementById("mpv-now-playing");
        if (existing) existing.remove();

        const widget = document.createElement("div");
        widget.id = "mpv-now-playing";
        widget.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 40px; height: 40px; background: rgba(139, 92, 246, 0.2); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #a78bfa;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
                <div style="display: flex; flex-direction: column; overflow: hidden;">
                    <span style="font-size: 11px; text-transform: uppercase; color: #a78bfa; font-weight: bold; letter-spacing: 1px; margin-bottom: 2px;">Now Playing</span>
                    <span style="font-size: 14px; color: white; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 250px;" title="${title}">${title}</span>
                </div>
            </div>
        `;
        widget.style.cssText = `
            position: fixed; bottom: 30px; right: 30px;
            background: rgba(15, 15, 20, 0.95);
            backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);
            border: 1px solid rgba(139, 92, 246, 0.4);
            border-radius: 16px; padding: 16px 20px; z-index: 999999;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset;
            transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.5s ease;
            transform: translateY(100px); opacity: 0;
            font-family: 'Roboto', sans-serif;
        `;
        document.body.appendChild(widget);

        // Slide in
        void widget.offsetWidth; // Force reflow
        widget.classList.add("show");
        widget.style.transform = "translateY(0)";
        widget.style.opacity = "1";

        // Slide out
        setTimeout(() => {
            widget.classList.remove("show");
            widget.style.transform = "translateY(100px)";
            widget.style.opacity = "0";
            setTimeout(() => widget.remove(), 500);
        }, 6000);
    }

    function showBridgeConnectedToast() {
        const existing = document.getElementById("mpv-bridge-connected");
        if (existing) existing.remove();

        const widget = document.createElement("div");
        widget.id = "mpv-bridge-connected";
        widget.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 40px; height: 40px; background: rgba(139, 92, 246, 0.2); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #a78bfa;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                </div>
                <div style="display: flex; flex-direction: column; overflow: hidden;">
                    <span style="font-size: 11px; text-transform: uppercase; color: #a78bfa; font-weight: bold; letter-spacing: 1px; margin-bottom: 2px;">MPV Bridge</span>
                    <span style="font-size: 14px; color: white; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 250px;">Bridge Connected</span>
                </div>
            </div>
        `;
        widget.style.cssText = `
            position: fixed; bottom: 30px; right: 30px;
            background: rgba(15, 15, 20, 0.95);
            backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);
            border: 1px solid rgba(139, 92, 246, 0.4);
            border-radius: 16px; padding: 16px 20px; z-index: 999999;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset;
            transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.5s ease;
            transform: translateY(100px); opacity: 0;
            font-family: 'Roboto', sans-serif;
        `;
        document.body.appendChild(widget);

        // Slide in
        void widget.offsetWidth;
        widget.style.transform = "translateY(0)";
        widget.style.opacity = "1";

        // Slide out
        setTimeout(() => {
            widget.style.transform = "translateY(100px)";
            widget.style.opacity = "0";
            setTimeout(() => widget.remove(), 500);
        }, 4000);
    }

    // ==================== BRIDGE CONNECTION POLLING ====================
    // Polls the bridge health endpoint at a fixed interval.
    // Shows a toast only on the offline -> online transition to avoid spam.
    // The interval is cleared when the modal closes or the script unloads.
    let bridgePollInterval = null;
    let wasBridgeOnline = false;

    function startBridgePolling() {
        if (bridgePollInterval) return; // already running

        // Seed the initial state BEFORE starting the interval to avoid a race
        // where the first tick fires before we know the true online state.
        checkServer().then((isOnline) => {
            wasBridgeOnline = isOnline;
            log(`[BridgePoll] Initial seed: isOnline=${isOnline}, wasBridgeOnline=${wasBridgeOnline}`);

            bridgePollInterval = setInterval(async () => {
                const isOnline = await checkServer();
                log(`[BridgePoll] Tick: isOnline=${isOnline}, wasBridgeOnline=${wasBridgeOnline}`);
                if (isOnline && !wasBridgeOnline) {
                    // Transition: offline -> online
                    log("[BridgePoll] Detected offline -> online transition, showing toast");
                    showBridgeConnectedToast();
                }
                wasBridgeOnline = isOnline;
            }, 10000);
        });
    }

    function stopBridgePolling() {
        if (bridgePollInterval) {
            clearInterval(bridgePollInterval);
            bridgePollInterval = null;
        }
    }

    async function init() {
        const version = GM_info.script.version;

        // Resolve provider names asynchronously for logging
        const activeProviders = providers.filter((p) => p.enabled && p.url);
        let providerSummary = "None";
        if (activeProviders.length > 0) {
            const resolvedNames = await Promise.all(activeProviders.map((p) => resolveProviderName(p)));
            providerSummary = resolvedNames.join(", ");
        }

        const modeText =
            playlistMode === "all"
                ? "Load All"
                : playlistMode === "single"
                  ? "Single"
                  : `Batch | Extra: ${extraEpisodes}`;

        notify(`v${version} initialized — ${providerSummary} — ${modeText}`);

        // Check bridge server and show connected toast
        try {
            const isOnline = await checkServer();
            if (isOnline) {
                showBridgeConnectedToast();
            }
        } catch {
            // Silently ignore - server status is non-critical for initialization
        }

        createFloatingButton();

        // Start polling for bridge connection status
        startBridgePolling();

        window.addEventListener("keydown", (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
            if (e.key.toLowerCase() === mpvShortcut) {
                const hash = window.location.hash;
                if (hash.includes("/detail/")) {
                    handleMPVClick(e);
                }
            }
        });

        let lastHash = window.location.hash;
        const hashCheckInterval = setInterval(() => {
            if (window.location.hash !== lastHash) {
                lastHash = window.location.hash;
                log("URL changed:", `${lastHash.substring(0, 60)}...`);
                updateButtonInfo();
            }
        }, 500);

        window.addEventListener("beforeunload", () => {
            clearInterval(hashCheckInterval);
        });
        new MutationObserver(() => {
            if (!document.getElementById("stremio-mpv-floating")) createFloatingButton();
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "complete") init();
    else window.addEventListener("load", init);
})();
