import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosGetMock = vi.fn();
const logApiCallMock = vi.fn();
const formatProviderErrorDetailsMock = vi.fn();

vi.mock("axios", () => ({
    default: {
        get: axiosGetMock,
    },
}));

vi.mock("../src/core/config", () => ({
    config: {
        debug: true,
        jikan: {
            baseUrl: "https://api.jikan.moe/v4",
            minRequestInterval: 0,
        },
    },
}));

vi.mock("../src/providers/types", () => ({
    logApiCall: logApiCallMock,
    formatProviderErrorDetails: formatProviderErrorDetailsMock,
}));

describe("JikanProvider error logging", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        formatProviderErrorDetailsMock.mockReturnValue("formatted-detail");
    });

    it("logs concise search errors and keeps detailed payload in api log path", async () => {
        const providerError = {
            message: "Request failed with status code 503",
            response: {
                status: 503,
                data: {
                    status: "maintenance",
                    note: "service unavailable",
                },
            },
        };

        axiosGetMock.mockRejectedValueOnce(providerError);
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const { JikanProvider } = await import("../src/providers/jikan");
        const provider = new JikanProvider();
        const result = await provider.searchAnime("Attack on Titan");

        expect(result).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            "[Jikan] Search error: status 503: Request failed with status code 503",
        );
        expect(consoleErrorSpy.mock.calls[0]).toHaveLength(1);

        expect(logApiCallMock).toHaveBeenCalledWith(
            "Jikan",
            "/anime",
            {
                q: "Attack on Titan",
                limit: 20,
                sfw: true,
            },
            "ERROR",
            "Request failed with status code 503",
        );
        expect(formatProviderErrorDetailsMock).toHaveBeenCalledWith("Jikan", "/anime", providerError);
        expect(logApiCallMock).toHaveBeenCalledWith(
            "Jikan",
            "/anime",
            {
                q: "Attack on Titan",
                limit: 20,
                sfw: true,
            },
            "ERROR_DETAIL",
            "formatted-detail",
        );
    });

    it("falls back to episode list when individual episode lookup fails", async () => {
        axiosGetMock
            .mockRejectedValueOnce({
                message: "Request failed with status code 500",
                response: { status: 500 },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    data: [
                        { mal_id: 5, title: "Previous Episode" },
                        { mal_id: 6, title: "Science Future" },
                    ],
                },
            });

        const { JikanProvider } = await import("../src/providers/jikan");
        const provider = new JikanProvider();

        await expect(provider.getEpisodeTitle(62568, 6)).resolves.toBe("Science Future");
        expect(axiosGetMock).toHaveBeenCalledTimes(2);
        expect(axiosGetMock.mock.calls[0]?.[0]).toContain("/anime/62568/episodes/6");
        expect(axiosGetMock.mock.calls[1]?.[0]).toContain("/anime/62568/episodes");
    });
});
