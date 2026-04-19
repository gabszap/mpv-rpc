const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 9632;
const MPV_PATH = process.env.MPV_PATH || 'C:\\Program Files\\mpv\\mpv.exe';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toBase64UrlJson(payload) {
    const json = JSON.stringify(payload);
    return Buffer.from(json, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function removeUndefinedValues(payload) {
    if (!isObject(payload)) {
        return null;
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined) {
            cleaned[key] = value;
        }
    }

    return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function getItemContext(reqBody, item) {
    const requestContext = isObject(reqBody.stremioContext) ? reqBody.stremioContext : null;
    const playlistItemContext = isObject(item.stremioContext) ? item.stremioContext : null;

    const merged = {
        ...(requestContext || {}),
        ...(playlistItemContext || {})
    };

    return removeUndefinedValues(merged);
}



app.use(express.json());
app.use(cors({
    origin: ['https://web.stremio.com', 'http://localhost:8080'],
    methods: ['GET', 'POST'],
    credentials: true
}));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', mpvPath: MPV_PATH });
});

let lastPlaylist = null;

app.post('/play', (req, res) => {
    const { playlist, urls, contentTitle } = req.body;
    const items = playlist || (urls ? urls.map(u => ({ url: u, title: contentTitle })) : []);

    if (!items || items.length === 0) {
        return res.status(400).json({ error: 'Playlist or URLs array is required' });
    }

    console.log(`[MPV Bridge] Opening ${items.length} item(s) in MPV...`);
    items.forEach((item, i) => {
        let displayTitle = item.title;
        
        if (displayTitle && displayTitle.includes('%')) {
            try {
                displayTitle = decodeURIComponent(displayTitle);
            } catch (e) {}
        }

        if (!displayTitle) {
            try {
                const decoded = decodeURIComponent(item.url);
                displayTitle = decoded.split('/').pop().split('?')[0];
            } catch (e) {
                displayTitle = item.url.substring(0, 50);
            }
        }
        item.title = displayTitle; // Save it back so the M3U gets the clean title
        console.log(`  [${i + 1}] ${displayTitle}`);
    });

    try {
        let mpvArgs = [
            '--force-window=immediate',
            '--keep-open=yes',
        ];

        const m3uLines = ['#EXTM3U'];

        items.forEach((item) => {
            const itemContext = getItemContext(req.body, item);
            if (itemContext) {
                m3uLines.push(`#MPVRPC-CTX:${toBase64UrlJson(itemContext)}`);
            }

            m3uLines.push(`#EXTINF:-1,${item.title || 'Stream'}`);
            m3uLines.push(item.url);
        });

        const m3uContent = m3uLines.join('\n');
        const tmpPath = path.join(os.tmpdir(), `stremio-playlist-${Date.now()}.m3u`);
        fs.writeFileSync(tmpPath, m3uContent);

        if (lastPlaylist && fs.existsSync(lastPlaylist)) {
            try { fs.unlinkSync(lastPlaylist); } catch (e) { }
        }
        lastPlaylist = tmpPath;

        mpvArgs.push(tmpPath);

        const mpvProcess = spawn(MPV_PATH, mpvArgs, {
            detached: true,
            stdio: 'ignore'
        });

        mpvProcess.unref();

        console.log(`[MPV Bridge] MPV started with PID: ${mpvProcess.pid}`);
        console.log(`[MPV Bridge] Playlist: ${tmpPath}`);

        res.json({
            success: true,
            message: `Opening ${items.length} item(s) in MPV`,
            pid: mpvProcess.pid
        });

    } catch (error) {
        console.error('[MPV Bridge] Error opening MPV:', error.message);
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
    console.log('\n[MPV Bridge] Shutting down...');
    if (lastPlaylist && fs.existsSync(lastPlaylist)) {
        try {
            fs.unlinkSync(lastPlaylist);
            console.log('[MPV Bridge] Cleaned up temporary playlist.');
        } catch (e) { }
    }
    server.close(() => {
        console.log('[MPV Bridge] Server stopped.');
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
