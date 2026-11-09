import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import axios from "axios";
import { config } from "../core/config";

interface Tokens {
    access_token: string;
    refresh_token: string;
    scope: string;
    client_id: string;
    session_key: string;
    expires_at: number;
    refresh_expires_at: number;
}

const refreshes = new Map<string, Promise<string | null>>();
const tokenFile = (): string => path.join(process.cwd(), ".config", ".simkl_tokens.json");

export function logSimklRequest(endpoint: string, status: number | string): void {
    try {
        const dir = path.join(process.cwd(), ".anime_cache");
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
            path.join(dir, "api_log.txt"),
            `${new Date().toISOString()} [Simkl] POST ${endpoint} ${status}\n`,
        );
    } catch {
        // Logging must never interrupt playback or authentication.
    }
}

function readTokens(): Tokens | null {
    try {
        const t = JSON.parse(fs.readFileSync(tokenFile(), "utf8")) as Tokens;
        return t.access_token &&
            t.refresh_token &&
            t.client_id &&
            t.session_key &&
            t.scope?.split(" ").includes("media:write") &&
            Number.isFinite(t.expires_at) &&
            Number.isFinite(t.refresh_expires_at)
            ? t
            : null;
    } catch {
        return null;
    }
}

function storeTokens(tokens: Tokens): void {
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(tokens, null, 4), { mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

async function request(endpoint: string, form: Record<string, string>, timeout = 6000) {
    try {
        const result = await axios.post(`https://api.simkl.com${endpoint}`, new URLSearchParams(form).toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "mpv-rpc" },
            timeout,
            validateStatus: () => true,
        });
        logSimklRequest(endpoint, result.status);
        return result;
    } catch {
        logSimklRequest(endpoint, "NETWORK_ERROR");
        return null;
    }
}

function fromResponse(data: Record<string, unknown>, clientId: string, sessionKey: string): Tokens | null {
    if (
        typeof data.access_token !== "string" ||
        typeof data.refresh_token !== "string" ||
        typeof data.scope !== "string" ||
        !data.scope.split(" ").includes("media:write") ||
        typeof data.expires_in !== "number" ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
    )
        return null;
    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        scope: data.scope,
        client_id: clientId,
        session_key: sessionKey,
        expires_at: Date.now() + data.expires_in * 1000,
        refresh_expires_at: Date.now() + 180 * 86400000,
    };
}

export function getAuthSession(): { clientId: string; sessionKey: string } | null {
    const t = readTokens();
    return t && t.client_id === config.simkl.clientId && t.refresh_expires_at > Date.now()
        ? { clientId: t.client_id, sessionKey: t.session_key }
        : null;
}

export function isAuthenticated(): boolean {
    return getAuthSession() !== null;
}

export async function authorize(): Promise<boolean> {
    const clientId = config.simkl.clientId;
    if (!clientId) {
        console.error("[Simkl] Set SIMKL_CLIENT_ID to an OAuth V2 application client ID first.");
        return false;
    }
    const response = await request("/oauth2/device", { client_id: clientId, scope: "media:read media:write" });
    if (response?.status !== 200) return false;
    const d = response.data;
    if (
        typeof d.device_code !== "string" ||
        typeof d.verification_uri !== "string" ||
        !Number.isFinite(d.expires_in) ||
        d.expires_in <= 0
    )
        return false;
    console.log(`[Simkl] Open ${d.verification_uri_complete || d.verification_uri} and enter ${d.user_code}`);
    const deadline = Date.now() + d.expires_in * 1000;
    let interval = Number.isFinite(d.interval) && d.interval > 0 ? d.interval * 1000 : 5000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
        if (Date.now() >= deadline) break;
        const poll = await request(
            "/oauth2/token",
            {
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                client_id: clientId,
                device_code: d.device_code,
            },
            Math.min(6000, deadline - Date.now()),
        );
        if (poll?.status === 200) {
            const tokens = fromResponse(poll.data, clientId, randomUUID());
            if (!tokens) return false;
            storeTokens(tokens);
            console.log("[Simkl] Authorized.");
            return true;
        }
        if (!poll || poll.status >= 500) continue;
        if (poll.data?.error === "slow_down") interval += 5000;
        else if (poll.data?.error !== "authorization_pending") return false;
    }
    console.error("[Simkl] Authorization expired. Run simkl-auth again.");
    return false;
}

export async function getAccessToken(
    clientId: string,
    sessionKey: string,
    rejectedToken?: string,
): Promise<string | null> {
    const tokens = readTokens();
    if (
        !tokens ||
        tokens.client_id !== clientId ||
        tokens.session_key !== sessionKey ||
        tokens.refresh_expires_at <= Date.now()
    )
        return null;
    if (tokens.expires_at > Date.now() + 60000 && tokens.access_token !== rejectedToken) return tokens.access_token;
    const key = `${tokenFile()}:${clientId}:${sessionKey}`;
    const existing = refreshes.get(key);
    if (existing) return existing;
    const pending = (async (): Promise<string | null> => {
        const result = await request("/oauth2/token", {
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: tokens.refresh_token,
        });
        const current = readTokens();
        if (!current || current.session_key !== sessionKey || current.client_id !== clientId) return null;
        if (current.access_token !== tokens.access_token) return current.access_token;
        if (result?.status === 400 && result.data?.error === "invalid_grant") {
            fs.rmSync(tokenFile(), { force: true });
            return null;
        }
        if (result?.status !== 200) return null;
        const updated = fromResponse(result.data, clientId, sessionKey);
        if (!updated) return null;
        storeTokens(updated);
        return updated.access_token;
    })();
    refreshes.set(key, pending);
    try {
        return await pending;
    } finally {
        refreshes.delete(key);
    }
}
