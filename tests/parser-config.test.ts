import { describe, expect, it } from "vitest";
import { config } from "../src/core/config";

describe("parser configuration", () => {
    it("has no guessitApi section", () => {
        expect("guessitApi" in config).toBe(false);
    });
});
