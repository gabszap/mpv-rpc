// Configuration modal UI and saving its values.

import { bridgeState, buildBridgeStremioMeta, checkServer, postBridgeConfig } from "./bridge-api.js";
import { stopBridgePolling } from "./bridge-polling.js";
import { showConfirmModal } from "./confirm-modal.js";
import { CONFIG } from "./constants.js";
import { updateButtonInfo } from "./floating-ui.js";
import { log } from "./logging.js";
import {
    AVAILABLE_PROVIDERS,
    getProviderDefaults,
    updateProviderLabels,
    updateSingleProviderLabel,
} from "./providers.js";
import { CURRENT_CONFIG_VERSION, DEFAULT_ACTIVE, settings } from "./settings.js";
import { showToast } from "./toasts.js";
import { parseCurrentURL } from "./url-parser.js";

// ==================== CONFIGURATION UI ====================
export function createConfigModal() {
    if (document.getElementById("stremio-mpv-modal")) return;

    const modal = document.createElement("div");
    modal.id = "stremio-mpv-modal";
    const storedIconMode = GM_getValue("iconMode", "default");
    const selectedIconMode = ["default", "config-only", "compact", "disabled"].includes(storedIconMode)
        ? storedIconMode
        : "default";

    const providersHTML = settings.providers
        .map((p, _index) => {
            const isCustom = p.id.startsWith("custom");
            const loadingIndicator =
                isCustom && p.url
                    ? '<span class="mpv-loading-name" style="font-size: 10px; opacity: 0.6; margin-left: 4px;"></span>'
                    : "";
            const defaults = getProviderDefaults(p.id);
            const placeholder = defaults.placeholder;
            const tooltipAttr = defaults.tooltip ? `title="${defaults.tooltip.replace(/"/g, "&quot;")}"` : "";
            const helpSpan = defaults.tooltip ? `<span class="mpv-tooltip-help" ${tooltipAttr}>?</span>` : "";

            return `
        <div class="mpv-form-group mpv-provider-item ${p.enabled ? "" : "mpv-provider-disabled"}" data-id="${p.id}" data-url="${p.url || ""}" draggable="true" style="transition: transform 0.2s, opacity 0.2s;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
                    <button type="button" class="mpv-drag-handle" title="Drag to reorder" style="background: transparent; border: none; color: #666; cursor: grab; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s; font-size: 16px; flex-shrink: 0;">☰</button>
                    <div class="mpv-toggle-track mpv-provider-toggle" data-id="${p.id}" data-enabled="${p.enabled ? "true" : "false"}" role="switch" aria-checked="${p.enabled ? "true" : "false"}" tabindex="0" title="${p.enabled ? "Enabled" : "Disabled"}">
                        <div class="mpv-toggle-thumb"></div>
                    </div>
                    <label class="mpv-label mpv-provider-label" data-id="${p.id}" style="margin: 0; cursor: pointer; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}${helpSpan}${loadingIndicator}</label>
                </div>
                <div style="display: flex; gap: 4px; flex-shrink: 0;">
                    <button type="button" class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">🗑</button>
                </div>
            </div>
            <input type="text" data-id="${p.id}" class="mpv-input mpv-provider-input"
                   placeholder="${placeholder}" value="${p.url}"
                   style="${!p.enabled ? "opacity: 0.5; pointer-events: none;" : ""}">
        </div>
    `;
        })
        .join("");

    modal.innerHTML = `
        <style>
            #stremio-mpv-modal,
            #stremio-mpv-modal * {
                box-sizing: border-box;
            }

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
                font-size: 22px; font-weight: bold; margin-bottom: 24px !important;
                display: flex; align-items: center;
                flex-shrink: 0 !important;
                line-height: 1.2 !important;
            }
            .mpv-modal-title {
                background: linear-gradient(45deg, #a78bfa, #8b5cf6);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            }
            #stremio-mpv-modal .mpv-tab-nav {
                display: flex !important;
                align-items: center !important;
                width: 100% !important;
                height: 50px !important;
                max-height: 50px !important;
                flex-shrink: 0 !important;
                box-sizing: border-box !important;
                gap: 8px !important;
                margin: -6px 0 16px !important;
                padding: 5px !important;
                border-radius: 12px !important;
                background: rgba(255, 255, 255, 0.03) !important;
                border: 1px solid rgba(255, 255, 255, 0.08) !important;
            }
            #stremio-mpv-modal .mpv-tab-btn {
                appearance: none !important;
                -webkit-appearance: none !important;
                box-sizing: border-box !important;
                flex: 1 1 0% !important;
                width: 100% !important;
                min-width: 0 !important;
                height: 38px !important;
                max-height: 38px !important;
                border: 1px solid transparent !important;
                border-radius: 8px !important;
                background: transparent !important;
                color: #b8b8c2 !important;
                font-size: 14px !important;
                font-weight: 600 !important;
                padding: 0 8px !important;
                cursor: pointer !important;
                transition: all 0.2s ease !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                line-height: 1 !important;
                margin: 0 !important;
            }
            #stremio-mpv-modal .mpv-tab-btn:first-child,
            #stremio-mpv-modal .mpv-tab-btn:first-of-type {
                margin-left: 0 !important;
            }
            #stremio-mpv-modal .mpv-tab-btn:hover {
                color: #fff !important;
                background: rgba(139, 92, 246, 0.15) !important;
            }
            #stremio-mpv-modal .mpv-tab-btn.mpv-active {
                color: #fff !important;
                background: linear-gradient(135deg, rgba(139, 92, 246, 0.35), rgba(124, 58, 237, 0.2)) !important;
                border-color: rgba(139, 92, 246, 0.45) !important;
                box-shadow: 0 6px 16px rgba(139, 92, 246, 0.25) !important;
            }
            .mpv-modal-body {
                flex: 1;
                width: 100%;
                min-height: 0;
                overflow-y: auto;
                padding-right: 2px;
                scrollbar-gutter: stable;
            }
            .mpv-tab-panel { display: none; width: 100%; animation: tabFade 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
            .mpv-tab-panel.mpv-active { display: block !important; }
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
            .mpv-dropdown-item.disabled { opacity: 0.4; cursor: not-allowed; }
            .mpv-dropdown-item.disabled .mpv-dropdown-item-name { text-decoration: line-through; }
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
            .mpv-tooltip-help {
                display: inline-block !important;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.15);
                color: #ccc;
                font-size: 10px;
                font-weight: bold;
                cursor: help;
                margin-left: 6px;
                transition: all 0.2s ease;
                vertical-align: middle;
                line-height: 14px;
                text-align: center;
                text-decoration: none !important;
            }
            .mpv-tooltip-help:hover {
                background: rgba(139, 92, 246, 0.4);
                color: #fff;
            }
        </style>
        <div class="mpv-modal-content">
            <div class="mpv-modal-header">
                <span class="mpv-modal-title">MPV Bridge Settings</span>
                <span style="font-size: 14px; opacity: 0.6; font-weight: normal; margin-left: 8px;">v${GM_info.script.version}</span>
                <span id="mpv-server-status" title="Checking server status..." style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #fbbf24; margin-left: auto; box-shadow: 0 0 8px rgba(251, 191, 36, 0.4); transition: all 0.3s ease; flex-shrink: 0; cursor: help;"></span>
            </div>

            <div class="mpv-tab-nav" role="tablist" aria-label="Settings Tabs">
                <button type="button" class="mpv-tab-btn mpv-active" data-tab="providers" role="tab" aria-selected="true">Providers</button>
                <button type="button" class="mpv-tab-btn" data-tab="playback" role="tab" aria-selected="false">Playback</button>
                <button type="button" class="mpv-tab-btn" data-tab="advanced" role="tab" aria-selected="false">Advanced</button>
            </div>

            <div class="mpv-modal-body">
                <div class="mpv-tab-panel mpv-active" data-tab-panel="providers" role="tabpanel">
                    <div id="mpv-providers-container">
                        ${providersHTML}
                    </div>

                    <div class="mpv-dropdown">
                        <button class="mpv-btn mpv-btn-add" id="mpv-add-provider-btn">+ Add Provider</button>
                        <div class="mpv-dropdown-overlay" id="mpv-dropdown-overlay"></div>
                        <div class="mpv-dropdown-content" id="mpv-provider-dropdown">
                            <div class="mpv-dropdown-title">Select Provider</div>
                            <div class="mpv-dropdown-category">Providers</div>
                            ${AVAILABLE_PROVIDERS.providers.map((p) => `<div class="mpv-dropdown-item" data-id="${p.id}" data-name="${p.name}"><span class="mpv-dropdown-item-name">${p.name}</span></div>`).join("")}
                            <div class="mpv-dropdown-category">Debrid Services</div>
                            ${AVAILABLE_PROVIDERS.debrid
                                .map((p) => {
                                    if (p.id === "torbox") {
                                        return `<div class="mpv-dropdown-item disabled" data-id="${p.id}" data-name="${p.name}" style="opacity: 0.4; cursor: not-allowed;"><span class="mpv-dropdown-item-name">${p.name}</span> <span class="mpv-tooltip-help" title="Disabled in May 2026 by Torbox">?</span></div>`;
                                    }
                                    const defaults = getProviderDefaults(p.id);
                                    let tooltipSpan = "";
                                    if (defaults.tooltip) {
                                        tooltipSpan = ` <span class="mpv-tooltip-help" title="${defaults.tooltip.replace(/"/g, "&quot;")}">?</span>`;
                                    }
                                    return `<div class="mpv-dropdown-item" data-id="${p.id}" data-name="${p.name}"><span class="mpv-dropdown-item-name">${p.name}</span>${tooltipSpan}</div>`;
                                })
                                .join("")}
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

                        <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; margin-bottom: 8px; background: ${settings.playlistMode === "single" ? "rgba(139, 92, 246, 0.12)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${settings.playlistMode === "single" ? "rgba(139, 92, 246, 0.4)" : "rgba(255,255,255,0.08)"}; transition: all 0.2s ease;">
                            <input type="radio" name="mpv-stream-mode" id="mpv-mode-single" value="single" class="mpv-radio" ${settings.playlistMode === "single" ? "checked" : ""}>
                            <div style="pointer-events: none; flex: 1;">
                                <label for="mpv-mode-single" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Single Episode</label>
                                <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Load only the selected episode</div>
                            </div>
                        </div>

                        <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; margin-bottom: 8px; background: ${settings.playlistMode === "batch" ? "rgba(139, 92, 246, 0.12)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${settings.playlistMode === "batch" ? "rgba(139, 92, 246, 0.4)" : "rgba(255,255,255,0.08)"}; transition: all 0.2s ease;">
                            <input type="radio" name="mpv-stream-mode" id="mpv-mode-batch" value="batch" class="mpv-radio" ${settings.playlistMode === "batch" ? "checked" : ""}>
                            <div style="pointer-events: none; flex: 1;">
                                <label for="mpv-mode-batch" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Batch Episodes</label>
                                <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Load selected + next episodes</div>
                            </div>
                        </div>

                        <div id="mpv-group-count" style="margin-bottom: 15px; padding-left: 42px; ${settings.playlistMode !== "batch" ? "display:none" : ""}">
                            <label class="mpv-label" style="font-size: 11px; color: #a78bfa; margin-bottom: 4px;">Next episodes to load</label>
                            <input type="number" id="mpv-ep-count" class="mpv-input" value="${settings.extraEpisodes}" min="1" max="25" style="width: 70px; padding: 8px;">
                        </div>

                        <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; background: ${settings.playlistMode === "all" ? "rgba(139, 92, 246, 0.12)" : "rgba(255,255,255,0.03)"}; border: 1px solid ${settings.playlistMode === "all" ? "rgba(139, 92, 246, 0.4)" : "rgba(255,255,255,0.08)"}; transition: all 0.2s ease;">
                            <input type="radio" name="mpv-stream-mode" id="mpv-mode-all" value="all" class="mpv-radio" ${settings.playlistMode === "all" ? "checked" : ""}>
                            <div style="pointer-events: none; flex: 1;">
                                <label for="mpv-mode-all" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Load All</label>
                                <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Loads all remaining episodes (may take a while)</div>
                            </div>
                        </div>
                    </div>

                    <div class="mpv-form-group">
                        <label class="mpv-label">Auto-Fetch Episodes</label>
                        <div class="mpv-checkbox-group" style="justify-content: space-between;">
                            <span style="font-size: 13px; color: #ccc;">Automatically request the next episodes near playlist end</span>
                            <div class="mpv-toggle-track mpv-auto-fetch-toggle" data-enabled="${settings.autoFetch ? "true" : "false"}" role="switch" aria-checked="${settings.autoFetch ? "true" : "false"}" tabindex="0" title="${settings.autoFetch ? "Enabled" : "Disabled"}">
                                <div class="mpv-toggle-thumb"></div>
                            </div>
                        </div>
                        <div class="mpv-help" style="margin-top: 6px;">Bridge setting controls Stremio bridge auto-fetch requests; .env AUTO_FETCH=false still disables RPC-side triggering globally.</div>
                    </div>

                    <div class="mpv-form-group">
                        <label class="mpv-label">Preferred Release Group</label>
                        <div style="position: relative;">
                            <input type="text" id="mpv-preferred-group" class="mpv-input" placeholder="e.g. subsplease, judas" value="${settings.preferredGroup}">
                            <div id="mpv-release-groups-dropdown" style="display: none; position: fixed; max-height: 200px; overflow-y: auto; background: #151515; border: 1px solid rgba(139, 92, 246, 0.4); border-radius: 8px; z-index: 100003; box-shadow: 0 4px 15px rgba(0,0,0,0.5);"></div>
                        </div>
                        <div class="mpv-help" style="margin-top: 4px;">Bridge will try to pick streams from this group.</div>
                    </div>

                    <div class="mpv-form-group">
                        <label class="mpv-label">Preferred Quality</label>
                        <div class="mpv-quality-pills" style="display: flex; gap: 8px; flex-wrap: wrap;">
                            ${["4K", "2K", "1080p", "720p", "Unknown"]
                                .map((q) => {
                                    const isActive = settings.preferredQuality
                                        .split(",")
                                        .map((s) => s.trim())
                                        .includes(q);
                                    return `<button type="button" class="mpv-pill-btn ${isActive ? "active" : ""}" data-quality="${q}">${q}</button>`;
                                })
                                .join("")}
                        </div>
                        <input type="hidden" id="mpv-preferred-quality" value="${settings.preferredQuality}">
                        <div class="mpv-help" style="margin-top: 6px;">Bridge will prioritize these resolutions.</div>
                    </div>

                    <div class="mpv-form-group">
                        <label class="mpv-label">Keyboard Shortcut</label>
                        <button type="button" id="mpv-shortcut-btn" class="mpv-input" style="width: 80px; text-align: center; text-transform: uppercase; font-weight: bold; cursor: pointer; border: 1px dashed rgba(139, 92, 246, 0.5);">${settings.mpvShortcut.toUpperCase()}</button>
                        <input type="hidden" id="mpv-shortcut" value="${settings.mpvShortcut}">
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
                        <label class="mpv-label">Floating Icons</label>
                        <div class="mpv-icon-mode-pills" style="display: flex; gap: 8px; flex-wrap: wrap;">
                            <button type="button" class="mpv-pill-btn ${selectedIconMode === "default" ? "active" : ""}" data-mode="default" style="flex: 1 1 calc(50% - 4px); font-size: 12px; padding: 10px 8px; text-align: center;">Show Both Icons</button>
                            <button type="button" class="mpv-pill-btn ${selectedIconMode === "config-only" ? "active" : ""}" data-mode="config-only" style="flex: 1 1 calc(50% - 4px); font-size: 12px; padding: 10px 8px; text-align: center;">Config Icon Only</button>
                            <button type="button" class="mpv-pill-btn ${selectedIconMode === "compact" ? "active" : ""}" data-mode="compact" style="flex: 1 1 calc(50% - 4px); font-size: 12px; padding: 10px 8px; text-align: center;">Compact Mode</button>
                            <button type="button" class="mpv-pill-btn ${selectedIconMode === "disabled" ? "active" : ""}" data-mode="disabled" style="flex: 1 1 calc(50% - 4px); font-size: 12px; padding: 10px 8px; text-align: center;">Hide All Icons</button>
                        </div>
                        <input type="hidden" id="mpv-icon-mode" value="${selectedIconMode}">
                        <div class="mpv-help" style="margin-top: 6px;">Controls the floating MPV / config buttons. Hide all icons can be reverted from the Violentmonkey/Tampermonkey menu: Open MPV Bridge Settings.</div>
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
                        <input type="text" id="mpv-custom-args" class="mpv-input" placeholder="e.g. --fs --volume=50" value="${settings.mpvArgsStr}">
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
            button.classList.toggle("mpv-active", isActive);
            button.setAttribute("aria-selected", isActive ? "true" : "false");
        });

        tabPanels.forEach((panel) => {
            panel.classList.toggle("mpv-active", panel.dataset.tabPanel === tabName);
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

    // Icon Mode Pills logic
    const iconModePills = modal.querySelectorAll(".mpv-icon-mode-pills .mpv-pill-btn");
    const iconModeInput = modal.querySelector("#mpv-icon-mode");
    if (iconModePills && iconModeInput) {
        iconModePills.forEach((pill) => {
            pill.addEventListener("click", () => {
                iconModePills.forEach((p) => {
                    p.classList.remove("active");
                });
                pill.classList.add("active");
                iconModeInput.value = pill.dataset.mode;
            });
        });
    }

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
    const pillBtns = modal.querySelectorAll(".mpv-quality-pills .mpv-pill-btn");
    const qualityInput = modal.querySelector("#mpv-preferred-quality");
    pillBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
            btn.classList.toggle("active");
            const activeQualities = Array.from(modal.querySelectorAll(".mpv-quality-pills .mpv-pill-btn.active")).map(
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
    const initialMpvArgs = settings.mpvArgsStr;
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
                GM_setValue("configVersion", CURRENT_CONFIG_VERSION);
                GM_setValue("autofetch", true);
                GM_setValue("iconMode", "default");
                updateButtonInfo();

                settings.providers = [...DEFAULT_ACTIVE];
                settings.autoFetch = true;
                settings.playlistMode = "batch";
                settings.extraEpisodes = 2;
                settings.mpvShortcut = "v";
                settings.preferredGroup = "";
                settings.preferredQuality = "";
                settings.mpvArgsStr = "";

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
                        args: settings.mpvArgsStr,
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

    const autoFetchToggle = modal.querySelector(".mpv-auto-fetch-toggle");
    if (autoFetchToggle) {
        autoFetchToggle.addEventListener("click", () => {
            const isEnabled = autoFetchToggle.dataset.enabled === "true";
            const newEnabled = !isEnabled;
            autoFetchToggle.dataset.enabled = newEnabled ? "true" : "false";
            autoFetchToggle.setAttribute("aria-checked", newEnabled ? "true" : "false");
            autoFetchToggle.title = newEnabled ? "Enabled" : "Disabled";
        });
        autoFetchToggle.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                autoFetchToggle.click();
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
        if (!item || item.classList.contains("disabled") || item.dataset.id === "torbox") return;

        const id = item.dataset.id;
        const name = item.dataset.name;
        const container = modal.querySelector("#mpv-providers-container");
        const defaults = getProviderDefaults(id);
        const initialUrl = defaults.url;
        const tooltipAttr = defaults.tooltip ? `title="${defaults.tooltip.replace(/"/g, "&quot;")}"` : "";
        const helpSpan = defaults.tooltip ? `<span class="mpv-tooltip-help" ${tooltipAttr}>?</span>` : "";
        const placeholder = defaults.placeholder;

        const newProviderHTML = `
            <div class="mpv-form-group mpv-provider-item" data-id="${id}" draggable="true" style="transition: transform 0.2s, opacity 0.2s;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
                        <button type="button" class="mpv-drag-handle" title="Drag to reorder" style="background: transparent; border: none; color: #666; cursor: grab; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s; font-size: 16px; flex-shrink: 0;">☰</button>
                        <div class="mpv-toggle-track mpv-provider-toggle" data-id="${id}" data-enabled="true" role="switch" aria-checked="true" tabindex="0" title="Enabled">
                            <div class="mpv-toggle-thumb"></div>
                        </div>
                        <label class="mpv-label mpv-provider-label" data-id="${id}" style="margin: 0; cursor: pointer; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name}${helpSpan}</label>
                    </div>
                    <div style="display: flex; gap: 4px; flex-shrink: 0;">
                        <button type="button" class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">🗑</button>
                    </div>
                </div>
                <input type="text" data-id="${id}" class="mpv-input mpv-provider-input" placeholder="${placeholder}" value="${initialUrl}">
            </div>
        `;

        // Insert before custom providers
        const firstCustom = container.querySelector('[data-id^="custom"]');
        if (firstCustom) {
            firstCustom.insertAdjacentHTML("beforebegin", newProviderHTML);
        } else {
            container.insertAdjacentHTML("beforeend", newProviderHTML);
        }

        // Add toggle listener to newly added provider
        const newToggle = container.querySelector(`[data-id="${id}"].mpv-provider-toggle`);
        newToggle?.addEventListener("click", (ev) => {
            const track = ev.currentTarget;
            const isEnabled = track.dataset.enabled === "true";
            const newEnabled = !isEnabled;
            track.dataset.enabled = newEnabled ? "true" : "false";
            track.setAttribute("aria-checked", newEnabled ? "true" : "false");
            track.title = newEnabled ? "Enabled" : "Disabled";
            const pItem = track.closest(".mpv-provider-item");
            if (pItem) pItem.classList.toggle("mpv-provider-disabled", !newEnabled);
            const input = container.querySelector(`.mpv-provider-input[data-id="${track.dataset.id}"]`);
            if (input) {
                input.style.opacity = newEnabled ? "1" : "0.5";
                input.style.pointerEvents = newEnabled ? "auto" : "none";
            }
        });
        newToggle?.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                newToggle.click();
            }
        });

        // Update provider name when URL input changes (on blur)
        const newInput = container.querySelector(`.mpv-provider-input[data-id="${id}"]`);
        newInput?.addEventListener("blur", (ev) => {
            const providerId = ev.target.dataset.id;
            const url = ev.target.value.trim();
            if (providerId.startsWith("custom") && url) {
                updateSingleProviderLabel(modal, providerId, url);
            }
        });

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

    settings.providers = providerItems.map((item) => {
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

    GM_setValue("providers", settings.providers);

    settings.extraEpisodes = Math.max(1, Math.min(25, parseInt(countInput.value, 10) || 2));
    GM_setValue("extraEpisodes", settings.extraEpisodes);

    settings.playlistMode = selectedMode ? selectedMode.value : "batch";
    GM_setValue("playlistMode", settings.playlistMode);

    settings.mpvShortcut = (shortcutInput.value || "v").toLowerCase();
    GM_setValue("mpvShortcut", settings.mpvShortcut);

    settings.preferredGroup = preferredGroupInput ? preferredGroupInput.value.trim() : "";
    GM_setValue("preferredGroup", settings.preferredGroup);

    settings.preferredQuality = preferredQualityInput ? preferredQualityInput.value.trim() : "";
    GM_setValue("preferredQuality", settings.preferredQuality);

    settings.mpvArgsStr = customArgsInput ? customArgsInput.value.trim() : "";
    GM_setValue("mpvArgsStr", settings.mpvArgsStr);

    const debugToggle = modal.querySelector(".mpv-debug-toggle");
    const debugEnabled = debugToggle ? debugToggle.dataset.enabled === "true" : GM_getValue("debug", false);
    GM_setValue("debug", debugEnabled);

    const autoFetchToggle = modal.querySelector(".mpv-auto-fetch-toggle");
    settings.autoFetch = autoFetchToggle
        ? autoFetchToggle.dataset.enabled === "true"
        : GM_getValue("autofetch", GM_getValue("autoFetchEnabled", true));
    GM_setValue("autofetch", settings.autoFetch);

    // Persist the v2 marker on the localStorage mirror so the next startup
    // skips migration. The on-disk file is also marked when the bridge
    // accepts the /config POST and migrates it.
    GM_setValue("configVersion", CURRENT_CONFIG_VERSION);

    // Phase 5B: read the iconMode from the modal's <select> (default
    // "default" if absent) and persist it. Unknown values are coerced
    // to "default" at read time by `applyIconMode`.
    const iconModeSelect = modal.querySelector("#mpv-icon-mode");
    const validIconModes = ["default", "config-only", "compact", "disabled"];
    const selectedIconMode = iconModeSelect ? iconModeSelect.value : "default";
    const iconMode = validIconModes.includes(selectedIconMode) ? selectedIconMode : "default";
    GM_setValue("iconMode", iconMode);
    updateButtonInfo();

    showToast("Settings saved!", "success");

    // Sync the complete bridge config immediately on Save. Keep the same
    // object pending until the bridge acknowledges it so /play can retry
    // if the Save-time POST fails or the bridge is offline.
    try {
        const bridgeConfig = {
            configVersion: CURRENT_CONFIG_VERSION,
            autoFetch: { enabled: settings.autoFetch },
            extraEpisodes: settings.extraEpisodes,
            providers: settings.providers,
            playlistMode: settings.playlistMode,
            mpvShortcut: settings.mpvShortcut,
            preferredGroup: settings.preferredGroup,
            preferredQuality: settings.preferredQuality,
            mpvArgsStr: settings.mpvArgsStr,
            debug: debugEnabled,
            iconMode: iconMode,
        };
        const stremioMeta = parseCurrentURL();
        const bridgeStremioMeta = buildBridgeStremioMeta(stremioMeta);
        if (bridgeStremioMeta) {
            bridgeConfig.stremioMeta = bridgeStremioMeta;
        }
        // Mirrors src/userscript-config-sync.ts — keep in sync.
        // Mark this config as pending so /play can flush it first.
        bridgeState.pendingConfig = bridgeConfig;
        postBridgeConfig(bridgeConfig)
            .then(() => {
                if (bridgeState.pendingConfig === bridgeConfig) {
                    bridgeState.pendingConfig = null;
                }
                log("Config synced to bridge");
            })
            .catch((error) => {
                log("Failed to sync config to bridge:", error.message);
            });
    } catch (error) {
        log("Failed to build bridge config:", error.message);
    }
}
