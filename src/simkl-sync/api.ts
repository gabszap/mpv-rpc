import axios, { type AxiosResponse } from "axios";
import { getAccessToken, logSimklRequest } from "./auth";
import { SimklApiError, type SimklEvent } from "./types";

export async function sendScrobble(event: SimklEvent): Promise<void> {
    if (
        !Number.isFinite(event.progress) ||
        event.progress < 0 ||
        event.progress > 100 ||
        !Number.isInteger(event.threshold) ||
        event.threshold < 50 ||
        event.threshold > 100
    ) {
        throw new SimklApiError("invalid");
    }
    let token = await getAccessToken(event.clientId, event.sessionKey);
    const endpoint = `/scrobble/${event.action}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!token) throw new SimklApiError("auth");
        let response: AxiosResponse<{ action?: string; error?: string }>;
        try {
            response = await axios.post(
                `https://api.simkl.com${endpoint}`,
                {
                    ...event.payload,
                    progress: Math.round(event.progress * 100) / 100,
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                        "User-Agent": "mpv-rpc",
                    },
                    params: {
                        client_id: event.clientId,
                        "app-name": "mpv-rpc",
                        ...(event.action !== "pause" ? { min_progress: event.threshold } : {}),
                    },
                    timeout: 6000,
                    validateStatus: () => true,
                },
            );
        } catch {
            logSimklRequest(endpoint, "NETWORK_ERROR");
            throw new SimklApiError("transient", 20000);
        }
        const responseMedia = response.data as {
            show?: { ids?: { simkl?: unknown } };
            movie?: { ids?: { simkl?: unknown } };
            anime?: { ids?: { simkl?: unknown } };
        } | null;
        const simklId = (responseMedia?.show ?? responseMedia?.movie ?? responseMedia?.anime)?.ids?.simkl;
        logSimklRequest(
            endpoint,
            response.status,
            JSON.stringify({
                request: event.payload,
                progress: event.progress,
                reason: event.reason,
                action: typeof response.data?.action === "string" ? response.data.action : undefined,
                simkl: typeof simklId === "number" || typeof simklId === "string" ? simklId : undefined,
            }),
        );
        const { status, data } = response;
        if (status >= 200 && status < 300) {
            const expected =
                event.action === "stop" ? [event.progress >= event.threshold ? "scrobble" : "pause"] : [event.action];
            if (!data?.action || !expected.includes(data.action)) throw new SimklApiError("invalid");
            return;
        }
        if (status === 409 && event.action === "stop") return;
        if (status === 401 && attempt === 0) {
            token = await getAccessToken(event.clientId, event.sessionKey, token);
            continue;
        }
        if (status === 401) throw new SimklApiError("auth");
        if (status === 403) throw new SimklApiError("scope");
        if (status === 404) throw new SimklApiError("not-found");
        if (status === 429 || (status === 400 && JSON.stringify(data).includes("RATE_LIMIT")) || status >= 500) {
            const raw = response.headers?.["retry-after"];
            const seconds = Number(raw);
            const retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(raw)) - Date.now();
            throw new SimklApiError("transient", Math.max(20000, Number.isFinite(retryAfter) ? retryAfter : 0));
        }
        throw new SimklApiError("invalid");
    }
}
