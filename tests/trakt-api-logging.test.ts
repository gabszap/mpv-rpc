import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const axiosGetMock = vi.fn();
const axiosPostMock = vi.fn();

vi.mock("axios", () => ({
    default: {
        create: vi.fn(() => ({
            get: axiosGetMock,
            post: axiosPostMock,
        })),
        isAxiosError: vi.fn(() => false),
    },
}));

vi.mock("../src/config", () => ({
    config: {
        debug: false,
        syncDryRun: false,
        trakt: {
            clientId: "client-id-secret",
            clientSecret: "client-secret-value",
            useTor: false,
            torProxy: "socks5://127.0.0.1:9050",
        },
    },
}));

vi.mock("../src/trakt-sync/auth", () => ({
    getAccessToken: vi.fn(() => "access-token-secret"),
}));

function readApiLog(tempDir: string): string {
    return fs.readFileSync(path.join(tempDir, ".anime_cache", "api_log.txt"), "utf-8");
}

describe("Trakt API log file", () => {
    let tempDir: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpv-rpc-trakt-log-"));
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("writes Trakt API call logs when debug is disabled", async () => {
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: [
                {
                    type: "show",
                    score: 100,
                    show: {
                        title: "Dr. Stone",
                        year: 2019,
                        ids: { trakt: 1, slug: "dr-stone", imdb: "tt9679542" },
                    },
                },
            ],
        });

        const { searchByTitle } = await import("../src/trakt-sync/api");
        const results = await searchByTitle("Dr. Stone", "show");

        expect(results).toHaveLength(1);
        const apiLog = readApiLog(tempDir);
        expect(apiLog).toContain("[Trakt] GET https://api.trakt.tv/search/show → 200");
        expect(apiLog).toContain('query="Dr. Stone", 1 results, best="Dr. Stone"');
    });

    it("redacts sensitive Trakt diagnostic values from the public api log", async () => {
        const { logTraktDiagnostic } = await import("../src/trakt-sync/api");

        logTraktDiagnostic(
            "Authorization: Bearer access-token-secret client_secret=client-secret-value access_token=access-token-secret trakt-api-key=client-id-secret auth=auth-secret authorization=authorization-secret",
        );

        const apiLog = readApiLog(tempDir);
        expect(apiLog).toContain("Authorization: Bearer [REDACTED]");
        expect(apiLog).toContain("client_secret=[REDACTED]");
        expect(apiLog).toContain("access_token=[REDACTED]");
        expect(apiLog).toContain("trakt-api-key=[REDACTED]");
        expect(apiLog).toContain("auth=[REDACTED]");
        expect(apiLog).toContain("authorization=[REDACTED]");
        expect(apiLog).not.toContain("access-token-secret");
        expect(apiLog).not.toContain("client-secret-value");
        expect(apiLog).not.toContain("client-id-secret");
        expect(apiLog).not.toContain("auth-secret");
        expect(apiLog).not.toContain("authorization-secret");
    });
});
