const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 9632;
const MPV_PATH = process.env.MPV_PATH || 'C:\\Program Files\\mpv\\mpv.exe';

// ==================== BITSET UTILITIES ====================
/**
 * Decode a Stremio watched string into its components
 * Format: seriesId:lastSeason:lastEpisode:N:b64(zlib(bitset))
 */
function decodeWatchedString(watchedStr) {
    if (!watchedStr) return null;

    const lastColon = watchedStr.lastIndexOf(':');
    const b64Data = watchedStr.substring(lastColon + 1);

    const rest = watchedStr.substring(0, lastColon).split(':');
    if (rest.length < 4) return null;

    const n = parseInt(rest.pop());
    const lastEpisode = parseInt(rest.pop());
    const lastSeason = parseInt(rest.pop());
    const seriesId = rest.join(':');

    try {
        const compressed = Buffer.from(b64Data, 'base64');
        let decompressed;

        try {
            decompressed = zlib.inflateSync(compressed);
        } catch (e1) {
            try {
                decompressed = zlib.inflateRawSync(compressed);
            } catch (e2) {
                console.error('[MPV Bridge] Both inflate methods failed for:', seriesId);
                return null;
            }
        }

        const bitset = [];
        for (let i = 0; i < n; i++) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            if (byteIndex < decompressed.length) {
                bitset[i] = (decompressed[byteIndex] & (1 << bitIndex)) !== 0;
            } else {
                bitset[i] = false;
            }
        }

        return { seriesId, lastSeason, lastEpisode, n, bitset };
    } catch (e) {
        console.error('[MPV Bridge] Error decoding watched bitset:', e.message);
        return null;
    }
}

/**
 * Encode a bitset back into Stremio watched string format
 */
function encodeWatchedString(seriesId, lastSeason, lastEpisode, n, bitset) {
    const numBytes = Math.ceil(n / 8);
    const bytes = Buffer.alloc(numBytes, 0);

    for (let i = 0; i < n; i++) {
        if (bitset[i]) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            bytes[byteIndex] |= (1 << bitIndex);
        }
    }

    const compressed = zlib.deflateSync(bytes);
    const b64Data = compressed.toString('base64');

    return `${seriesId}:${lastSeason}:${lastEpisode}:${n}:${b64Data}`;
}

/**
 * Update the watched bitset for a specific episode
 * Stremio uses INVERTED indexing: episodeIndex = N - episode
 * Where N is the total size of the bitset
 */
function updateWatchedBitset(existingWatched, seriesId, season, episode, totalEpisodes) {
    let bitset = [];
    let n = totalEpisodes || 25;

    if (existingWatched) {
        const decoded = decodeWatchedString(existingWatched);
        if (decoded) {
            bitset = decoded.bitset;
            n = decoded.n;
        }
    }

    if (episode > n) {
        const oldN = n;
        const newN = episode + 10;
        console.log(`[MPV Bridge] Expanding bitset from N=${oldN} to N=${newN}`);

        // Stremio uses inverted indexing: EP 1 is at index N-1.
        // When N increases, we must shift bits to keep them at the same "episode number".
        // Example: EP1 at 27 (N=28). If N=40, EP1 must move to 39.
        // The shift is newN - oldN.
        const shift = newN - oldN;
        const newBitset = new Array(newN).fill(false);
        for (let i = 0; i < bitset.length; i++) {
            if (bitset[i]) {
                newBitset[i + shift] = true;
            }
        }
        bitset = newBitset;
        n = newN;
    }

    const episodeIndex = n - episode;

    while (bitset.length < n) {
        bitset.push(false);
    }

    if (episodeIndex < 0 || episodeIndex >= n) {
        console.error(`[MPV Bridge] ERROR: Episode index ${episodeIndex} out of range (N=${n})`);
        return existingWatched;
    }

    bitset[episodeIndex] = true;

    return encodeWatchedString(seriesId, season, episode, n, bitset);
}

