// ==UserScript==
// @name         Stremio MPV Bridge
// @namespace    https://github.com/gabszap/mpv-rpc
// @version      1.7.3
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

    // Available providers organized by category
    const AVAILABLE_PROVIDERS = {
        providers: [
            { id: 'torrentio', name: 'Torrentio' },
            { id: 'comet', name: 'Comet' },
            { id: 'mediafusion', name: 'MediaFusion' },
            { id: 'sootio', name: 'Sootio' }
        ],
        debrid: [
            { id: 'torbox', name: 'Torbox' },
            { id: 'real-debrid', name: 'Real Debrid' },
            { id: 'debrid-link', name: 'Debrid Link' }
        ]
    };

    // Default active providers (only torrentio + custom)
    const DEFAULT_ACTIVE = [
        { id: 'torrentio', name: 'Torrentio', url: '', enabled: true },
        { id: 'custom', name: 'Custom', url: '', enabled: true }
    ];

    let extraEpisodes = GM_getValue('extraEpisodes', 2);
    let playlistMode = GM_getValue('playlistMode', 'batch');
    let mpvShortcut = GM_getValue('mpvShortcut', 'v');

    let storedProviders = GM_getValue('providers', []);
    let providers;

    if (storedProviders.length > 0) {
        providers = [...storedProviders];
    } else {
        providers = [...DEFAULT_ACTIVE];
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

        let providersHTML = providers.map((p, index) => {
            // Allow removing all providers except default torrentio and base custom
            const isRemovable = p.id !== 'torrentio' && p.id !== 'custom';
            return `
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
                        ${isRemovable ? '<button class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">×</button>' : ''}
                    </div>
                </div>
                <input type="text" data-id="${p.id}" class="mpv-input mpv-provider-input" 
                       placeholder="Paste manifest.json link here" value="${p.url}" 
                       style="${!p.enabled ? 'opacity: 0.5; pointer-events: none;' : ''}">
            </div>
        `}).join('');

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
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
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
                .mpv-btn-add { background: transparent; border: 1px dashed rgba(139, 92, 246, 0.5); color: #a78bfa; padding: 8px 16px; width: 100%; margin-bottom: 8px; position: relative; }
                .mpv-btn-add:hover { border-color: #8b5cf6; background: rgba(139, 92, 246, 0.1); }
                .mpv-btn-remove { background: transparent; border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; width: 24px; height: 24px; font-size: 14px; padding: 0; }
                .mpv-btn-remove:hover { background: rgba(239, 68, 68, 0.2); border-color: #ef4444; }
                .mpv-dropdown { position: relative; display: inline-block; width: 100%; margin-bottom: 8px; }
                .mpv-dropdown-content { 
                    display: none; position: fixed; 
                    top: 50%; left: 50%;
                    transform: translate(-50%, -50%);
                    opacity: 0;
                    background: rgba(15, 15, 20, 0.95); 
                    backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);
                    border: 1px solid rgba(139, 92, 246, 0.4);
                    border-radius: 16px; padding: 20px; z-index: 100002;
                    min-width: 320px; max-width: 400px;
                    box-shadow: 0 25px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08) inset, 0 0 60px rgba(139, 92, 246, 0.15);
                }
                .mpv-dropdown-content.show { display: block; animation: submenuPop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
                @keyframes submenuPop { from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
                .mpv-dropdown-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100001; display: none; }
                .mpv-dropdown-overlay.show { display: block; animation: overlayFade 0.2s ease; }
                @keyframes overlayFade { from { opacity: 0; } to { opacity: 1; } }
                .mpv-dropdown-title { font-size: 16px; font-weight: 600; color: #fff; text-align: center; margin-bottom: 12px; }
                .mpv-dropdown-category { 
                    padding: 10px 16px 6px; font-size: 10px; color: #a78bfa; 
                    text-transform: uppercase; letter-spacing: 1px; font-weight: 600;
                    margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 14px;
                }
                .mpv-dropdown-category:first-of-type { margin-top: 0; border-top: none; padding-top: 6px; }
                .mpv-dropdown-item { 
                    padding: 10px 16px; cursor: pointer; border-radius: 10px; transition: all 0.2s ease;
                    display: flex; align-items: center; justify-content: space-between; font-size: 14px; color: #eee;
                }
                .mpv-dropdown-item:hover { background: linear-gradient(90deg, rgba(139, 92, 246, 0.2), rgba(139, 92, 246, 0.05)); color: #fff; padding-left: 20px; }
                .mpv-dropdown-item.disabled { opacity: 0.4; cursor: not-allowed; text-decoration: line-through; }
                .mpv-radio {
                    appearance: none; -webkit-appearance: none;
                    width: 18px; height: 18px; border: 2px solid rgba(139, 92, 246, 0.4);
                    border-radius: 50%; outline: none; transition: all 0.2s ease;
                    position: relative; cursor: pointer; flex-shrink: 0;
                    margin: 0; 
                    display: flex; align-items: center; justify-content: center;
                    box-sizing: border-box;
                }
                .mpv-radio:checked { border-color: #8b5cf6; background: rgba(139, 92, 246, 0.2); }
                .mpv-radio:checked::after {
                    content: '';
                    width: 8px; height: 8px; border-radius: 50%; background: #8b5cf6;
                    box-shadow: 0 0 5px rgba(139, 92, 246, 0.5);
                    display: block;
                }
                .mpv-radio-option label { line-height: 1; }
            </style>
            <div class="mpv-modal-content">
                <div class="mpv-modal-header">MPV Bridge Settings <span style="font-size: 14px; opacity: 0.6; font-weight: normal; margin-left: 8px;">v${GM_info.script.version}</span></div>
                
                <div id="mpv-providers-container">
                    ${providersHTML}
                </div>
                
                <div class="mpv-dropdown">
                    <button class="mpv-btn mpv-btn-add" id="mpv-add-provider-btn">+ Add Provider</button>
                    <div class="mpv-dropdown-overlay" id="mpv-dropdown-overlay"></div>
                    <div class="mpv-dropdown-content" id="mpv-provider-dropdown">
                        <div class="mpv-dropdown-title">Select Provider</div>
                        <div class="mpv-dropdown-category">Providers</div>
                        ${AVAILABLE_PROVIDERS.providers.map(p => `<div class="mpv-dropdown-item" data-id="${p.id}" data-name="${p.name}">${p.name}</div>`).join('')}
                        <div class="mpv-dropdown-category">Debrid Services</div>
                        ${AVAILABLE_PROVIDERS.debrid.map(p => `<div class="mpv-dropdown-item" data-id="${p.id}" data-name="${p.name}">${p.name}</div>`).join('')}
                        <div style="margin-top: 16px; padding: 12px 16px; font-size: 12px; color: #666; text-align: center; border-top: 1px solid rgba(255,255,255,0.08);">
                            Missing your favorite debrid? <a href="https://github.com/gabszap/mpv-rpc/issues" target="_blank" style="color: #8b7bba; text-decoration: underline; font-size: 13px;">open an issue</a>
                        </div>
                    </div>
                </div>
                <button class="mpv-btn mpv-btn-add" id="mpv-add-custom">+ Add Custom</button>
                <div class="mpv-help" style="margin-bottom: 20px; color: #aaa;">Copy the link from the addon's "Share" button.</div>

                <div class="mpv-form-group">
                    <label class="mpv-label">Stream Mode</label>
                    
                    <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; margin-bottom: 8px; background: ${playlistMode === 'single' ? 'rgba(139, 92, 246, 0.12)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${playlistMode === 'single' ? 'rgba(139, 92, 246, 0.4)' : 'rgba(255,255,255,0.08)'}; transition: all 0.2s ease;">
                        <input type="radio" name="mpv-stream-mode" id="mpv-mode-single" value="single" class="mpv-radio" ${playlistMode === 'single' ? 'checked' : ''}>
                        <div style="pointer-events: none; flex: 1;">
                            <label for="mpv-mode-single" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Single Episode</label>
                            <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Load only the selected episode</div>
                        </div>
                    </div>
                    
                    <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; margin-bottom: 8px; background: ${playlistMode === 'batch' ? 'rgba(139, 92, 246, 0.12)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${playlistMode === 'batch' ? 'rgba(139, 92, 246, 0.4)' : 'rgba(255,255,255,0.08)'}; transition: all 0.2s ease;">
                        <input type="radio" name="mpv-stream-mode" id="mpv-mode-batch" value="batch" class="mpv-radio" ${playlistMode === 'batch' ? 'checked' : ''}>
                        <div style="pointer-events: none; flex: 1;">
                            <label for="mpv-mode-batch" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Batch Episodes</label>
                            <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Load selected + next episodes</div>
                        </div>
                    </div>
                    
                    <div id="mpv-group-count" style="margin-bottom: 15px; padding-left: 42px; ${playlistMode !== 'batch' ? 'display:none' : ''}">
                        <label class="mpv-label" style="font-size: 11px; color: #a78bfa; margin-bottom: 4px;">Next episodes to load</label>
                        <input type="number" id="mpv-ep-count" class="mpv-input" value="${extraEpisodes}" min="1" max="25" style="width: 70px; padding: 8px;">
                    </div>
                    
                    <div class="mpv-radio-option" style="display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; cursor: pointer; background: ${playlistMode === 'all' ? 'rgba(139, 92, 246, 0.12)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${playlistMode === 'all' ? 'rgba(139, 92, 246, 0.4)' : 'rgba(255,255,255,0.08)'}; transition: all 0.2s ease;">
                        <input type="radio" name="mpv-stream-mode" id="mpv-mode-all" value="all" class="mpv-radio" ${playlistMode === 'all' ? 'checked' : ''}>
                        <div style="pointer-events: none; flex: 1;">
                            <label for="mpv-mode-all" style="cursor:pointer; font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px;">Load All</label>
                            <div class="mpv-help" style="margin-top: 0; font-size: 12px; opacity: 0.6;">Loads all remaining episodes (may take a while)</div>
                        </div>
                    </div>
                </div>

                <div class="mpv-form-group">
                    <label class="mpv-label">Keyboard Shortcut</label>
                    <button type="button" id="mpv-shortcut-btn" class="mpv-input" style="width: 80px; text-align: center; text-transform: uppercase; font-weight: bold; cursor: pointer; border: 1px dashed rgba(139, 92, 246, 0.5);">${mpvShortcut.toUpperCase()}</button>
                    <input type="hidden" id="mpv-shortcut" value="${mpvShortcut}">
                    <div class="mpv-help" style="margin-top: 4px;">Click and press a key</div>
                </div>

                <div class="mpv-form-group" style="margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.1);">
                    <label class="mpv-label">Direct Link</label>
                    <div style="display: flex; gap: 8px;">
                        <input type="text" id="mpv-direct-link" class="mpv-input" placeholder="Paste stream URL here..." style="flex: 1;">
                        <button class="mpv-btn mpv-btn-save" id="mpv-open-link" style="padding: 10px 16px; white-space: nowrap;">▶ Open</button>
                    </div>
                    <div class="mpv-help" style="margin-top: 4px;">Open any URL directly in MPV</div>
                </div>

                <div class="mpv-actions">
                    <button class="mpv-btn mpv-btn-cancel" id="mpv-cancel">Cancel</button>
                    <button class="mpv-btn mpv-btn-save" id="mpv-save">Save</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        requestAnimationFrame(() => modal.classList.add('active'));

        const countGroup = modal.querySelector('#mpv-group-count');
        const radioButtons = modal.querySelectorAll('input[name="mpv-stream-mode"]');
        const radioOptions = modal.querySelectorAll('.mpv-radio-option');

        const updateRadioStyles = () => {
            radioOptions.forEach((option, index) => {
                const radio = option.querySelector('input[type="radio"]');
                if (radio.checked) {
                    option.style.background = 'rgba(139, 92, 246, 0.15)';
                    option.style.borderColor = 'rgba(139, 92, 246, 0.4)';
                } else {
                    option.style.background = 'transparent';
                    option.style.borderColor = 'rgba(255,255,255,0.08)';
                }
            });
            // Show count input only for batch mode
            const batchRadio = modal.querySelector('#mpv-mode-batch');
            countGroup.style.display = batchRadio.checked ? 'block' : 'none';
        };

        radioButtons.forEach(radio => {
            radio.addEventListener('change', updateRadioStyles);
        });

        radioOptions.forEach(option => {
            option.addEventListener('click', () => {
                const radio = option.querySelector('input[type="radio"]');
                radio.checked = true;
                updateRadioStyles();
            });
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

        // Direct Link functionality
        modal.querySelector('#mpv-open-link').addEventListener('click', async () => {
            const linkInput = modal.querySelector('#mpv-direct-link');
            const url = linkInput?.value?.trim();

            if (!url) {
                showToast('Please paste a URL first', 'error');
                return;
            }

            // Block URLs with URL-encoded characters (broken links)
            if (/%[0-9A-Fa-f]{2}/.test(url)) {
                showToast('URL contains encoded characters - please use a clean URL', 'error');
                return;
            }

            // Extract title from URL
            let title;
            try {
                const urlObj = new URL(url);
                const pathname = urlObj.pathname;
                // Get filename from path
                const filename = pathname.split('/').pop() || '';
                // Remove extension and clean up (replace . _ - with spaces)
                title = filename.replace(/\.[^.]+$/, '').replace(/[._-]/g, ' ').trim();
                if (!title || title.length < 3) {
                    title = urlObj.hostname; // Fallback to hostname
                }
            } catch {
                title = 'Direct Link';
            }

            try {
                if (!(await checkServer())) {
                    showToast('Server offline! Run: node stremio-mpv-bridge/server.js', 'error');
                    return;
                }

                const openBtn = modal.querySelector('#mpv-open-link');
                openBtn.textContent = '⏳';
                openBtn.disabled = true;

                await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: `${CONFIG.SERVER_URL}/play`,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({
                            playlist: [{ url, title }],
                            contentTitle: title
                        }),
                        onload: r => r.status === 200 ? resolve() : reject(new Error('Server error')),
                        onerror: () => reject(new Error('Connection failed'))
                    });
                });

                showToast('Opening in MPV...', 'success');
                linkInput.value = '';
                openBtn.textContent = '▶ Open';
                openBtn.disabled = false;
            } catch (err) {
                showToast(`Failed: ${err.message}`, 'error');
                const openBtn = modal.querySelector('#mpv-open-link');
                openBtn.textContent = '▶ Open';
                openBtn.disabled = false;
            }
        });

        // Keyboard shortcut capture
        const shortcutBtn = modal.querySelector('#mpv-shortcut-btn');
        const shortcutInput = modal.querySelector('#mpv-shortcut');
        let capturingShortcut = false;

        shortcutBtn.addEventListener('click', () => {
            capturingShortcut = true;
            shortcutBtn.textContent = '...';
            shortcutBtn.style.borderColor = '#8b5cf6';
            shortcutBtn.style.animation = 'pulse 1s infinite';
        });

        document.addEventListener('keydown', (e) => {
            if (!capturingShortcut) return;
            e.preventDefault();
            e.stopPropagation();

            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            shortcutInput.value = key;
            shortcutBtn.textContent = key.toUpperCase();
            shortcutBtn.style.borderColor = 'rgba(139, 92, 246, 0.5)';
            shortcutBtn.style.animation = '';
            capturingShortcut = false;
        }, true);

        modal.querySelectorAll('.mpv-provider-toggle').forEach(toggle => {
            toggle.addEventListener('change', (e) => {
                const input = modal.querySelector(`.mpv-provider-input[data-id="${e.target.dataset.id}"]`);
                if (input) {
                    input.style.opacity = e.target.checked ? '1' : '0.5';
                    input.style.pointerEvents = e.target.checked ? 'auto' : 'none';
                }
            });
        });

        // Add Provider dropdown
        const addProviderBtn = modal.querySelector('#mpv-add-provider-btn');
        const providerDropdown = modal.querySelector('#mpv-provider-dropdown');
        const dropdownOverlay = modal.querySelector('#mpv-dropdown-overlay');

        if (addProviderBtn && providerDropdown) {
            const showDropdown = () => {
                // Update disabled state for already added providers
                const container = modal.querySelector('#mpv-providers-container');
                providerDropdown.querySelectorAll('.mpv-dropdown-item').forEach(item => {
                    const exists = container.querySelector(`[data-id="${item.dataset.id}"]`);
                    item.classList.toggle('disabled', !!exists);
                });
                providerDropdown.classList.add('show');
                dropdownOverlay?.classList.add('show');
            };

            const hideDropdown = () => {
                providerDropdown.classList.remove('show');
                dropdownOverlay?.classList.remove('show');
            };

            addProviderBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (providerDropdown.classList.contains('show')) {
                    hideDropdown();
                } else {
                    showDropdown();
                }
            });

            dropdownOverlay?.addEventListener('click', hideDropdown);
        }

        providerDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.mpv-dropdown-item');
            if (!item || item.classList.contains('disabled')) return;

            const id = item.dataset.id;
            const name = item.dataset.name;
            const container = modal.querySelector('#mpv-providers-container');

            const newProviderHTML = `
                <div class="mpv-form-group mpv-provider-item" data-id="${id}">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" data-id="${id}" class="mpv-provider-toggle" checked 
                                   style="width: 16px; height: 16px; min-width: 16px; min-height: 16px; cursor: pointer; accent-color: #8b5cf6; appearance: auto; -webkit-appearance: checkbox; margin: 0;">
                            <label class="mpv-label" style="margin: 0; cursor: pointer;">${name}</label>
                        </div>
                        <div style="display: flex; gap: 4px;">
                            <button class="mpv-reorder-btn" onclick="const item = this.closest('.mpv-provider-item'); if(item.previousElementSibling?.classList.contains('mpv-provider-item')) item.parentNode.insertBefore(item, item.previousElementSibling)" title="Move Up">▲</button>
                            <button class="mpv-reorder-btn" onclick="const item = this.closest('.mpv-provider-item'); if(item.nextElementSibling?.classList.contains('mpv-provider-item')) item.parentNode.insertBefore(item.nextElementSibling, item)" title="Move Down">▼</button>
                            <button class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">×</button>
                        </div>
                    </div>
                    <input type="text" data-id="${id}" class="mpv-input mpv-provider-input" placeholder="Paste manifest.json link here" value="">
                </div>
            `;

            // Insert before custom providers
            const firstCustom = container.querySelector('[data-id^="custom"]');
            if (firstCustom) {
                firstCustom.insertAdjacentHTML('beforebegin', newProviderHTML);
            } else {
                container.insertAdjacentHTML('beforeend', newProviderHTML);
            }

            providerDropdown.classList.remove('show');
            dropdownOverlay?.classList.remove('show');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.mpv-dropdown')) {
                providerDropdown.classList.remove('show');
            }
        });

        // Add Custom Provider button
        modal.querySelector('#mpv-add-custom').addEventListener('click', () => {
            const container = modal.querySelector('#mpv-providers-container');
            const existingCustoms = container.querySelectorAll('[data-id^="custom"]');
            // Find the highest existing custom number
            let maxNum = 0;
            existingCustoms.forEach(el => {
                const num = parseInt(el.dataset.id.replace('custom', '')) || 0;
                if (num > maxNum) maxNum = num;
            });
            const newNum = maxNum + 1;
            const newId = `custom${newNum}`;

            const newProviderHTML = `
                <div class="mpv-form-group mpv-provider-item" data-id="${newId}">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" data-id="${newId}" class="mpv-provider-toggle" checked 
                                   style="width: 16px; height: 16px; min-width: 16px; min-height: 16px; cursor: pointer; accent-color: #8b5cf6; appearance: auto; -webkit-appearance: checkbox; margin: 0;">
                            <label class="mpv-label" style="margin: 0; cursor: pointer;">Custom ${newNum}</label>
                        </div>
                        <div style="display: flex; gap: 4px;">
                            <button class="mpv-reorder-btn" onclick="const item = this.closest('.mpv-provider-item'); if(item.previousElementSibling?.classList.contains('mpv-provider-item')) item.parentNode.insertBefore(item, item.previousElementSibling)" title="Move Up">▲</button>
                            <button class="mpv-reorder-btn" onclick="const item = this.closest('.mpv-provider-item'); if(item.nextElementSibling?.classList.contains('mpv-provider-item')) item.parentNode.insertBefore(item.nextElementSibling, item)" title="Move Down">▼</button>
                            <button class="mpv-btn mpv-btn-remove mpv-remove-provider" title="Remove">×</button>
                        </div>
                    </div>
                    <input type="text" data-id="${newId}" class="mpv-input mpv-provider-input" placeholder="Paste manifest.json link here" value="">
                </div>
            `;
            container.insertAdjacentHTML('beforeend', newProviderHTML);

            // Add toggle listener to new provider
            const newToggle = container.querySelector(`[data-id="${newId}"].mpv-provider-toggle`);
            newToggle?.addEventListener('change', (e) => {
                const input = container.querySelector(`.mpv-provider-input[data-id="${e.target.dataset.id}"]`);
                if (input) {
                    input.style.opacity = e.target.checked ? '1' : '0.5';
                    input.style.pointerEvents = e.target.checked ? 'auto' : 'none';
                }
            });
        });

        // Remove provider buttons (delegated)
        modal.addEventListener('click', (e) => {
            if (e.target.classList.contains('mpv-remove-provider')) {
                const item = e.target.closest('.mpv-provider-item');
                if (item) item.remove();
            }
            if (e.target === modal) closeModal();
        });
    }

    function saveConfig() {
        const modal = document.getElementById('stremio-mpv-modal');
        const countInput = modal.querySelector('#mpv-ep-count');
        const selectedMode = modal.querySelector('input[name="mpv-stream-mode"]:checked');
        const shortcutInput = modal.querySelector('#mpv-shortcut');

        const providerItems = Array.from(modal.querySelectorAll('.mpv-provider-item'));

        providers = providerItems.map(item => {
            const id = item.dataset.id;
            const input = item.querySelector('.mpv-provider-input');
            const toggle = item.querySelector('.mpv-provider-toggle');
            const label = item.querySelector('.mpv-label');
            let url = input ? input.value.trim() : '';
            if (url && url.includes('/manifest.json')) {
                url = url.split('/manifest.json')[0];
            }
            const allProviders = [...AVAILABLE_PROVIDERS.providers, ...AVAILABLE_PROVIDERS.debrid];
            const knownProvider = allProviders.find(d => d.id === id);
            return {
                id: id,
                name: knownProvider ? knownProvider.name : (label?.textContent || id),
                url: url,
                enabled: toggle ? toggle.checked : true
            };
        });

        GM_setValue('providers', providers);

        extraEpisodes = Math.max(1, Math.min(25, parseInt(countInput.value) || 2));
        GM_setValue('extraEpisodes', extraEpisodes);

        playlistMode = selectedMode ? selectedMode.value : 'batch';
        GM_setValue('playlistMode', playlistMode);

        mpvShortcut = (shortcutInput.value || 'v').toLowerCase();
        GM_setValue('mpvShortcut', mpvShortcut);

        showToast('Settings saved!', 'success');
    }

    // ==================== UI SCRAPER ====================
    function scrapeMetadata() {
        const metadata = {
            seriesName: null,
            episodeTitle: null,
            season: null,
            episode: null
        };

        try {
            const headerEl = document.querySelector('div[class*="episode-title"]');
            if (headerEl && headerEl.innerText) {
                const seMatch = headerEl.innerText.match(/S(\d+)E(\d+)/i);
                if (seMatch) {
                    metadata.season = parseInt(seMatch[1]);
                    metadata.episode = parseInt(seMatch[2]);
                    log(`Scraped from header: S${metadata.season}E${metadata.episode}`);
                }

                const titlePart = headerEl.innerText.replace(/S\d+E\d+/i, '').trim();
                if (titlePart.length > 2) {
                    metadata.episodeTitle = titlePart;
                }
            }

            const titleEl = document.querySelector('[class*="title-label"]');
            if (titleEl && titleEl.innerText) {
                metadata.seriesName = titleEl.innerText.trim();
            } else {
                const logoEl = document.querySelector('img[class*="logo"]');
                if (logoEl && logoEl.title) {
                    metadata.seriesName = logoEl.title.trim();
                } else if (logoEl && logoEl.alt) {
                    metadata.seriesName = logoEl.alt.trim();
                }
            }

            if (!metadata.season) {
                const allMultiselects = document.querySelectorAll('[class*="multiselect-button"]');
                for (const el of allMultiselects) {
                    if (el.innerText && el.innerText.includes('Season')) {
                        const match = el.innerText.match(/Season\s*(\d+)/i);
                        if (match) {
                            metadata.season = parseInt(match[1]);
                            break;
                        }
                    }
                }
            }

            if (!metadata.season) {
                const urlMatch = window.location.hash.match(/season=(\d+)/i);
                if (urlMatch) metadata.season = parseInt(urlMatch[1]);
            }
        } catch (e) {
            log('Scraper error:', e);
        }

        return metadata;
    }

    // ==================== URL PARSER ====================
    function parseCurrentURL() {
        const hash = window.location.hash;
        log('Parsing URL:', hash.substring(0, 80) + '...');

        if (hash.includes('/player/') && lastValidContent && lastValidContent.episode) {
            log('Using saved content (player mode):', lastValidContent);
            return lastValidContent;
        }

        const uiMeta = scrapeMetadata();
        const decodedHash = decodeURIComponent(hash);

        let seriesId = null;
        const seriesMatch = decodedHash.match(/\/detail\/(?:series|movie)\/([^\/]+)/);
        if (seriesMatch) {
            seriesId = seriesMatch[1];
            log('Extracted seriesId:', seriesId);
        }

        const imdbMatch = decodedHash.match(/(tt\d+):(\d+):(\d+)/);
        if (imdbMatch) {
            const result = {
                type: 'series',
                imdbId: imdbMatch[1],
                seriesId: seriesId || imdbMatch[1],
                name: uiMeta.seriesName,
                season: parseInt(imdbMatch[2]),
                episode: parseInt(imdbMatch[3])
            };
            log('IMDb content found:', result);
            lastValidContent = result;
            return result;
        }

        const kitsuMatch = decodedHash.match(/kitsu[:%]3A(\d+)[:%]3A(\d+)/i) || decodedHash.match(/kitsu:(\d+):(\d+)/i);
        if (kitsuMatch) {
            const result = {
                type: 'series',
                imdbId: `kitsu:${kitsuMatch[1]}`,
                seriesId: seriesId || `kitsu:${kitsuMatch[1]}`,
                name: uiMeta.seriesName,
                episodeTitle: uiMeta.episodeTitle,
                season: uiMeta.season || 1,
                episode: uiMeta.episode || parseInt(kitsuMatch[2])
            };
            log('Kitsu content found:', result);
            lastValidContent = result;
            return result;
        }

        const genericMatch = decodedHash.match(/(\w+)[:%]3A(\d+)[:%]3A(\d+)[:%]3A(\d+)/i) ||
            decodedHash.match(/(\w+):(\d+):(\d+):(\d+)/i);
        if (genericMatch) {
            const result = {
                type: 'series',
                imdbId: `${genericMatch[1]}:${genericMatch[2]}`,
                seriesId: seriesId || `${genericMatch[1]}:${genericMatch[2]}`,
                name: uiMeta.seriesName,
                season: parseInt(genericMatch[3]),
                episode: parseInt(genericMatch[4])
            };
            log('Generic content found:', result);
            lastValidContent = result;
            return result;
        }

        const imdbIdMatch = decodedHash.match(/(tt\d+)/);
        if (imdbIdMatch) {
            return {
                type: 'series',
                imdbId: imdbIdMatch[1],
                seriesId: seriesId || imdbIdMatch[1],
                name: uiMeta.seriesName,
                season: parseInt(decodedHash.match(/season=(\d+)/)?.[1]) || uiMeta.season || null,
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

            const limit = playlistMode === 'all' ? 50 : (playlistMode === 'single' ? 0 : extraEpisodes);
            const modeText = playlistMode === 'all' ? 'Load All' : (playlistMode === 'single' ? 'Single' : `Batch | Extra: ${extraEpisodes}`);
            notify(`Mode: ${modeText}`, 'info');

            const playlist = await collectStreams(content, limit);

            if (playlist.length === 0) {
                showToast('No streams found', 'error');
                return;
            }

            await sendToMPV(playlist, content);
            showToast(`Opening ${playlist.length} item(s) in MPV`, 'success');

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
                    return {
                        ...streamItem,
                        imdbId: content.imdbId,
                        season: season,
                        episode: ep,
                        type: content.type
                    };
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

    async function fetchStreams(baseUrl, id, season, episode) {
        return new Promise(resolve => {
            const isKitsu = id.startsWith('kitsu:');
            const url = isKitsu
                ? `${baseUrl}/stream/series/${id}:${episode}.json`
                : `${baseUrl}/stream/series/${id}:${season}:${episode}.json`;

            log(`Fetching streams from: ${url}`);

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

        let title = stream.title || stream.description || stream.name || "";
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
            const profile = JSON.parse(localStorage.getItem('profile') || '{}');
            const authKey = profile.auth?.key;

            log(`Bridge: Sending payload with authKey: ${authKey ? 'Found' : 'MISSING'} | seriesId: ${title.seriesId} | imdbId: ${title.imdbId}`);

            GM_xmlhttpRequest({
                method: 'POST',
                url: `${CONFIG.SERVER_URL}/play`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    playlist,
                    contentTitle: title.imdbId,
                    stremioAuth: authKey,
                    stremioContext: {
                        seriesId: title.seriesId,
                        imdbId: title.imdbId,
                        name: title.name,
                        episodeTitle: title.episodeTitle,
                        season: title.season,
                        episode: title.episode,
                        type: title.type
                    }
                }),
                onload: r => r.status === 200 ? resolve() : reject(new Error('Server error')),
                onerror: () => reject(new Error('Connection failed'))
            });
        });
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

        const modeText = playlistMode === 'all' ? 'Load All' : (playlistMode === 'single' ? 'Single' : `Batch | Extra: ${extraEpisodes}`);
        notify(`Mode: ${modeText}`);

        createFloatingButton();

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
