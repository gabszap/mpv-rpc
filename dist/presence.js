import { ActivityType, Assets } from "premid";
const presence = new Presence({
    clientId: "1450169544701378570",
});
const MPV_ICON = "https://i.imgur.com/gGwczqt.png";
presence.on("UpdateData", async () => {
    // Load settings
    const [showCover, usePresenceName, privacyMode, hideIdling] = await Promise.all([
        presence.getSetting("showCover"),
        presence.getSetting("usePresenceName"),
        presence.getSetting("privacy"),
        presence.getSetting("hideIdling"),
    ]);
    const dataElement = document.querySelector("#premid-data");
    // If no data element or page not loaded, clear activity
    if (!dataElement) {
        presence.clearActivity();
        return;
    }
    let data;
    try {
        data = JSON.parse(dataElement.textContent || "{}");
    }
    catch (e) {
        console.error("Failed to parse MPV data", e);
        presence.clearActivity();
        return;
    }
    // Check for error state (MPV not connected)
    if (!data || data.error) {
        presence.clearActivity();
        return;
    }
    // Check for N/A or undefined values that indicate no media playing (but MPV is connected)
    if (data.media_title === "N/A" || data.filename === "N/A" || !data.filename) {
        // If hideIdling is enabled, don't show any status when idle
        if (hideIdling) {
            presence.clearActivity();
            return;
        }
        // Show "Idling" status when MPV is connected but no media
        presence.setActivity({
            type: ActivityType.Playing,
            details: "Idling...",
            state: "No media playing",
            largeImageKey: MPV_ICON,
            largeImageText: "MPV Media Player",
        });
        return;
    }
    // Privacy Mode: Hide all details
    if (privacyMode) {
        presence.setActivity({
            type: ActivityType.Playing,
            details: "Watching something",
            largeImageKey: MPV_ICON,
            largeImageText: "MPV Media Player",
        });
        return;
    }
    const isPaused = data.pause;
    const title = data.series_title !== "N/A" ? data.series_title : data.media_title;
    let state = "";
    if (data.season !== null && data.episode !== null) {
        // Discord shows SxEy badge automatically via largeImageText, so just show episode title
        state = data.episode_title || "";
    }
    else if (data.episode !== null) {
        // No season info, show episode number manually
        state = `Episode ${data.episode}`;
        if (data.episode_title) {
            state += ` - ${data.episode_title}`;
        }
    }
    else if (data.artist !== "N/A") {
        state = `by ${data.artist}`;
    }
    else {
        state = isPaused ? "Paused" : `Playing - ${data.percent_pos.toFixed(1)}%`;
    }
    // Determine image based on showCover setting
    const largeImage = showCover && data.cover_image ? data.cover_image : MPV_ICON;
    // Format for Discord to auto-detect SxEy badge: "Season X, Episode Y"
    let largeText = "";
    if (showCover && data.cover_image && data.season !== null && data.episode !== null) {
        largeText = `Season ${data.season}, Episode ${data.episode}`;
    }
    else {
        largeText = "MPV Media Player";
    }
    presence.setActivity({
        type: ActivityType.Watching,
        // When usePresenceName is active, show title as presence name and episode title as details
        ...(usePresenceName && {
            name: title,
            details: data.episode_title || title,
            state: "",
        }),
        // When usePresenceName is off, show title in details
        ...(!usePresenceName && {
            details: title,
            state: state,
        }),
        startTimestamp: isPaused ? undefined : Date.now() - (data.time_pos * 1000),
        endTimestamp: isPaused ? undefined : Date.now() + ((data.duration - data.time_pos) * 1000),
        largeImageKey: largeImage,
        largeImageText: largeText,
        smallImageKey: isPaused ? Assets.Pause : Assets.Play,
        smallImageText: isPaused ? "Paused" : "Watching",
    });
});
