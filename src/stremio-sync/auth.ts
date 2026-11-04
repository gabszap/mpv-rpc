import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type StremioTokens = {
    authKey: string;
    savedAt: string;
};

const CONFIG_DIR = path.join(process.cwd(), ".config");
const TOKEN_PATH = path.join(CONFIG_DIR, ".stremio_tokens.json");

function ensureConfigDirectory(): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

    try {
        fs.chmodSync(CONFIG_DIR, 0o700);
    } catch {
        // Best effort only; Windows may not support POSIX permissions.
    }
}

function parseStremioTokens(rawTokens: unknown): StremioTokens | null {
    if (typeof rawTokens !== "object" || rawTokens === null || Array.isArray(rawTokens)) {
        return null;
    }

    const maybeTokens = rawTokens as Partial<Record<keyof StremioTokens, unknown>>;
    if (typeof maybeTokens.authKey !== "string" || maybeTokens.authKey.trim().length === 0) {
        return null;
    }

    if (typeof maybeTokens.savedAt !== "string" || Number.isNaN(Date.parse(maybeTokens.savedAt))) {
        return null;
    }

    return {
        authKey: maybeTokens.authKey.trim(),
        savedAt: maybeTokens.savedAt,
    };
}

export function getStremioAuthKey(): string | null {
    try {
        const raw = fs.readFileSync(TOKEN_PATH, "utf-8");
        const tokens = parseStremioTokens(JSON.parse(raw));
        return tokens?.authKey ?? null;
    } catch {
        return null;
    }
}

export function saveStremioAuthKey(authKey: string): void {
    const normalizedAuthKey = authKey.trim();
    if (!normalizedAuthKey) {
        throw new Error("Stremio auth key must be a non-empty string.");
    }

    ensureConfigDirectory();

    const tokens: StremioTokens = {
        authKey: normalizedAuthKey,
        savedAt: new Date().toISOString(),
    };
    const tmpPath = `${TOKEN_PATH}.tmp.${crypto.randomBytes(8).toString("hex")}`;

    fs.writeFileSync(tmpPath, JSON.stringify(tokens, null, 4), { encoding: "utf-8", mode: 0o600 });

    try {
        fs.chmodSync(tmpPath, 0o600);
    } catch {
        // Best effort only; Windows may not support POSIX permissions.
    }

    fs.renameSync(tmpPath, TOKEN_PATH);

    try {
        fs.chmodSync(TOKEN_PATH, 0o600);
    } catch {
        // Best effort only; Windows may not support POSIX permissions.
    }
}

export function isStremioAuthenticated(): boolean {
    return getStremioAuthKey() !== null;
}
