// Toast notifications and the now-playing / bridge-connected widgets.

import { info } from "./logging.js";

export function notify(msg, type = "info") {
    info(msg);
    showToast(msg, type);
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

export function showToast(message, type = "info") {
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

export function showNowPlayingWidget(title) {
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

export function showBridgeConnectedToast() {
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
