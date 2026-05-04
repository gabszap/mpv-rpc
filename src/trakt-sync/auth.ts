/**
 * Trakt.tv OAuth2 Device Authentication
 * Handles device auth flow, token management, and refresh
 */

import * as fs from "node:fs";
import type { Agent } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import type { AxiosRequestConfig } from "axios";
import axios from "axios";
import { config } from "../config";
import type { TraktTokens } from "./types";

/**
 * Sanitize a proxy URL for logging by redacting userinfo (username/password).
 */
function sanitizeProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = "***";
            parsed.password = "";
            return parsed.toString();
        }
        return url;
    } catch {
        return url;
    }
}

// Create axios instance with IPv4 forcing and optional Tor proxy
function createTraktAxios(): ReturnType<typeof axios.create> {
    const httpsAgent = new https.Agent({ family: 4 });
    const httpAgent = new http.Agent({ family: 4 });

    const axiosConfig: AxiosRequestConfig = {
        httpAgent,
        httpsAgent,
    };

    if (config.trakt.useTor) {
        // socks-proxy-agent v10 is ESM-only, use dynamic require to avoid module resolution issues
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SocksProxyAgent } = require("socks-proxy-agent") as {
            SocksProxyAgent: new (proxy: string) => Agent;
        };
        const socksAgent = new SocksProxyAgent(config.trakt.torProxy);
        axiosConfig.httpsAgent = socksAgent;
        axiosConfig.httpAgent = socksAgent;
        console.log("[Trakt] Using Tor proxy:", sanitizeProxyUrl(config.trakt.torProxy));
    }

    return axios.create(axiosConfig);
}

const traktAxios = createTraktAxios();

const TRAKT_API_URL = "https://api.trakt.tv";
const TRAKT_DEVICE_CODE_URL = `${TRAKT_API_URL}/oauth/device/code`;
const TRAKT_DEVICE_TOKEN_URL = `${TRAKT_API_URL}/oauth/device/token`;
const TRAKT_TOKEN_URL = `${TRAKT_API_URL}/oauth/token`;
const TOKENS_FILE = ".config/.trakt_tokens.json";
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5-minute buffer

let cachedTokens: TraktTokens | null = null;

/**
 * Headers for OAuth endpoints (JSON, no API key needed)
 */
function oauthHeaders(): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "User-Agent": "mpv-rpc/2.2.0",
    };
}

/**
 * Get tokens file path
 */
function getTokensPath(): string {
    return path.join(process.cwd(), TOKENS_FILE);
}

/**
 * Load and validate tokens from file.
 * Returns null if file is missing, malformed, or lacks required fields.
 */
function loadTokens(): TraktTokens | null {
    try {
        const tokensPath = getTokensPath();
        if (!fs.existsSync(tokensPath)) {
            return null;
        }

        const raw = fs.readFileSync(tokensPath, "utf-8");
        const data = JSON.parse(raw) as Partial<TraktTokens>;

        if (!data.access_token || !data.refresh_token || !data.expires_at) {
            console.warn("[Trakt] Token file is missing required fields. Clearing.");
            fs.unlinkSync(tokensPath);
            return null;
        }

        return data as TraktTokens;
    } catch {
        console.warn("[Trakt] Token file is malformed. Clearing.");
        try {
            const tokensPath = getTokensPath();
            if (fs.existsSync(tokensPath)) {
                fs.unlinkSync(tokensPath);
            }
        } catch {
            // Ignore cleanup failure
        }
        return null;
    }
}

/**
 * Save tokens to file
 */
