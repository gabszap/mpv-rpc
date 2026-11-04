import * as fs from "node:fs";
import * as path from "node:path";
import axios from "axios";
import { config } from "../core/config";

const STREMIO_API_BASE_URL = "https://api.strem.io/api";
const API_LOG_PATH = path.join(process.cwd(), ".anime_cache", "stremio_api_log.txt");

export function nowTimestamp(): string {
    const now = new Date();
    const offset = -4 * 60 * 60 * 1000;
    const local = new Date(now.getTime() + offset);
    return local.toISOString().replace("Z", "-04:00");
}

function appendApiLog(entry: Record<string, unknown>): void {
    if (!config.debug) {
        return;
    }
    try {
        const dir = path.dirname(API_LOG_PATH);
        fs.mkdirSync(dir, { recursive: true });
        const timestamp = nowTimestamp();
        const block = `--- ${timestamp} ---\n${JSON.stringify({ ...entry, timestamp }, null, 2)}\n`;
        fs.appendFileSync(API_LOG_PATH, block, "utf-8");
    } catch {
        // Best effort only — logging should never crash the app
    }
}

function redactAuthKey(payload: Record<string, unknown>): Record<string, unknown> {
    if ("authKey" in payload) {
        return { ...payload, authKey: "***REDACTED***" };
    }
    return payload;
}

export type LibraryItemState = Record<string, unknown>;

export type LibraryItem = {
    _id: string;
    _mtime?: string;
    state?: LibraryItemState;
    [key: string]: unknown;
};

type StremioApiResponse = {
    error?: unknown;
    result?: unknown;
};

function parseLibraryItem(rawResult: unknown): LibraryItem | null {
    if (rawResult === null || rawResult === undefined) {
        return null;
    }

    if (Array.isArray(rawResult)) {
        return rawResult.length > 0 ? parseLibraryItem(rawResult[0]) : null;
    }

    if (typeof rawResult !== "object") {
        throw new Error("Stremio API returned an invalid library item result.");
    }

    const resultObject = rawResult as Record<string, unknown>;

    if (Array.isArray(resultObject.items)) {
        return resultObject.items.length > 0 ? parseLibraryItem(resultObject.items[0]) : null;
    }

    if (typeof resultObject.item === "object" && resultObject.item !== null) {
        return parseLibraryItem(resultObject.item);
    }

    if (Object.keys(resultObject).length === 0) {
        return null;
    }

    if (typeof resultObject._id !== "string" || resultObject._id.trim().length === 0) {
        throw new Error("Stremio API returned a library item without _id.");
    }

    return resultObject as LibraryItem;
}

async function requestStremio(
    method: "datastoreGet" | "datastorePut",
    payload: Record<string, unknown>,
): Promise<unknown> {
    appendApiLog({ direction: "request", method, payload: redactAuthKey(payload) });

    const response = await axios.post<StremioApiResponse>(`${STREMIO_API_BASE_URL}/${method}`, payload, {
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        appendApiLog({ direction: "response", method, status: response.status, error: "non-2xx status" });
        throw new Error(`Stremio API ${method} failed with HTTP ${response.status}.`);
    }

    if (response.data.error) {
        appendApiLog({ direction: "response", method, status: response.status, error: String(response.data.error) });
        throw new Error(`Stremio API ${method} failed: ${String(response.data.error)}`);
    }

    if (!("result" in response.data)) {
        appendApiLog({ direction: "response", method, status: response.status, error: "no result field" });
        throw new Error(`Stremio API ${method} returned no result field.`);
    }

    appendApiLog({
        direction: "response",
        method,
        status: response.status,
        resultSummary: summarizeResult(response.data.result),
    });

    return response.data.result;
}

function summarizeResult(result: unknown): string {
    if (Array.isArray(result)) {
        return `array(${result.length})`;
    }
    if (result === null || result === undefined) {
        return String(result);
    }
    return typeof result;
}

export async function getLibraryItem(libraryItemId: string, authKey: string): Promise<LibraryItem | null> {
    if (!libraryItemId.trim()) {
        throw new Error("Stremio library item id must be a non-empty string.");
    }

    if (!authKey.trim()) {
        throw new Error("Stremio auth key must be a non-empty string.");
    }

    const result = await requestStremio("datastoreGet", {
        authKey,
        collection: "libraryItem",
        ids: [libraryItemId],
    });

    const parsed = parseLibraryItem(result);
    appendApiLog({ direction: "parsed", method: "datastoreGet", libraryItemId, found: parsed !== null });
    return parsed;
}

function extractKeyFields(item: LibraryItem): Record<string, unknown> {
    const state =
        typeof item.state === "object" && item.state !== null && !Array.isArray(item.state)
            ? (item.state as Record<string, unknown>)
            : {};
    return {
        _id: item._id,
        _mtime: item._mtime,
        "state.timeOffset": state.timeOffset,
        "state.duration": state.duration,
        "state.season": state.season,
        "state.episode": state.episode,
        "state.lastWatched": state.lastWatched,
        "state.video_id": state.video_id,
    };
}

export async function putLibraryItem(item: LibraryItem, authKey: string): Promise<void> {
    if (!item._id.trim()) {
        throw new Error("Stremio library item must include a non-empty _id.");
    }

    if (!authKey.trim()) {
        throw new Error("Stremio auth key must be a non-empty string.");
    }

    appendApiLog({ direction: "put", method: "datastorePut", itemKeyFields: extractKeyFields(item) });

    await requestStremio("datastorePut", {
        authKey,
        collection: "libraryItem",
        changes: [item],
    });
}
