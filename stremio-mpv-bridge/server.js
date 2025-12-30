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

    const parts = watchedStr.split(':');
    if (parts.length < 5) return null;

    const seriesId = parts[0];
    const lastSeason = parseInt(parts[1]);
    const lastEpisode = parseInt(parts[2]);
    const n = parseInt(parts[3]);
    const b64Data = parts[4];

    try {
        const compressed = Buffer.from(b64Data, 'base64');
        let decompressed;

        // Try regular inflate first, then raw inflate
        try {
            decompressed = zlib.inflateSync(compressed);
        } catch (e1) {
            try {
                decompressed = zlib.inflateRawSync(compressed);
            } catch (e2) {
                console.error('[MPV Bridge] Both inflate methods failed:', e1.message, e2.message);
                return null;
            }
        }


        // Convert to bitset array
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
    // Build byte array from bitset
    const numBytes = Math.ceil(n / 8);
    const bytes = Buffer.alloc(numBytes, 0);

    for (let i = 0; i < n; i++) {
        if (bitset[i]) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            bytes[byteIndex] |= (1 << bitIndex);
        }
    }

    // Compress with zlib and encode base64
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
    let n = totalEpisodes || 28; // Default to 28 if not specified

    // If we have existing watched data, decode it and PRESERVE its N value
    if (existingWatched) {
        const decoded = decodeWatchedString(existingWatched);
        if (decoded) {
            bitset = decoded.bitset;
            n = decoded.n; // Use the existing N from Stremio
        }
    }

    // Stremio uses INVERTED indexing: episodeIndex = N - episode
    // EP1 = index N-1, EP2 = index N-2, etc.
    const episodeIndex = n - episode;


    // Ensure bitset is large enough
    while (bitset.length < n) {
        bitset.push(false);
    }

    // Validate index is in range
    if (episodeIndex < 0 || episodeIndex >= n) {
        console.error(`[MPV Bridge] ERROR: Episode index ${episodeIndex} out of range (N=${n})`);
        return existingWatched; // Return unchanged
    }

    // Set the bit for this episode
    bitset[episodeIndex] = true;

    // Encode back to watched string
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

    // Store session context for scrobbling - now with full episode array
    if (stremioAuth) {
        // Build episodes array from playlist items (each now has metadata)
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
            context: stremioContext, // Keep for backward compatibility
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
    const { percent, imdbId, season, episode, type, title } = req.body;

    if (!activeSession) {
        return res.json({ status: 'no-session', message: 'No active session' });
    }

    if (percent < 90) {
        return res.json({ status: 'ignored', reason: 'Percent below threshold', current: percent });
    }

    const { authKey, episodes } = activeSession;

    // Try to find the episode by:
    // 1. Direct match from request data (if RPC provides it)
    // 2. Title match from stored episodes array
    // 3. Fallback to legacy context (first episode only)
    let context = null;

    // Method 1: Check if request has valid metadata
    if (imdbId && season && episode) {
        context = { imdbId, season, episode, type: type || 'series' };
        console.log(`[MPV Bridge] Using metadata from RPC: ${imdbId} S${season}E${episode}`);
    }
    // Method 2: Match by title from episodes array
    else if (title && episodes && episodes.length > 0) {
        const matchedEp = episodes.find(ep => ep.title && title.includes(ep.title.substring(0, 30)));
        if (matchedEp) {
            context = matchedEp;
            console.log(`[MPV Bridge] Matched by title: "${title.substring(0, 40)}..." => S${matchedEp.season}E${matchedEp.episode}`);
        }
    }
    // Method 3: Try to extract episode number from title and match
    if (!context && title && episodes && episodes.length > 0) {
        // First try E## pattern (more specific)
        let epMatch = title.match(/E0*(\d+)/i);
        // Fallback to S##E## pattern and extract episode
        if (!epMatch) {
            epMatch = title.match(/S\d+E0*(\d+)/i);
        }
        if (epMatch) {
            const epNum = parseInt(epMatch[1]);
            const matchedEp = episodes.find(ep => ep.episode === epNum);
            if (matchedEp) {
                context = matchedEp;
                console.log(`[MPV Bridge] Matched by episode number: E${epNum} => S${matchedEp.season}E${matchedEp.episode}`);
            }
        }
    }
    // Method 4: Fallback to first episode in session
    if (!context && episodes && episodes.length > 0) {
        context = episodes[0];
        console.log(`[MPV Bridge] Fallback to first episode: S${context.season}E${context.episode}`);
    }
    // Method 5: Legacy fallback to context
    if (!context && activeSession.context) {
        context = activeSession.context;
        console.log(`[MPV Bridge] Legacy fallback: S${context.season}E${context.episode}`);
    }

    if (!context || !context.imdbId || !context.season || !context.episode) {
        console.warn(`[MPV Bridge] Incomplete context for scrobble:`, context);
        return res.status(400).json({ error: 'Incomplete metadata' });
    }

    console.log(`[MPV Bridge] Threshold reached (${percent}%). Syncing ${context.imdbId} S${context.season}E${context.episode} with Stremio...`);

    try {
        console.log(`[MPV Bridge] Fetching item ${context.imdbId} from Stremio datastore...`);
        const getRes = await axios.post('https://api.strem.io/api/datastoreGet', {
            authKey: authKey,
            collection: 'libraryItem',
            all: false,
            ids: [context.imdbId]
        });

        // Stremio API might return array directly or wrapped in result
        const items = getRes.data && (getRes.data.result || getRes.data);
        let item = Array.isArray(items) ? items[0] : items;

        if (!item || !item.state) {
            console.error(`[MPV Bridge] ERROR: Item ${context.imdbId} not found or invalid in library.`);
            return res.status(404).json({ error: 'Item not in library' });
        }

        const now = new Date().toISOString();
        const videoId = `${context.imdbId}:${context.season}:${context.episode}`;

        // Update watched bitset - accumulates episodes instead of overwriting
        const existingWatched = item.state?.watched;
        const totalEpisodes = item.state?.duration ? 50 : 50; // Default to 50 episodes
        const newWatched = updateWatchedBitset(existingWatched, context.imdbId, context.season, context.episode, totalEpisodes);

        console.log(`[MPV Bridge] Updating watched bitset:`);
        console.log(`  Previous: ${existingWatched || 'none'}`);
        console.log(`  New:      ${newWatched}`);

        // Update item state with new watched bitset
        item.state = item.state || {};
        item.state.lastWatched = now;
        item.state.video_id = videoId;
        item.state.timesWatched = (item.state.timesWatched || 0) + 1;
        item.state.timeWatched = item.state.duration || 1500000;
        item.state.timeOffset = 1;
        item.state.flaggedWatched = 1;
        item.state.watched = newWatched;
        item._mtime = now;

        console.log(`[MPV Bridge] Updating item in Stremio datastore...`);
        const putRes = await axios.post('https://api.strem.io/api/datastorePut', {
            authKey: authKey,
            collection: 'libraryItem',
            changes: [item]
        });

        if (putRes.status === 200) {
            console.log(`[MPV Bridge] ✅ Stremio sync successful for ${context.imdbId} S${context.season}E${context.episode}!`);
            // We NO LONGER clear activeSession here to allow playlist next items to sync
            res.json({ success: true, message: 'Stremio sync successful' });
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
