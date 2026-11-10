import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", () => ({ default: { post } }));
vi.mock("../src/core/config", () => ({ config: { simkl: { clientId: "client-v2" } } }));
let dir: string;
let file: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "simkl-auth-"));
    file = path.join(dir, ".config", ".simkl_tokens.json");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    post.mockReset();
    vi.resetModules();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});
const token = {
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    token_type: "Bearer",
    expires_in: 604800,
    scope: "media:read media:write",
};
function save(expired = false): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify({
            ...token,
            client_id: "client-v2",
            session_key: "grant-1",
            expires_at: Date.now() + (expired ? -1 : 600000),
            refresh_expires_at: Date.now() + 1000000,
        }),
    );
}

it("logs in through the documented V2 device grant and stores bound tokens", async () => {
    vi.useFakeTimers();
    post.mockResolvedValueOnce({
        status: 200,
        data: {
            device_code: "device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://simkl.com/pin",
            verification_uri_complete: "https://simkl.com/pin?user_code=ABCD-EFGH",
            expires_in: 30,
            interval: 1,
        },
    })
        .mockResolvedValueOnce({ status: 400, data: { error: "authorization_pending" } })
        .mockResolvedValueOnce({ status: 200, data: token });
    const auth = await import("../src/simkl-sync/auth");
    const done = auth.authorize();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toBe(true);
    expect(post.mock.calls[0][0]).toBe("https://api.simkl.com/oauth2/device");
    const form = new URLSearchParams(post.mock.calls[1][1]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(form.get("device_code")).toBe("device-secret");
    expect(form.has("client_secret")).toBe(false);
    expect(form.has("code_verifier")).toBe(false);
    expect(auth.isAuthenticated()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
        client_id: "client-v2",
        access_token: "access-secret",
    });
    const logs = fs.readFileSync(path.join(dir, ".anime_cache", "api_log.txt"), "utf8");
    expect(logs).not.toMatch(/access-secret|refresh-secret|device-secret/);
});
it("backs off by five seconds on slow_down and respects the device deadline", async () => {
    vi.useFakeTimers();
    post.mockResolvedValueOnce({
        status: 200,
        data: {
            device_code: "d",
            user_code: "u",
            verification_uri: "https://simkl.com/pin",
            expires_in: 8,
            interval: 1,
        },
    })
        .mockResolvedValueOnce({ status: 400, data: { error: "slow_down" } })
        .mockResolvedValue({ status: 400, data: { error: "authorization_pending" } });
    const auth = await import("../src/simkl-sync/auth");
    const done = auth.authorize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toBe(false);
    expect(post).toHaveBeenCalledTimes(3);
});
it("rejects read-only authorization", async () => {
    vi.useFakeTimers();
    post.mockResolvedValueOnce({
        status: 200,
        data: {
            device_code: "d",
            user_code: "u",
            verification_uri: "https://simkl.com/pin",
            expires_in: 10,
            interval: 1,
        },
    }).mockResolvedValueOnce({ status: 200, data: { ...token, scope: "media:read" } });
    const auth = await import("../src/simkl-sync/auth");
    const done = auth.authorize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
});
it("stops immediately for a V1 or invalid client", async () => {
    post.mockResolvedValue({ status: 401, data: { error: "invalid_client" } });
    expect(await (await import("../src/simkl-sync/auth")).authorize()).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
});
it("shares one refresh and keeps a nonrotating refresh token", async () => {
    save(true);
    post.mockResolvedValue({ status: 200, data: { ...token, access_token: "new-access" } });
    const auth = await import("../src/simkl-sync/auth");
    expect(
        await Promise.all([auth.getAccessToken("client-v2", "grant-1"), auth.getAccessToken("client-v2", "grant-1")]),
    ).toEqual(["new-access", "new-access"]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).refresh_token).toBe("refresh-secret");
});
it("preserves tokens on transient refresh failures", async () => {
    save(true);
    post.mockRejectedValue(new Error("offline"));
    const auth = await import("../src/simkl-sync/auth");
    await expect(auth.getAccessToken("client-v2", "grant-1")).rejects.toMatchObject({ kind: "transient" });
    expect(fs.existsSync(file)).toBe(true);
});
it("invalidates only the revoked grant", async () => {
    save(true);
    post.mockResolvedValue({ status: 400, data: { error: "invalid_grant" } });
    const auth = await import("../src/simkl-sync/auth");
    expect(await auth.getAccessToken("client-v2", "grant-1")).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
});
it("refuses to use another client or login session", async () => {
    save();
    const auth = await import("../src/simkl-sync/auth");
    expect(await auth.getAccessToken("other-client", "grant-1")).toBeNull();
    expect(await auth.getAccessToken("client-v2", "other-grant")).toBeNull();
    expect(post).not.toHaveBeenCalled();
});
it("rereads a token refreshed by another process on 401 instead of refreshing again", async () => {
    save();
    const auth = await import("../src/simkl-sync/auth");
    expect(await auth.getAccessToken("client-v2", "grant-1", "rejected-old-token")).toBe("access-secret");
    expect(post).not.toHaveBeenCalled();
});
