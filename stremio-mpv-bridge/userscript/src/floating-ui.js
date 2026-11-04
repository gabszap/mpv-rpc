// Floating MPV / settings buttons and their positioning.

import { createConfigModal } from "./config-modal.js";
import { applyIconMode } from "./icon-mode.js";
import { handleMPVClick } from "./playback.js";
import { getRouteText, isPlayerRoute, parseCurrentURL } from "./url-parser.js";

// seriesId -> name

// ==================== FLOATING UI ====================
const MPV_ICON = `<svg viewBox="0 0 64 64" width="48" height="48" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="o" x1="13" y1="0" x2="53" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f9f9f9"/><stop offset="1" stop-color="#b9b9b9"/></linearGradient><linearGradient id="m" x1="44" y1="43" x2="18" y2="-2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#451b4c"/><stop offset="1" stop-color="#6c3c76"/></linearGradient><linearGradient id="i" x1="25" y1="5" x2="49" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2f0e35"/><stop offset="1" stop-color="#732e7d"/></linearGradient><linearGradient id="c" x1="24" y1="12" x2="42" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f1f0f1"/><stop offset="1" stop-color="#ada7af"/></linearGradient><linearGradient id="p" x1="29" y1="18" x2="33" y2="23" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#66386f"/><stop offset="1" stop-color="#461d4d"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#o)"/><circle cx="33" cy="31" r="28" fill="url(#m)"/><circle cx="35" cy="29" r="21" fill="url(#i)"/><circle cx="32" cy="32" r="14" fill="url(#c)"/><path d="M28 25v12l10-6z" fill="url(#p)"/></svg>`;

const GEAR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" style="fill: currentColor;"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0 .59-.22L2.74 8.87c-.04.17 0 .42.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;

function getVisibleChild(wrapper) {
    if (!wrapper?.firstElementChild) {
        return wrapper;
    }
    for (const child of wrapper.children) {
        const rect = child.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            return child;
        }
    }
    return wrapper;
}

function findFullscreenButton() {
    const matches = Array.from(
        document.querySelectorAll(
            '[title*="fullscreen" i], [title*="tela cheia" i], [title*="pantalla" i], [title*="plein" i], [title*="vollbild" i]',
        ),
    );
    for (const match of matches) {
        const child = getVisibleChild(match);
        const rect = child.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            return child;
        }
    }

    const navButtonsContainer = document.querySelector('[class*="buttons-container-"]');
    if (navButtonsContainer) {
        const scopedTitleElements = Array.from(navButtonsContainer.querySelectorAll("[title]"));
        for (const element of scopedTitleElements) {
            const title = element.getAttribute("title")?.toLowerCase() || "";
            if (
                title.includes("fullscreen") ||
                title.includes("tela cheia") ||
                title.includes("pantalla") ||
                title.includes("plein") ||
                title.includes("vollbild")
            ) {
                const child = getVisibleChild(element);
                const rect = child.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return child;
                }
            }
        }

        const visibleChildren = Array.from(navButtonsContainer.children)
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

        if (visibleChildren.length > 0) {
            return getVisibleChild(visibleChildren[0]);
        }
        return navButtonsContainer;
    }

    const docFullscreen = Array.from(document.querySelectorAll("[title]")).find((element) => {
        const title = element.getAttribute("title")?.toLowerCase() || "";
        if (
            title.includes("fullscreen") ||
            title.includes("tela cheia") ||
            title.includes("pantalla") ||
            title.includes("plein") ||
            title.includes("vollbild")
        ) {
            const child = getVisibleChild(element);
            const rect = child.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        return false;
    });
    return docFullscreen ? getVisibleChild(docFullscreen) : null;
}

function clampToViewport(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function getCompactConfigButtonPosition() {
    const fullscreenButton = findFullscreenButton();
    if (!fullscreenButton) {
        return null;
    }

    const rect = fullscreenButton.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }

    const buttonSize = 32;
    const gap = 8;
    const viewportPadding = 8;
    const centeredTop = rect.top + (rect.height - buttonSize) / 2;
    const leftOfFullscreen = rect.left - buttonSize - gap;
    const rightOfFullscreen = rect.right + gap;
    let left = leftOfFullscreen;
    let top = centeredTop;

    if (leftOfFullscreen < viewportPadding && rightOfFullscreen + buttonSize <= window.innerWidth - viewportPadding) {
        left = rightOfFullscreen;
    } else if (leftOfFullscreen < viewportPadding) {
        left = rect.left + (rect.width - buttonSize) / 2;
        top = rect.bottom + gap;
    }

    return {
        left: clampToViewport(left, viewportPadding, window.innerWidth - buttonSize - viewportPadding),
        top: clampToViewport(top, viewportPadding, window.innerHeight - buttonSize - viewportPadding),
    };
}

