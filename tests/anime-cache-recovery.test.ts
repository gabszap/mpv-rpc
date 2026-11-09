import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let dir: string;
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
});

it.each([
    "",
    " ",
    "null",
    "[]",
    "broken",
    undefined,
])("initializes or repairs anime cache %j to an object", async (content) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "anime-cache-recovery-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const file = path.join(dir, ".anime_cache", "anime_cache.json");
    fs.mkdirSync(path.dirname(file));
    if (content !== undefined) fs.writeFileSync(file, content);
    vi.resetModules();
    await import("../src/core/anime");
    expect(fs.readFileSync(file, "utf8").trim()).toBe("{}");
});
