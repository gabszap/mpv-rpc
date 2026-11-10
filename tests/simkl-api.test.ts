import { beforeEach, expect, it, vi } from "vitest";
import { sendScrobble } from "../src/simkl-sync/api";
import type { SimklEvent } from "../src/simkl-sync/types";

const { post, getAccessToken, log } = vi.hoisted(() => ({ post: vi.fn(), getAccessToken: vi.fn(), log: vi.fn() }));
vi.mock("axios", () => ({ default: { post } }));
vi.mock("../src/simkl-sync/auth", () => ({ getAccessToken, logSimklRequest: log }));
const event: SimklEvent = {
    action: "stop",
    payload: { movie: { ids: { tmdb: "123" } } },
    progress: 85.1234,
    threshold: 80,
    clientId: "client",
    sessionKey: "grant",
};
beforeEach(() => {
    vi.clearAllMocks();
    getAccessToken.mockResolvedValue("secret");
    post.mockResolvedValue({ status: 200, data: { action: "scrobble" } });
});
it("sends the threshold as a query and rounds progress without exposing credentials", async () => {
    await sendScrobble(event);
    expect(post.mock.calls[0][1]).toMatchObject({ ...event.payload, progress: 85.12 });
    expect(post.mock.calls[0][2]).toMatchObject({
        params: { client_id: "client", min_progress: 80 },
        headers: { Authorization: "Bearer secret" },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});
it("never adds min_progress to pause", async () => {
    post.mockResolvedValue({ status: 200, data: { action: "pause" } });
    await sendScrobble({ ...event, action: "pause" });
    expect(post.mock.calls[0][2].params.min_progress).toBeUndefined();
});
it("retries unauthorized once with the rejected token", async () => {
    post.mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 200, data: { action: "scrobble" } });
    await sendScrobble(event);
    expect(getAccessToken).toHaveBeenLastCalledWith("client", "grant", "secret");
    expect(post).toHaveBeenCalledTimes(2);
});
it.each([429, 400])("recognizes the Simkl rate lock (%s)", async (status) => {
    post.mockResolvedValue({ status, data: { error: "RATE_LIMIT" }, headers: { "retry-after": "25" } });
    await expect(sendScrobble(event)).rejects.toMatchObject({ kind: "transient", retryAfterMs: 25000 });
});
it("accepts a duplicate stop only", async () => {
    post.mockResolvedValue({ status: 409 });
    await expect(sendScrobble(event)).resolves.toBe("already-completed");
    await expect(sendScrobble({ ...event, action: "start" })).rejects.toMatchObject({ kind: "invalid" });
});
it("rejects invalid progress before sending", async () => {
    await expect(sendScrobble({ ...event, progress: Number.NaN })).rejects.toMatchObject({ kind: "invalid" });
    expect(post).not.toHaveBeenCalled();
});
it("does not report completion when the server only saved partial progress", async () => {
    post.mockResolvedValue({ status: 200, data: { action: "pause" } });
    await expect(sendScrobble(event)).rejects.toMatchObject({ kind: "invalid" });
});
it("logs safe response fields and request identity without arbitrary response secrets", async () => {
    post.mockResolvedValue({
        status: 201,
        data: {
            action: "start",
            progress: 10,
            access_token: "never-log-this",
            show: { ids: { simkl: 123 }, title: "Title" },
        },
    });
    await sendScrobble({ ...event, action: "start", progress: 10 });
    const details = JSON.stringify(log.mock.calls);
    expect(details).toContain("simkl");
    expect(details).toContain("123");
    expect(details).not.toContain("never-log-this");
});
