// Console logging helpers.

export function log(...args) {
    if (GM_getValue("debug", false)) {
        console.log("%c[Stremio-MPV]", "color: #8b5cf6; font-weight: bold;", ...args);
    }
}

export function info(...args) {
    console.log("%c[Stremio-MPV]", "color: #22c55e; font-weight: bold;", ...args);
}
