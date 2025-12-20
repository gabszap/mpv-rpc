export * from './functions/getTimestamps.js';
export * from './functions/getTimestampsFromMedia.js';
export * from './functions/timestampFromFormat.js';
/**
 * Status display types for Rich Presence
 * @since 2.8.0
 */
export var StatusDisplayType;
(function (StatusDisplayType) {
    /** Display the activity name - e.g. "Listening to Spotify" */
    StatusDisplayType[StatusDisplayType["Name"] = 0] = "Name";
    /** Display the state field - e.g. "Listening to Rick Astley" */
    StatusDisplayType[StatusDisplayType["State"] = 1] = "State";
    /** Display the details field - e.g. "Listening to Never Gonna Give You Up" */
    StatusDisplayType[StatusDisplayType["Details"] = 2] = "Details";
})(StatusDisplayType || (StatusDisplayType = {}));
export var ActivityType;
(function (ActivityType) {
    /**
     * Playing {name}
     */
    ActivityType[ActivityType["Playing"] = 0] = "Playing";
    /**
     * Streaming {name}
     */
    ActivityType[ActivityType["Streaming"] = 1] = "Streaming";
    /**
     * Listening to {name}
     */
    ActivityType[ActivityType["Listening"] = 2] = "Listening";
    /**
     * Watching {name}
     */
    ActivityType[ActivityType["Watching"] = 3] = "Watching";
    /**
     * Competing in {name}
     */
    ActivityType[ActivityType["Competing"] = 5] = "Competing";
})(ActivityType || (ActivityType = {}));
export var Assets;
(function (Assets) {
    Assets["Play"] = "https://cdn.rcd.gg/PreMiD/resources/play.png";
    Assets["Pause"] = "https://cdn.rcd.gg/PreMiD/resources/pause.png";
    Assets["Stop"] = "https://cdn.rcd.gg/PreMiD/resources/stop.png";
    Assets["Search"] = "https://cdn.rcd.gg/PreMiD/resources/search.png";
    Assets["Question"] = "https://cdn.rcd.gg/PreMiD/resources/question.png";
    Assets["Live"] = "https://cdn.rcd.gg/PreMiD/resources/live.png";
    Assets["Reading"] = "https://cdn.rcd.gg/PreMiD/resources/reading.png";
    Assets["Writing"] = "https://cdn.rcd.gg/PreMiD/resources/writing.png";
    Assets["Call"] = "https://cdn.rcd.gg/PreMiD/resources/call.png";
    Assets["VideoCall"] = "https://cdn.rcd.gg/PreMiD/resources/video-call.png";
    Assets["Downloading"] = "https://cdn.rcd.gg/PreMiD/resources/downloading.png";
    Assets["Uploading"] = "https://cdn.rcd.gg/PreMiD/resources/uploading.png";
    Assets["Repeat"] = "https://cdn.rcd.gg/PreMiD/resources/repeat.png";
    Assets["RepeatOne"] = "https://cdn.rcd.gg/PreMiD/resources/repeat-one.png";
    Assets["Premiere"] = "https://cdn.rcd.gg/PreMiD/resources/premiere.png";
    Assets["PremiereLive"] = "https://cdn.rcd.gg/PreMiD/resources/premiere-live.png";
    Assets["Viewing"] = "https://cdn.rcd.gg/PreMiD/resources/viewing.png";
})(Assets || (Assets = {}));
