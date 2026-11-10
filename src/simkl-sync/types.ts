export interface SimklIds {
    mal?: string;
    anilist?: string;
    kitsu?: string;
    imdb?: string;
    tmdb?: string;
    tvdb?: string;
}

export interface SimklMedia {
    ids: SimklIds;
    title?: string;
    year?: number;
}

export interface SimklPayload {
    movie?: SimklMedia;
    show?: SimklMedia;
    anime?: SimklMedia;
    episode?: { season?: number; number: number };
}

export interface SimklEvent {
    action: "start" | "pause" | "stop";
    payload: SimklPayload;
    progress: number;
    threshold: number;
    clientId: string;
    sessionKey: string;
}

export class SimklApiError extends Error {
    constructor(
        readonly kind: "auth" | "scope" | "transient" | "invalid" | "not-found",
        readonly retryAfterMs = 0,
    ) {
        super(`Simkl ${kind}`);
        this.name = "SimklApiError";
    }
}
