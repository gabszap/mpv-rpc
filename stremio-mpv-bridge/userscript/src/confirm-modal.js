// Generic confirmation modal.

// ==================== CUSTOM CONFIRM MODAL ====================
export function showConfirmModal(title, message, onConfirm, confirmText = "Yes", cancelText = "Cancel") {
    if (document.getElementById("stremio-mpv-confirm")) return;

    const overlay = document.createElement("div");
    overlay.id = "stremio-mpv-confirm";

    overlay.innerHTML = `
        <style>
            #stremio-mpv-confirm {
                position: fixed; inset: 0; z-index: 100005;
                background: rgba(0, 0, 0, 0.4);
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                display: flex; align-items: center; justify-content: center;
                font-family: 'Roboto', sans-serif;
                opacity: 0; transition: opacity 0.2s ease;
                color-scheme: dark;
            }
            .mpv-confirm-content {
                background: rgba(15, 15, 15, 0.85);
                color: #eee;
                padding: 24px;
                border-radius: 20px;
                width: 320px; max-width: 90vw;
                border: 1px solid rgba(139, 92, 246, 0.3);
                box-shadow: 0 25px 50px rgba(0,0,0,0.6), 0 0 40px rgba(239, 68, 68, 0.15);
                display: flex; flex-direction: column; align-items: center; text-align: center;
                transform: scale(0.9); transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
            }
            #stremio-mpv-confirm.active { opacity: 1; }
            #stremio-mpv-confirm.active .mpv-confirm-content { transform: scale(1); }

            .mpv-confirm-icon { font-size: 32px; margin-bottom: 12px; }
            .mpv-confirm-title { font-size: 18px; font-weight: bold; margin-bottom: 8px; color: #fff; }
            .mpv-confirm-message { font-size: 14px; opacity: 0.8; margin-bottom: 24px; line-height: 1.4; }
            .mpv-confirm-actions { display: flex; gap: 12px; width: 100%; }

            .mpv-confirm-btn {
                flex: 1; padding: 10px; border-radius: 8px; cursor: pointer;
                border: none; font-weight: 600; font-size: 14px; transition: all 0.2s ease;
            }
            .mpv-confirm-cancel {
                background: rgba(255, 255, 255, 0.05); color: #aaa; border: 1px solid rgba(255,255,255,0.1);
            }
            .mpv-confirm-cancel:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
            .mpv-confirm-cancel:focus { outline: none; border-color: #8b5cf6; box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.3); }

            .mpv-confirm-yes {
                background: #ef4444; color: white; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
            }
            .mpv-confirm-yes:hover {
                background: #dc2626; transform: translateY(-1px); box-shadow: 0 6px 15px rgba(239, 68, 68, 0.4);
            }
            .mpv-confirm-yes:focus { outline: none; box-shadow: 0 0 0 2px #fff, 0 0 0 4px #ef4444; }
        </style>
        <div class="mpv-confirm-content">
            <div class="mpv-confirm-icon">⚠️</div>
            <div class="mpv-confirm-title">${title}</div>
            <div class="mpv-confirm-message">${message}</div>
            <div class="mpv-confirm-actions">
                <button class="mpv-confirm-btn mpv-confirm-cancel">${cancelText}</button>
                <button class="mpv-confirm-btn mpv-confirm-yes">${confirmText}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn = overlay.querySelector(".mpv-confirm-cancel");
    const yesBtn = overlay.querySelector(".mpv-confirm-yes");

    requestAnimationFrame(() => {
        overlay.classList.add("active");
        cancelBtn.focus();
    });

    const close = () => {
        overlay.classList.remove("active");
        document.removeEventListener("keydown", handleEscape);
        setTimeout(() => overlay.remove(), 200);
    };

    const handleEscape = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };

    document.addEventListener("keydown", handleEscape);

    cancelBtn.addEventListener("click", close);
    yesBtn.addEventListener("click", () => {
        onConfirm();
        close();
    });

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
    });
}
