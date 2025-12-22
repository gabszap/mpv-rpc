/**
 * Configuration for MPV Discord RPC
 */

export const config = {
    // Discord Application Client ID
    // Create at: https://discord.com/developers/applications
    clientId: "1450169544701378570",

    // MPV Named Pipe path (Windows)
    mpvPipePath: "\\\\.\\pipe\\mpv",

    // Update interval in milliseconds (this is the presence update rate)
    updateInterval: 1000,

    // MPV icon URL
    mpvIcon: "https://i.imgur.com/gGwczqt.png",

    // Settings (can be made configurable later)
    settings: {
        showCover: true,            // Show anime cover as large image
        privacyMode: false,         // Hide all media details
        hideIdling: false,          // Hide status when MPV is idle
        showTitleAsPresence: true,  // Use anime title as activity name instead of "MPV"
        preferredTitleLanguage: "none", // "english", "romaji", or "none" (use filename)
    },

    // Jikan API settings
    jikan: {
        baseUrl: "https://api.jikan.moe/v4",
        minRequestInterval: 500,  // 500ms between API requests
    },
};

export type Config = typeof config;
