const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 9632;
const MPV_PATH = process.env.MPV_PATH || 'C:\\Program Files\\mpv\\mpv.exe';

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
    items.forEach((item, i) => console.log(`  [${i + 1}] ${item.title || item.url.substring(0, 50)}`));

    try {
        let mpvArgs = [
            '--force-window=immediate',
            '--keep-open=yes',
        ];

        const m3uContent = ['#EXTM3U', ...items.map(item => `#EXTINF:-1,${item.title || 'Stream'}\n${item.url}`)].join('\n');
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
║  Port: ${PORT}                                               ║
║  MPV:  ${MPV_PATH.padEnd(45).substring(0, 45)}║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /health  - Server status check                    ║
║    POST /play    - Open URLs in MPV                       ║
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
