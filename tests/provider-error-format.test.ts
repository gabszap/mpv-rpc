import { describe, expect, it } from "vitest";
import { formatProviderErrorDetails } from "../src/providers/types";

describe("formatProviderErrorDetails", () => {
    it("includes structured provider, request, and response payload fields", () => {
        const error = {
            code: "ERR_BAD_RESPONSE",
            message: "Request failed with status code 500",
            config: {
                method: "get",
                baseURL: "https://api.example.com",
                url: "/v1/anime",
            },
            response: {
                status: 500,
                data: {
                    status: "error",
                    type: "server_error",
                    message: "Unexpected exception",
                    trace: "trace-id-123",
                    error: "InternalError",
                },
            },
        };

        const details = JSON.parse(formatProviderErrorDetails("TVDB", "search", error));

        expect(details.provider).toBe("TVDB");
        expect(details.operation).toBe("search");
        expect(details.status).toBe(500);
        expect(details.code).toBe("ERR_BAD_RESPONSE");
        expect(details.message).toBe("Request failed with status code 500");
        expect(details.request).toEqual({
            method: "GET",
            url: "https://api.example.com/v1/anime",
        });
        expect(details.response).toMatchObject({
            status: "error",
            type: "server_error",
            message: "Unexpected exception",
            trace: "trace-id-123",
            error: "InternalError",
        });
    });

    it("truncates oversized details safely", () => {
        const hugePayload = {
            message: "x".repeat(2000),
            trace: "y".repeat(2000),
            nested: {
                error: "z".repeat(2000),
            },
        };

        const error = {
            message: "Request failed with status code 500",
            response: {
                status: 500,
                data: hugePayload,
            },
        };

        const details = JSON.parse(formatProviderErrorDetails("Jikan", "/anime", error, 200));

        expect(details.truncated).toBe(true);
        expect(details.response).toBe("[truncated]");
        expect(details.status).toBe(500);
        expect(details.provider).toBe("Jikan");
    });
});