function positionFloatingContainer(container, state, precomputedCompactPosition) {
    container.style.left = "auto";
    container.style.right = "20px";
    container.style.bottom = "100px";
    container.style.top = "auto";
    container.style.zIndex = "99999";
    container.style.alignItems = "flex-end";
    container.style.flexDirection = "column";

    if (state.containerPosition !== "top-right") {
        return;
    }

    const compactPosition = precomputedCompactPosition ?? getCompactConfigButtonPosition();
    container.style.bottom = "auto";
    container.style.zIndex = "999999";

    if (!compactPosition) {
        container.style.top = "16px";
        container.style.right = "70px";
        return;
    }

    container.style.top = `${compactPosition.top}px`;
    container.style.left = `${compactPosition.left}px`;
    container.style.right = "auto";
    container.style.alignItems = "flex-start";
}

let updateButtonFrame = null;

let compactPositionFrame = null;

export function scheduleUpdateButtonInfo() {
    if (updateButtonFrame !== null) {
        return;
    }

    updateButtonFrame = requestAnimationFrame(() => {
        updateButtonFrame = null;
        updateButtonInfo();
    });
}

const COMPACT_RETRY_MAX = 5;

const COMPACT_RETRY_DELAY = 250;

let compactRetryCount = 0;

function positionCompactConfigButton(isRetry = false) {
    const container = document.getElementById("stremio-mpv-floating");
    if (!container || isPlayerRoute() || GM_getValue("iconMode", "default") !== "compact") {
        return;
    }

    if (!isRetry) {
        compactRetryCount = 0;
    }

    const compactPosition = getCompactConfigButtonPosition();
    positionFloatingContainer(container, applyIconMode("compact"), compactPosition);

    if (compactPosition === null && compactRetryCount < COMPACT_RETRY_MAX) {
        compactRetryCount++;
        setTimeout(() => {
            schedulePositionCompactConfigButton(true);
        }, COMPACT_RETRY_DELAY);
    } else if (compactPosition !== null) {
        compactRetryCount = 0;
    }
}

export function schedulePositionCompactConfigButton(isRetry = false) {
    if (compactPositionFrame !== null) {
        return;
    }

    compactPositionFrame = requestAnimationFrame(() => {
        compactPositionFrame = null;
        positionCompactConfigButton(isRetry);
    });
}

export function createFloatingButton() {
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

export function updateButtonInfo() {
    const container = document.getElementById("stremio-mpv-floating");
    if (!container) return;

    if (isPlayerRoute()) {
        container.style.display = "none";
        return;
    }

    const route = getRouteText();
    const isDetail = route.includes("/detail/");
    const isAddons = route.includes("/addons");

    let state;
    if (isDetail) {
        const iconMode = GM_getValue("iconMode", "default");
        state = applyIconMode(iconMode);
    } else if (isAddons) {
        state = {
            containerVisible: true,
            mpvButtonVisible: false,
            configButtonVisible: true,
            configButtonEnlarged: true,
            configButtonSize: "large",
            containerPosition: "bottom-right",
        };
    } else {
        state = {
            containerVisible: false,
            mpvButtonVisible: false,
            configButtonVisible: false,
            configButtonEnlarged: false,
            configButtonSize: "small",
            containerPosition: "bottom-right",
        };
    }

    container.style.display = state.containerVisible ? "flex" : "none";
    positionFloatingContainer(container, state);

    const playBtn = document.getElementById("stremio-mpv-btn");
    if (playBtn) playBtn.style.display = state.mpvButtonVisible ? "flex" : "none";

    const configBtn = document.getElementById("stremio-mpv-config");
    if (configBtn) {
        const svg = configBtn.querySelector("svg");
        configBtn.style.display = state.configButtonVisible ? "flex" : "none";
        configBtn.style.order = state.containerPosition === "top-right" ? "0" : "";
        if (state.configButtonSize === "large") {
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

    // Episode-pill display is independent of `iconMode` — it still shows
    // S##E## on detail pages. The pill is hidden by default; only flip
    // it on when we have a parsed episode to show.
    const info = document.getElementById("stremio-mpv-info");
    if (info) {
        if (state.containerPosition === "top-right") {
            info.textContent = "";
            info.style.display = "none";
            return;
        }

        info.style.order = state.containerPosition === "top-right" ? "1" : "";
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
}