function saveTokens(tokens: TraktTokens): void {
    try {
        const tokensPath = getTokensPath();
        fs.mkdirSync(path.dirname(tokensPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    } catch (e) {
        console.error("[Trakt] Error saving tokens:", e);
    }
}

/**
 * Check if tokens are within the expiry buffer
 */
function isTokenExpired(tokens: TraktTokens): boolean {
    return Date.now() >= tokens.expires_at - EXPIRY_BUFFER_MS;
}

/**
 * Refresh access token using the stored refresh token
 */
async function refreshAccessToken(refreshToken: string): Promise<TraktTokens | null> {
    try {
        const response = await traktAxios.post(
            TRAKT_TOKEN_URL,
            {
                refresh_token: refreshToken,
                client_id: config.trakt.clientId,
                client_secret: config.trakt.clientSecret,
                grant_type: "refresh_token",
                redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
            },
            { headers: oauthHeaders() },
        );

        const data = response.data;
        const tokens: TraktTokens = {
            access_token: data.access_token,
            token_type: data.token_type,
            expires_in: data.expires_in,
            refresh_token: data.refresh_token,
            scope: data.scope,
            created_at: data.created_at,
            expires_at: (data.created_at + data.expires_in) * 1000,
        };

        saveTokens(tokens);
        cachedTokens = tokens;
        console.log("[Trakt] Token refreshed successfully");
        return tokens;
    } catch (e) {
        if (axios.isAxiosError(e)) {
            console.error("[Trakt] Error refreshing token:", {
                status: e.response?.status,
                error: e.response?.data?.error,
                message: e.message,
            });
        } else {
            console.error("[Trakt] Error refreshing token:", e);
        }
        return null;
    }
}

/**
 * Poll for device token until authorized, denied, or timed out
 */
async function pollForToken(deviceCode: string, intervalMs: number): Promise<TraktTokens | null> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let currentInterval = intervalMs;

    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, currentInterval));

        try {
            const response = await traktAxios.post(
                TRAKT_DEVICE_TOKEN_URL,
                {
                    code: deviceCode,
                    client_id: config.trakt.clientId,
                    client_secret: config.trakt.clientSecret,
                },
                { headers: oauthHeaders(), validateStatus: () => true },
            );

            // Success: 200
            if (response.status === 200) {
                const data = response.data;
                const tokens: TraktTokens = {
                    access_token: data.access_token,
                    token_type: data.token_type,
                    expires_in: data.expires_in,
                    refresh_token: data.refresh_token,
                    scope: data.scope,
                    created_at: data.created_at,
                    expires_at: (data.created_at + data.expires_in) * 1000,
                };

                saveTokens(tokens);
                cachedTokens = tokens;
                console.log("[Trakt] Authorization successful!");
                return tokens;
            }

            // Handle 400 error responses
            if (response.status === 400) {
                const error = response.data?.error;

                // Trakt may return 400 with an empty body for authorization_pending.
                // Treat missing/empty error as "keep polling" rather than failing.
                if (!error || error === "authorization_pending") {
                    // Normal state — keep polling
                    continue;
                }

                switch (error) {
                    case "slow_down":
                        // Server asks us to back off — double the interval
                        currentInterval *= 2;
                        console.log("[Trakt] Slowing down polling interval...");
                        break;

                    case "access_denied":
                        console.error("[Trakt] Authorization denied. Run `npm start -- trakt-auth` to retry.");
                        return null;

                    case "expired_token":
                        console.error("[Trakt] Code expired. Run `npm start -- trakt-auth` to get a new code.");
                        return null;

                    default:
                        console.error("[Trakt] Unexpected polling error:", error);
                        return null;
                }
            } else {
                // Non-200, non-400 — unexpected
                console.error("[Trakt] Unexpected polling response:", response.status, response.data);
                return null;
            }
        } catch (e) {
            if (axios.isAxiosError(e)) {
                const status = e.response?.status;
                const errorData = e.response?.data;
                console.log(`[Trakt] Polling exception (status: ${status}):`, JSON.stringify(errorData));
                if (errorData?.error === "slow_down") {
                    currentInterval *= 2;
                    console.log("[Trakt] Slowing down polling interval...");
                }
            } else {
                console.log("[Trakt] Polling error:", e);
            }
        }
    }

    console.error("[Trakt] Authorization timed out after 10 minutes.");
    return null;
}

/**
 * Start Trakt device authorization flow.
 * Returns true if authorization succeeded, false otherwise.
 */
export async function authorize(): Promise<boolean> {
    if (!config.trakt.clientId) {
        console.error("[Trakt] Client ID not configured. Set TRAKT_CLIENT_ID in .env");
        return false;
    }

    if (!config.trakt.clientSecret) {
        console.error("[Trakt] Client secret not configured. Set TRAKT_CLIENT_SECRET in .env");
        return false;
    }

    // Request device code
    try {
        const response = await traktAxios.post(
            TRAKT_DEVICE_CODE_URL,
            {
                client_id: config.trakt.clientId,
                scope: "scrobble",
            },
            { headers: oauthHeaders() },
        );

        const { device_code, user_code, verification_url, expires_in, interval } = response.data;

        const intervalMs = (interval || 5) * 1000;

        console.log("[Trakt] Device authorization started");
        console.log(`[Trakt] Visit: ${verification_url}`);
        console.log(`[Trakt] Enter code: ${user_code}`);
        console.log(`[Trakt] Code expires in ${Math.floor(expires_in / 60)} minutes`);

        // Open browser to activation page
        const { exec } = await import("node:child_process");
        const openCmd = process.platform === "win32" ? 'start ""' : process.platform === "darwin" ? "open" : "xdg-open";
        exec(`${openCmd} "${verification_url}"`);

        // Poll for token
        const tokens = await pollForToken(device_code, intervalMs);
        return tokens !== null;
    } catch (e) {
        if (axios.isAxiosError(e)) {
            console.error("[Trakt] Error requesting device code:", {
                status: e.response?.status,
                error: e.response?.data?.error,
                message: e.message,
            });
        } else {
            console.error("[Trakt] Error requesting device code:", e);
        }
        return false;
    }
}

/**
 * Get a valid access token. Refreshes automatically if the current token is expired.
 * Returns null if not authenticated or refresh fails.
 */
export async function getAccessToken(): Promise<string | null> {
    if (!cachedTokens) {
        cachedTokens = loadTokens();
    }

    if (!cachedTokens) {
        return null;
    }

    if (isTokenExpired(cachedTokens)) {
        const refreshed = await refreshAccessToken(cachedTokens.refresh_token);
        if (!refreshed) {
            return null;
        }
        cachedTokens = refreshed;
    }

    return cachedTokens.access_token;
}

/**
 * Check if the user has valid stored tokens.
 */
export function isAuthenticated(): boolean {
    if (!cachedTokens) {
        cachedTokens = loadTokens();
    }
    return cachedTokens !== null;
}

/**
 * Clear stored tokens and cached state.
 */
export function logout(): void {
    cachedTokens = null;
    const tokensPath = getTokensPath();
    if (fs.existsSync(tokensPath)) {
        fs.unlinkSync(tokensPath);
    }
    console.log("[Trakt] Logged out");
}
