// ==UserScript==
// @name         Stremio MPV Bridge
// @namespace    https://github.com/gabszap/mpv-rpc
// @version      1.6.4
// @icon         https://www.stremio.com/website/stremio-purple-small.png
// @description  Open Stremio Web streams directly in MPV with playlist support
// @homepage     https://github.com/gabszap/mpv-rpc
// @updateURL    https://github.com/gabszap/mpv-rpc/raw/refs/heads/main/stremio-mpv-bridge/stremio-mpv.user.js
// @downloadURL  https://github.com/gabszap/mpv-rpc/raw/refs/heads/main/stremio-mpv-bridge/stremio-mpv.user.js
// @author       gabszap
// @match        https://web.stremio.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        SERVER_URL: 'http://localhost:9632',
        DEBUG: false
    };

    const DEFAULT_PROVIDERS = [
        { id: 'torrentio', name: 'Torrentio', url: '', enabled: true },
        { id: 'comet', name: 'Comet', url: '', enabled: true },
        { id: 'mediafusion', name: 'MediaFusion', url: '', enabled: true },
        { id: 'torbox', name: 'Torbox', url: '', enabled: true },
        { id: 'real-debrid', name: 'Real-Debrid', url: '', enabled: true },
        { id: 'custom', name: 'Custom', url: '', enabled: true }
    ];

    let extraEpisodes = GM_getValue('extraEpisodes', 2);
    let playlistMode = GM_getValue('playlistMode', 'fixed');
    let mpvShortcut = GM_getValue('mpvShortcut', 'v');

    let storedProviders = GM_getValue('providers', []);
    let providers;

    if (storedProviders.length > 0) {
        providers = [...storedProviders];
        DEFAULT_PROVIDERS.forEach(def => {
            if (!providers.find(p => p.id === def.id)) providers.push(def);
        });
        providers = providers.filter(p => DEFAULT_PROVIDERS.find(d => d.id === p.id));
    } else {
        providers = [...DEFAULT_PROVIDERS];
    }

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('%c[Stremio-MPV]', 'color: #8b5cf6; font-weight: bold;', ...args);
        }
    }

    function notify(msg, type = 'info') {
        log(msg);
        showToast(msg, type);
    }

    // ==================== CONFIGURATION UI ====================
    function createConfigModal() {
        if (document.getElementById('stremio-mpv-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'stremio-mpv-modal';

        let providersHTML = providers.map((p, index) => `
            <div class="mpv-form-group mpv-provider-item" data-id="${p.id}">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" data-id="${p.id}" class="mpv-provider-toggle" ${p.enabled ? 'checked' : ''} 
                               style="width: 16px; height: 16px; min-width: 16px; min-height: 16px; cursor: pointer; accent-color: #8b5cf6; appearance: auto; -webkit-appearance: checkbox; margin: 0;">
                        <label class="mpv-label" style="margin: 0; cursor: pointer;" onclick="this.parentElement.querySelector('input').click()">${p.name}</label>
                    </div>
                    <div style="display: flex; gap: 4px;">
                        <button class="mpv-reorder-btn" onclick="const item = this.closest('.mpv-provider-item'); if(item.previousElementSibling?.classList.contains('mpv-provider-item')) item.parentNode.insertBefore(item, item.previousElementSibling)" title="Move Up">▲</button>
                        <button class="mpv-reorder-btn" onclick="const item = this.closest('.mpv-provider-item'); if(item.nextElementSibling?.classList.contains('mpv-provider-item')) item.parentNode.insertBefore(item.nextElementSibling, item)" title="Move Down">▼</button>
                    </div>
                </div>
                <input type="text" data-id="${p.id}" class="mpv-input mpv-provider-input" 
                       placeholder="Paste manifest.json link here" value="${p.url}" 
                       style="${!p.enabled ? 'opacity: 0.5; pointer-events: none;' : ''}">
            </div>
        `).join('');

        modal.innerHTML = `
            <style>
                #stremio-mpv-modal {
                    position: fixed; inset: 0; z-index: 100000;
                    background: rgba(0,0,0,0.25);
                    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                    display: flex; align-items: center; justify-content: center;
                    font-family: 'Roboto', sans-serif;
                    opacity: 0; transition: opacity 0.3s ease;
                    color-scheme: dark;
                }
                .mpv-modal-content {
                    background: rgba(15, 15, 15, 0.65); color: #eee;
                    padding: 24px; border-radius: 20px;
                    width: 450px; max-width: 90vw;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    box-shadow: 0 20px 50px rgba(0,0,0,0.6);
                    max-height: 90vh; overflow-y: auto;
                    transform: scale(0.9); transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                }
                #stremio-mpv-modal.active { opacity: 1; }
                #stremio-mpv-modal.active .mpv-modal-content { transform: scale(1); }
                
                .mpv-modal-header {
                    font-size: 22px; font-weight: bold; margin-bottom: 24px;
                    background: linear-gradient(45deg, #a78bfa, #8b5cf6);
                    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
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
                    display: flex; justify-content: flex-end; gap: 12px; margin-top: 30px;
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
                .mpv-reorder-btn {
                    background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #aaa;
                    border-radius: 6px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
                    cursor: pointer; font-size: 10px; transition: all 0.2s ease;
                }
                .mpv-reorder-btn:hover { background: #8b5cf6; color: white; border-color: #8b5cf6; }
            </style>
            <div class="mpv-modal-content">
                <div class="mpv-modal-header">MPV Bridge Settings <span style="font-size: 14px; opacity: 0.6; font-weight: normal; margin-left: 8px;">v${GM_info.script.version}</span></div>
                
                ${providersHTML}
                <div class="mpv-help" style="margin-bottom: 20px; color: #aaa;">Copy the link from the addon's "Share" button.</div>

                <div class="mpv-form-group">
                    <label class="mpv-label">Stream Mode</label>
                    <div class="mpv-checkbox-group">
                        <input type="checkbox" id="mpv-playlist-all" class="mpv-checkbox" ${playlistMode === 'all' ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: #8b5cf6; cursor: pointer;">
                        <div style="flex:1">
                            <label for="mpv-playlist-all" style="cursor:pointer; user-select:none; font-size: 14px;">Load all episodes</label>
                            <div class="mpv-help" style="margin-top:2px">Loads all remaining episodes of the current season</div>
                        </div>
                    </div>
                </div>

                <div class="mpv-form-group" id="mpv-group-count" style="${playlistMode === 'all' ? 'opacity:0.3; pointer-events:none' : ''}">
                    <label class="mpv-label">Next episodes to load</label>
                    <input type="number" id="mpv-ep-count" class="mpv-input" value="${extraEpisodes}" min="1" max="25">
                </div>

                <div class="mpv-form-group">
                    <label class="mpv-label">Keyboard Shortcut</label>
                    <input type="text" id="mpv-shortcut" class="mpv-input" value="${mpvShortcut}" maxlength="1" style="width: 60px; text-align: center; text-transform: uppercase; font-weight: bold;">
                </div>

                <div class="mpv-actions">
                    <button class="mpv-btn mpv-btn-cancel" id="mpv-cancel">Cancel</button>
                    <button class="mpv-btn mpv-btn-save" id="mpv-save">Save</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        requestAnimationFrame(() => modal.classList.add('active'));

        const checkbox = modal.querySelector('#mpv-playlist-all');
        const countGroup = modal.querySelector('#mpv-group-count');

        checkbox.addEventListener('change', (e) => {
            countGroup.style.opacity = e.target.checked ? '0.3' : '1';
            countGroup.style.pointerEvents = e.target.checked ? 'none' : 'auto';
        });

        const closeModal = () => {
            modal.classList.remove('active');
            setTimeout(() => modal.remove(), 300);
        };

        modal.querySelector('#mpv-cancel').addEventListener('click', closeModal);
        modal.querySelector('#mpv-save').addEventListener('click', () => {
            saveConfig();
            closeModal();
        });

        modal.querySelectorAll('.mpv-provider-toggle').forEach(toggle => {
            toggle.addEventListener('change', (e) => {
                const input = modal.querySelector(`.mpv-provider-input[data-id="${e.target.dataset.id}"]`);
                if (input) {
                    input.style.opacity = e.target.checked ? '1' : '0.5';
                    input.style.pointerEvents = e.target.checked ? 'auto' : 'none';
                }
            });
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    function saveConfig() {
        const modal = document.getElementById('stremio-mpv-modal');
        const countInput = modal.querySelector('#mpv-ep-count');
        const allCheckbox = modal.querySelector('#mpv-playlist-all');
        const shortcutInput = modal.querySelector('#mpv-shortcut');

        const providerItems = Array.from(modal.querySelectorAll('.mpv-provider-item'));

        providers = providerItems.map(item => {
            const id = item.dataset.id;
            const input = item.querySelector('.mpv-provider-input');
            const toggle = item.querySelector('.mpv-provider-toggle');
            let url = input ? input.value.trim() : '';
            if (url && url.includes('/manifest.json')) {
                url = url.split('/manifest.json')[0];
            }
            return {
                id: id,
                name: DEFAULT_PROVIDERS.find(d => d.id === id).name,
                url: url,
                enabled: toggle ? toggle.checked : true
            };
        });

        GM_setValue('providers', providers);

        extraEpisodes = Math.max(1, Math.min(25, parseInt(countInput.value) || 2));
        GM_setValue('extraEpisodes', extraEpisodes);

        playlistMode = allCheckbox.checked ? 'all' : 'fixed';
        GM_setValue('playlistMode', playlistMode);

        mpvShortcut = (shortcutInput.value || 'v').toLowerCase();
        GM_setValue('mpvShortcut', mpvShortcut);

        showToast('Settings saved!', 'success');
    }

    // ==================== URL PARSER ====================
    function parseCurrentURL() {
        const hash = window.location.hash;
        log('Parsing URL:', hash.substring(0, 60) + '...');

        if (hash.includes('/player/') && lastValidContent && lastValidContent.episode) {
            log('Using saved content (player mode):', lastValidContent);
            return lastValidContent;
        }

        const decodedHash = decodeURIComponent(hash);
        const contentMatch = decodedHash.match(/tt\d+:\d+:\d+/);
        if (contentMatch) {
            const parts = contentMatch[0].split(':');
            const result = {
                type: 'series',
                imdbId: parts[0],
                season: parseInt(parts[1]),
                episode: parseInt(parts[2])
            };
            log('Content found:', result);
            lastValidContent = result;
            return result;
        }

        const imdbMatch = decodedHash.match(/(tt\d+)/);
        if (imdbMatch) {
            return {
                type: 'series',
                imdbId: imdbMatch[1],
                season: parseInt(decodedHash.match(/season=(\d+)/)?.[1]) || null,
                episode: null
            };
        }
        return lastValidContent || null;
    }

    let lastValidContent = null;

    // ==================== FLOATING UI ====================
    const MPV_ICON = `<svg viewBox="0 0 64 64" width="48" height="48" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="o" x1="13" y1="0" x2="53" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f9f9f9"/><stop offset="1" stop-color="#b9b9b9"/></linearGradient><linearGradient id="m" x1="44" y1="43" x2="18" y2="-2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#451b4c"/><stop offset="1" stop-color="#6c3c76"/></linearGradient><linearGradient id="i" x1="25" y1="5" x2="49" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2f0e35"/><stop offset="1" stop-color="#732e7d"/></linearGradient><linearGradient id="c" x1="24" y1="12" x2="42" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f1f0f1"/><stop offset="1" stop-color="#ada7af"/></linearGradient><linearGradient id="p" x1="29" y1="18" x2="33" y2="23" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#66386f"/><stop offset="1" stop-color="#461d4d"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#o)"/><circle cx="33" cy="31" r="28" fill="url(#m)"/><circle cx="35" cy="29" r="21" fill="url(#i)"/><circle cx="32" cy="32" r="14" fill="url(#c)"/><path d="M28 25v12l10-6z" fill="url(#p)"/></svg>`;
    const GEAR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" style="fill: currentColor;"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0 .59-.22L2.74 8.87c-.04.17 0 .42.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;

    function createFloatingButton() {
        if (document.getElementById('stremio-mpv-floating')) return;

        const container = document.createElement('div');
        container.id = 'stremio-mpv-floating';
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

        container.querySelector('#stremio-mpv-btn').addEventListener('click', handleMPVClick);
        container.querySelector('#stremio-mpv-config').addEventListener('click', createConfigModal);
        updateButtonInfo();
    }

    function updateButtonInfo() {
        const container = document.getElementById('stremio-mpv-floating');
        if (!container) return;

        const hash = window.location.hash;
        const isDetail = hash.includes('/detail/');
        const isAddons = hash.includes('/addons');

        if (!isDetail && !isAddons) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        const playBtn = document.getElementById('stremio-mpv-btn');
        if (playBtn) playBtn.style.display = isDetail ? 'flex' : 'none';

        const configBtn = document.getElementById('stremio-mpv-config');
        if (configBtn) {
            const svg = configBtn.querySelector('svg');
            if (isAddons) {
                configBtn.style.width = '48px';
                configBtn.style.height = '48px';
                configBtn.style.opacity = '1';
                if (svg) { svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); }
            } else {
                configBtn.style.width = '32px';
                configBtn.style.height = '32px';
                configBtn.style.opacity = '0.6';
                if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); }
            }
        }

        const info = document.getElementById('stremio-mpv-info');
        if (isDetail) {
            const content = parseCurrentURL();
            if (content && content.episode) {
                info.textContent = `S${content.season}E${content.episode}`;
                info.style.display = 'block';
            } else {
                info.style.display = 'none';
            }
        } else {
            info.style.display = 'none';
        }
    }

    // ==================== MAIN LOGIC ====================
    async function handleMPVClick(e) {
        e.preventDefault(); e.stopPropagation();

        const activeProviders = providers.filter(p => p.enabled && p.url);
        if (activeProviders.length === 0) {
            createConfigModal();
            return;
        }

        const btn = document.getElementById('stremio-mpv-btn');
        btn.classList.add('loading');

        try {
            if (!(await checkServer())) {
                showToast('Server offline! (npm start)', 'error');
                return;
            }

            const content = parseCurrentURL();
            if (!content || !content.episode) {
                showToast('Please select an episode', 'error');
                return;
            }

            const limit = playlistMode === 'all' ? 50 : extraEpisodes;
            const modeText = playlistMode === 'all' ? 'Playlist' : 'Episode Batch';
            notify(`Fetching streams... (Mode: ${modeText})`, 'info');

            const playlist = await collectStreams(content, limit);

            if (playlist.length === 0) {
                showToast('No streams found', 'error');
                return;
            }

            await sendToMPV(playlist, content);
            showToast(`Opening ${playlist.length} item(s) in MPV`, 'success');

            syncProgressWithStremio(content);

        } catch (error) {
            log('Error:', error);
            showToast(error.message, 'error');
        } finally {
            btn.classList.remove('loading');
        }
    }

    async function checkServer() {
        return new Promise(r => GM_xmlhttpRequest({
            method: 'GET', url: `${CONFIG.SERVER_URL}/health`, timeout: 2000,
            onload: res => r(res.status === 200), onerror: () => r(false), ontimeout: () => r(false)
        }));
    }

    async function collectStreams(content, limit) {
        const items = [];

        const fetchWithProviders = async (season, ep) => {
            for (const p of providers) {
                if (!p.enabled || !p.url) continue;
                log(`Trying ${p.name} for S${season}E${ep}...`);
                const streams = await fetchStreams(p.url, content.imdbId, season, ep);
                const streamItem = findBestStream(streams);
                if (streamItem) {
                    log(`Found on ${p.name}`);
                    return streamItem;
                }
            }
            return null;
        };

        notify(`Fetching S${content.season}E${content.episode}...`);
        const firstItem = await fetchWithProviders(content.season, content.episode);
        if (firstItem) items.push(firstItem);

        if (content.type === 'series' && limit > 0) {
            let failures = 0;
            for (let i = 1; i <= limit; i++) {
                const nextEp = content.episode + i;
                notify(`Fetching S${content.season}E${nextEp}...`);

                const nextItem = await fetchWithProviders(content.season, nextEp);

                if (nextItem) {
                    items.push(nextItem);
                    failures = 0;
                } else {
                    log(`Episode ${nextEp} not found on any provider.`);
                    failures++;
                    if (playlistMode === 'all' && failures >= 3) {
                        log('Too many consecutive failures, stopping search.');
                        break;
                    }
                }
            }
        }
        return items;
    }

    async function fetchStreams(baseUrl, imdbId, season, episode) {
        return new Promise(resolve => {
            const url = `${baseUrl}/stream/series/${imdbId}:${season}:${episode}.json`;
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 5000,
                onload: r => {
                    try { resolve(JSON.parse(r.responseText).streams || []); }
                    catch { resolve([]); }
                },
                onerror: () => resolve([]),
                ontimeout: () => resolve([])
            });
        });
    }

    function findBestStream(streams) {
        if (!streams || !streams.length) return null;

        const stream = streams.find(s => (s.url || s.externalUrl || '').startsWith('http'))
            || streams.find(s => s.infoHash);

        if (!stream) return null;

        let url = stream.url || stream.externalUrl;
        if (!url && stream.infoHash) {
            url = `magnet:?xt=urn:btih:${stream.infoHash}`;
            if (stream.sources) stream.sources.forEach(s => url += `&tr=${encodeURIComponent(s)}`);
        }

        let title = stream.description || stream.name || "";
        const lines = title.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const fileLine = lines.find(l => /\.(mkv|mp4|avi|mov|m4v|flv|webm|ts)$/i.test(l));
        if (fileLine) {
            title = fileLine;
        } else if (lines.length > 0) {
            title = lines.reduce((a, b) => a.length > b.length ? a : b);
        }

        title = title.replace(/^[^\w\[\(]+/, "").trim();

        return { url, title };
    }

    function sendToMPV(playlist, title) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${CONFIG.SERVER_URL}/play`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    playlist, // Array of {url, title}
                    contentTitle: title.imdbId
                }),
                onload: r => r.status === 200 ? resolve() : reject(new Error('Server error')),
                onerror: () => reject(new Error('Connection failed'))
            });
        });
    }

    async function syncProgressWithStremio(content) {
        try {
            const profile = JSON.parse(localStorage.getItem('profile') || '{}');
            const authKey = profile.auth?.key;
            if (!authKey) return notify('Sync: No authKey found');

            const libRecent = JSON.parse(localStorage.getItem('library_recent') || '{"items":{}}');
            let item = libRecent.items[content.imdbId];

            if (!item) {
                notify(`Sync: Item ${content.imdbId} not in local library, cannot sync.`);
                return;
            }

            const now = new Date().toISOString();
            const videoId = `${content.imdbId}:${content.season}:${content.episode}`;

            const watchedStr = `${content.imdbId}:0:${content.season}:${content.episode}:eJxjYBBgAAIAAFcAEQ==`;

            item.state = item.state || {};
            item.state.lastWatched = now;
            item.state.video_id = videoId;
            item.state.timesWatched = (item.state.timesWatched || 0) + 1;
            item.state.timeWatched = item.state.duration || 1500000;
            item.state.timeOffset = 1;
            item.state.flaggedWatched = 1;
            item.state.watched = watchedStr;
            item._mtime = now;

            notify(`Syncing progress for ${content.imdbId} (S${content.season}E${content.episode})...`);

            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: 'https://api.strem.io/api/datastorePut',
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({
                        authKey: authKey,
                        collection: 'libraryItem',
                        changes: [item]
                    }),
                    onload: (r) => {
                        if (r.status === 200) notify('Sync successful!', 'success');
                        else log('Sync failed:', r.status);
                        resolve();
                    },
                    onerror: (err) => {
                        log('Sync XHR Error:', err);
                        resolve();
                    }
                });
            });
        } catch (e) {
            log('Sync Exception:', e);
        }
    }

    function showToast(message, type = 'info') {
        const existing = document.getElementById('stremio-mpv-toast');
        if (existing) existing.remove();
        const color = type === 'error' ? '#ef4444' : (type === 'success' ? '#22c55e' : '#3b82f6');
        const toast = document.createElement('div');
        toast.id = 'stremio-mpv-toast';
        toast.style.cssText = `position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: ${color}; color: white; padding: 12px 24px; border-radius: 8px; font-size: 14px; z-index: 999999; box-shadow: 0 4px 15px rgba(0,0,0,0.3);`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function init() {
        const version = GM_info.script.version;
        notify(`v${version} initialized!`);

        const active = providers.filter(p => p.enabled && p.url).map(p => p.name);
        notify(`Active providers: ${active.length > 0 ? active.join(', ') : 'None'}`);
        const modeDesc = playlistMode === 'all' ? 'Playlist' : 'Episode Batch';
        notify(`Mode: ${modeDesc} | Extra: ${extraEpisodes}`);

        createFloatingButton();

        // Keyboard Shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key.toLowerCase() === mpvShortcut) {
                const hash = window.location.hash;
                if (hash.includes('/detail/')) {
                    handleMPVClick(e);
                }
            }
        });

        let lastHash = window.location.hash;
        setInterval(() => {
            if (window.location.hash !== lastHash) {
                lastHash = window.location.hash;
                log('URL changed:', lastHash.substring(0, 60) + '...');
                updateButtonInfo();
            }
        }, 500);
        new MutationObserver(() => {
            if (!document.getElementById('stremio-mpv-floating')) createFloatingButton();
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();
