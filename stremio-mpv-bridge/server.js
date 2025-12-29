const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

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

app.post('/play', (req, res) => {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'URLs array is required' });
    }

    console.log(`[MPV Bridge] Opening ${urls.length} URL(s) in MPV...`);
    urls.forEach((url, i) => console.log(`  [${i + 1}] ${url.substring(0, 80)}...`));

    try {
        const args = [
            '--force-window=immediate',
            '--keep-open=yes',
            ...urls
        ];

        const mpvProcess = spawn(MPV_PATH, args, {
            detached: true,
            stdio: 'ignore'
        });

        mpvProcess.unref();

        console.log(`[MPV Bridge] MPV started with PID: ${mpvProcess.pid}`);

        res.json({
            success: true,
            message: `Opening ${urls.length} item(s) in MPV`,
            pid: mpvProcess.pid
        });

    } catch (error) {
        console.error('[MPV Bridge] Error opening MPV:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
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
