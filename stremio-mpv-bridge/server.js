const express = require("express");
const cors = require("cors");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// Load .env from project root (shared with mpv-rpc)
try {
    const envFile = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", ".env"), "utf-8");
    for (const line of envFile.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx > 0) {
                const key = trimmed.slice(0, eqIdx).trim();
                let val = trimmed.slice(eqIdx + 1).trim();
                // Strip surrounding quotes (single or double)
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (!process.env[key]) {
                    process.env[key] = val;
                }
            }
        }
    }
} catch (_) {
    // .env file is optional — no warning needed
}

const app = express();
const PORT = process.env.PORT || 9632;
const MPV_PATH = process.env.MPV_PATH || "mpv";

app.use(express.json());
app.use(
    cors({
        origin: ["https://web.stremio.com", "http://localhost:8080"],
        methods: ["GET", "POST"],
        credentials: true,
    }),
);

app.get("/health", (_req, res) => {
    res.json({ status: "ok", mpvPath: MPV_PATH });
});

app.post("/play", (req, res) => {
    const { playlist, urls, contentTitle, args } = req.body;
    const items = playlist || (urls ? urls.map((u) => ({ url: u, title: contentTitle })) : []);

    if (
        !items ||
        !Array.isArray(items) ||
        items.length === 0 ||
        !items.every((item) => item?.url && typeof item.url === "string" && item.url.trim().length > 0)
    ) {
        return res.status(400).json({ error: "Playlist or URLs array with valid urls is required" });
    }

    console.log(`[MPV Bridge] Opening ${items.length} item(s) in MPV...`);
    items.forEach((item, i) => {
        let displayTitle = item.title;

        if (displayTitle?.includes("%")) {
            try {
                displayTitle = decodeURIComponent(displayTitle);
            } catch (_e) {}
        }

        if (!displayTitle) {
            try {
                const decoded = decodeURIComponent(item.url);
                displayTitle = decoded.split("/").pop().split("?")[0];
            } catch (_e) {
                displayTitle = item.url.substring(0, 50);
            }
        }
        item.title = displayTitle; // Save it back so the M3U gets the clean title
        console.log(`  [${i + 1}] ${displayTitle}`);
    });

    try {
        const mpvArgs = ["--force-window=immediate", "--keep-open=yes"];

        if (args && typeof args === "string") {
            const parsedArgs = args.match(/(?:[^\s"]+|"[^"]*")+/g);
            if (parsedArgs) {
                mpvArgs.push(...parsedArgs.map((a) => a.replace(/^"|"$/g, "")));
            }
        } else if (args && Array.isArray(args)) {
            mpvArgs.push(...args);
        }

        const m3uContent = [
            "#EXTM3U",
            ...items.map((item) => {
                const safeTitle = (item.title || "Stream").replace(/[\r\n]+/g, " - ");
                return `#EXTINF:-1,${safeTitle}\n${item.url}`;
            }),
        ].join("\n");
        const tmpPath = path.join(os.tmpdir(), `stremio-playlist-${crypto.randomBytes(8).toString("hex")}.m3u`);

        try {
            fs.writeFileSync(tmpPath, m3uContent);
        } catch (writeError) {
            console.error("[MPV Bridge] Failed to write playlist file:", writeError.message);
            return res.status(500).json({ error: "Failed to write playlist file" });
        }

        mpvArgs.push(tmpPath);

        const mpvProcess = spawn(MPV_PATH, mpvArgs, {
            detached: true,
            stdio: "ignore",
        });

        mpvProcess.once("error", (err) => {
            console.error(`[MPV Bridge] Failed to start MPV: ${err.message}`);
            // Clean up temporary playlist file on spawn failure
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            // Note: response already sent if error fires after response
        });

        mpvProcess.unref();

        console.log(`[MPV Bridge] MPV started with PID: ${mpvProcess.pid}`);
        console.log(`[MPV Bridge] Playlist: ${tmpPath}`);

        res.json({
            success: true,
            message: `Opening ${items.length} item(s) in MPV`,
            pid: mpvProcess.pid,
        });
    } catch (error) {
        console.error("[MPV Bridge] Error opening MPV:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const server = app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║               Stremio MPV Bridge - Local Server           ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(51)}║
║  MPV:  ${MPV_PATH.padEnd(51).substring(0, 51)}║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /health    - Server status check                  ║
║    POST /play      - Open URLs in MPV                     ║
╚═══════════════════════════════════════════════════════════╝
`);
});

function shutdown() {
    console.log("\n[MPV Bridge] Shutting down...");
    server.close(() => {
        console.log("[MPV Bridge] Server stopped.");
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
