/**
 * MAL OAuth2 Authentication with PKCE
 * Handles authorization flow and token management
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as crypto from "crypto";
import axios from "axios";
import { config } from "../config";

const MAL_AUTH_URL = "https://myanimelist.net/v1/oauth2/authorize";
const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
const CALLBACK_PORT = 8888;
const TOKENS_FILE = ".mal_tokens.json";

interface MalTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number;
}

let cachedTokens: MalTokens | null = null;

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
    // Generate random 128-byte code verifier
    const verifier = crypto.randomBytes(64).toString("base64url");
    // Challenge is the same as verifier for plain method (MAL uses plain)
    const challenge = verifier;
    return { verifier, challenge };
}

/**
 * Get tokens file path
 */
function getTokensPath(): string {
    return path.join(process.cwd(), TOKENS_FILE);
}

/**
 * Load tokens from file
 */
function loadTokens(): MalTokens | null {
    try {
        const tokensPath = getTokensPath();
        if (fs.existsSync(tokensPath)) {
            const data = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
            return data as MalTokens;
        }
    } catch (e) {
        console.error("[MAL] Error loading tokens:", e);
    }
    return null;
}

/**
 * Save tokens to file
 */
function saveTokens(tokens: MalTokens): void {
    try {
        const tokensPath = getTokensPath();
        fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    } catch (e) {
        console.error("[MAL] Error saving tokens:", e);
    }
}

/**
 * Check if tokens are expired
 */
function isTokenExpired(tokens: MalTokens): boolean {
    // Consider expired if less than 5 minutes remaining
    return Date.now() >= tokens.expires_at - 5 * 60 * 1000;
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(refreshToken: string): Promise<MalTokens | null> {
    try {
        const response = await axios.post(MAL_TOKEN_URL, new URLSearchParams({
            client_id: config.mal.clientId,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        }), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });

        const tokens: MalTokens = {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_at: Date.now() + response.data.expires_in * 1000,
        };

        saveTokens(tokens);
        cachedTokens = tokens;
        console.log("[MAL] Token refreshed successfully");
        return tokens;
    } catch (e) {
        console.error("[MAL] Error refreshing token:", e);
        return null;
    }
}

/**
 * Start OAuth authorization flow
 * Opens browser for user authorization and waits for callback
 */
export async function authorize(): Promise<boolean> {
    if (!config.mal.clientId) {
        console.error("[MAL] Client ID not configured. Set MAL_CLIENT_ID in .env");
        return false;
    }

    const { verifier, challenge } = generatePKCE();

    // Build authorization URL
    const authUrl = new URL(MAL_AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.mal.clientId);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "plain");
    authUrl.searchParams.set("redirect_uri", `http://localhost:${CALLBACK_PORT}/callback`);

    console.log("[MAL] Opening browser for authorization...");
    console.log("[MAL] If browser doesn't open, visit:");
    console.log(authUrl.toString());

    // Open browser
    const { exec } = await import("child_process");
    const openCmd = process.platform === "win32" ? "start" :
        process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${openCmd} "${authUrl.toString()}"`);

    // Wait for callback
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            if (!req.url?.startsWith("/callback")) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }

            const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
            const code = url.searchParams.get("code");

            if (!code) {
                res.writeHead(400);
                res.end("Authorization failed: No code received");
                server.close();
                resolve(false);
                return;
            }

            // Exchange code for tokens
            try {
                const response = await axios.post(MAL_TOKEN_URL, new URLSearchParams({
                    client_id: config.mal.clientId,
                    grant_type: "authorization_code",
                    code,
                    code_verifier: verifier,
                    redirect_uri: `http://localhost:${CALLBACK_PORT}/callback`,
                }), {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                });

                const tokens: MalTokens = {
                    access_token: response.data.access_token,
                    refresh_token: response.data.refresh_token,
                    expires_at: Date.now() + response.data.expires_in * 1000,
                };

                saveTokens(tokens);
                cachedTokens = tokens;

                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(`
                    <html>
                    <body style="background: #2e2e2e; color: #fff; font-family: sans-serif; text-align: center; padding-top: 50px;">
                        <h1>Authorization Successful!</h1>
                        <p>You can close this window and return to MPV-RPC.</p>
                    </body>
                    </html>
                `);

                console.log("[MAL] Authorization successful!");
                server.close();
                resolve(true);
            } catch (e: any) {
                console.error("[MAL] Token exchange error:", e.response?.data || e.message);
                res.writeHead(500);
                res.end("Authorization failed: Token exchange error");
                server.close();
                resolve(false);
            }
        });

        server.listen(CALLBACK_PORT, () => {
            console.log(`[MAL] Waiting for authorization callback on port ${CALLBACK_PORT}...`);
        });

        // Timeout after 2 minutes
        setTimeout(() => {
            console.log("[MAL] Authorization timeout");
            server.close();
            resolve(false);
        }, 2 * 60 * 1000);
    });
}

/**
 * Get valid access token (refreshes if needed)
 */
export async function getAccessToken(): Promise<string | null> {
    // Check cached tokens
    if (!cachedTokens) {
        cachedTokens = loadTokens();
    }

    if (!cachedTokens) {
        return null;
    }

    // Refresh if expired
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
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
    if (!cachedTokens) {
        cachedTokens = loadTokens();
    }
    return cachedTokens !== null;
}

/**
 * Clear stored tokens (logout)
 */
export function logout(): void {
    cachedTokens = null;
    const tokensPath = getTokensPath();
    if (fs.existsSync(tokensPath)) {
        fs.unlinkSync(tokensPath);
    }
    console.log("[MAL] Logged out");
}
