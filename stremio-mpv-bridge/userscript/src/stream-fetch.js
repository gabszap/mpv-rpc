// Stream list fetching policy: timeout, retries, a slow-provider notice and bounded
// concurrency. No GM_* globals here: the HTTP request is injected, so this is testable.

// The AIOStreams addon was measured at 10.0 to 11.0 seconds per request, consistently,
// cached or not. A 10 second limit aborted a large share of those requests, and three
// failures in a row sent the user to the slower fallback providers. The limit leaves
// clear headroom over that and matches the bridge server's 25 second limit.
export const STREAM_FETCH_TIMEOUT_MS = 30000;
export const STREAM_FETCH_MAX_RETRIES = 2;
export const STREAM_FETCH_RETRY_DELAY_MS = 1000;
export const STREAM_FETCH_SLOW_AFTER_MS = 5000;
// Episodes of a playlist are independent, but providers are rate limited: stay small.
export const STREAM_FETCH_CONCURRENCY = 3;

/**
 * URL of the stream list for one episode. Kitsu ids address an episode directly;
 * other ids (IMDb) use season and episode.
 */
export function buildStreamUrl(baseUrl, id, season, episode) {
    if (id.startsWith("kitsu:")) {
        return `${baseUrl}/stream/series/${id}:${episode}.json`;
    }
    return `${baseUrl}/stream/series/${id}:${season}:${episode}.json`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch and parse a stream list, retrying after a timeout, a network error or a
 * non-200 status. A 200 response that is not valid JSON is not retried.
 *
 * `request(url, timeoutMs)` resolves to one of
 *   { kind: "response", status, body } | { kind: "timeout" } | { kind: "error" }.
 * `onRetry(attempt, attempts)` runs before a retry; `onSlow()` runs once per attempt
 * that is still pending after `slowAfterMs`.
 */
export async function fetchStreamList(url, request, options = {}) {
    const {
        maxRetries = STREAM_FETCH_MAX_RETRIES,
        retryDelayMs = STREAM_FETCH_RETRY_DELAY_MS,
        slowAfterMs = STREAM_FETCH_SLOW_AFTER_MS,
        onSlow,
        onRetry,
    } = options;
    const attempts = maxRetries + 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1) {
            if (onRetry) onRetry(attempt, attempts);
            await sleep(retryDelayMs);
        }

        const slowTimer = onSlow ? setTimeout(onSlow, slowAfterMs) : null;
        let result;
        try {
            result = await request(url, STREAM_FETCH_TIMEOUT_MS);
        } catch {
            result = { kind: "error" };
        } finally {
            if (slowTimer) clearTimeout(slowTimer);
        }

        if (result.kind === "response" && result.status === 200) {
            try {
                const data = JSON.parse(result.body);
                return data.streams || [];
            } catch {
                return [];
            }
        }
    }

    return [];
}

/**
 * Run `worker` over `items` with at most `limit` running at once. Results keep the
 * input order.
 */
export async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index], index);
        }
    });

    await Promise.all(runners);
    return results;
}