// Active session storage for scrobbling
let activeSession = null;

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
    const { playlist, urls, contentTitle, stremioAuth, stremioContext } = req.body;
    const items = playlist || (urls ? urls.map(u => ({ url: u, title: contentTitle })) : []);

    if (!items || items.length === 0) {
        return res.status(400).json({ error: 'Playlist or URLs array is required' });
    }

    if (stremioAuth) {
        const episodes = items.map((item, index) => ({
            title: item.title || '',
            imdbId: item.imdbId || stremioContext?.imdbId,
            season: item.season ?? stremioContext?.season,
            episode: item.episode ?? (stremioContext?.episode ? stremioContext.episode + index : null),
            type: item.type || stremioContext?.type || 'series'
        }));

        activeSession = {
            authKey: stremioAuth,
            episodes: episodes,
            context: stremioContext,
            name: stremioContext?.name,
            timestamp: Date.now()
        };

        console.log(`[MPV Bridge] ✅ Session stored with ${episodes.length} episode(s):`);
        episodes.forEach((ep, i) => console.log(`  [${i + 1}] ${ep.imdbId} S${ep.season}E${ep.episode}`));
    } else {
        console.warn('[MPV Bridge] ⚠️ No Stremio auth received in /play request. Sync will be disabled.');
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

// New scrobble endpoint for progress-based sync
app.post('/scrobble', async (req, res) => {
    const { percent, imdbId, season, episode, type, title, name, episodeTitle } = req.body;

    if (!activeSession) {
        return res.json({ status: 'no-session', message: 'No active session' });
    }

    if (percent < 90) {
        return res.json({ status: 'ignored', reason: 'Percent below threshold', current: percent });
    }

    const { authKey, episodes } = activeSession;
    const sessionSeriesName = name || activeSession.name;

    let context = null;

    if (imdbId && season && episode) {
        context = { imdbId, season, episode, type: type || 'series', name: sessionSeriesName, episodeTitle };
    } else if ((title || episodeTitle) && episodes && episodes.length > 0) {
        const targetTitle = episodeTitle || title;
        const matchedEp = episodes.find(ep => ep.title && targetTitle.toLowerCase().includes(ep.title.toLowerCase().substring(0, 15)));
        if (matchedEp) {
            context = { ...matchedEp, name: sessionSeriesName };
            console.log(`[MPV Bridge] Matched by title: "${targetTitle.substring(0, 40)}..." => S${matchedEp.season}E${matchedEp.episode}`);
        }
    }

    if (!context && episodes && episodes.length > 0) {
        context = { ...episodes[0], name: sessionSeriesName };
    }
    if (!context && activeSession.context) {
        context = { ...activeSession.context, name: sessionSeriesName };
    }

    if (!context || !context.imdbId || !context.season || !context.episode) {
        console.warn(`[MPV Bridge] Incomplete context for scrobble:`, context);
        return res.status(400).json({ error: 'Incomplete metadata' });
    }

    console.log(`[MPV Bridge] Scrobble request: ${context.name || 'Unknown'} - ID=${context.imdbId} S${context.season}E${context.episode} (${percent}%)`);

    try {
        const isKitsu = context.imdbId.startsWith('kitsu:');
        if (isKitsu) {
            console.log(`[MPV Bridge] Kitsu sync is not supported. Ignoring scrobble for ${context.imdbId}.`);
            return res.json({ status: 'ignored', reason: 'Kitsu sync not supported' });
        }

        console.log(`[MPV Bridge] Fetching item ${context.imdbId}...`);
        const getRes = await axios.post('https://api.strem.io/api/datastoreGet', {
            authKey: authKey,
            collection: 'libraryItem',
            all: false,
            ids: [context.imdbId]
        });
        const items = getRes.data && (getRes.data.result || getRes.data);
        item = Array.isArray(items) ? items[0] : items;

        if (!item || !item.state) {
            console.log(`[MPV Bridge] Item ${context.imdbId} not found in library. Searching by name...`);
            const allRes = await axios.post('https://api.strem.io/api/datastoreGet', {
                authKey: authKey,
                collection: 'libraryItem',
                all: true
            });
            const library = allRes.data && (allRes.data.result || allRes.data) || [];

            item = library.find(i => i.name && context.name && i.name.toLowerCase() === context.name.toLowerCase());

            if (item) {
                console.log(`[MPV Bridge] Found library item by name match: ${item.name} (${item._id})`);
                context.imdbId = item._id;
            }
        }

        if (!item || !item.state) {
            console.error(`[MPV Bridge] ERROR: Could not find "${context.name}" in library.`);
            return res.status(404).json({ error: 'Item not in library' });
        }

        const now = new Date().toISOString();
        const videoId = `${context.imdbId}:${context.season}:${context.episode}`;

        const existingWatched = item.state?.watched;
        const totalEpisodes = 100;
        const newWatched = updateWatchedBitset(existingWatched, context.imdbId, context.season, context.episode, totalEpisodes);

        item.state = item.state || {};
        item.state.lastWatched = now;
        item.state.video_id = videoId;
        item.state.timeOffset = 1;
        item.state.watched = newWatched;

        delete item.state.flaggedWatched;
        delete item.state.timesWatched;

        item._mtime = now;

        console.log(`[MPV Bridge] Updating Stremio library: ${item.name} (EP ${context.episode})...`);
        const putRes = await axios.post('https://api.strem.io/api/datastorePut', {
            authKey: authKey,
            collection: 'libraryItem',
            changes: [item]
        });

        if (putRes.status === 200) {
            console.log(`[MPV Bridge] ✅ Sync successful for ${item.name} S${context.season}E${context.episode}!`);
            res.json({ success: true });
        } else {
            throw new Error(`Stremio API returned status ${putRes.status}`);
        }
    } catch (error) {
        const errorMsg = error.response?.data || error.message;
        console.error('[MPV Bridge] ❌ Stremio sync failed:', errorMsg);
        res.status(500).json({ error: 'Stremio API failed', details: errorMsg });
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
║    POST /scrobble  - Sync watch progress                  ║
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
