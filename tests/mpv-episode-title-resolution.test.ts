import { describe, expect, it, vi } from "vitest";
import { resolveRuntimeEpisodeTitle, shouldPreferTvdbLocalizedEpisodeTitle } from "../src/mpv";

describe("runtime episode title resolution", () => {
    it("prefers localized TVDB metadata over a parsed filename episode title", async () => {
        const fetchEpisodeTitle = vi.fn().mockResolvedValue("Execução");

        const title = await resolveRuntimeEpisodeTitle({
            currentEpisodeTitle: "Execution",
            episode: 1,
            metadataSourceProvider: "tvdb",
            tvdbLanguage: "pt",
            fetchEpisodeTitle,
        });

        expect(title).toBe("Execução");
        expect(fetchEpisodeTitle).toHaveBeenCalledTimes(1);
    });

    it("keeps a parsed episode title when TVDB localization is not active", async () => {
        const fetchEpisodeTitle = vi.fn().mockResolvedValue("Execução");

        const title = await resolveRuntimeEpisodeTitle({
            currentEpisodeTitle: "Execution",
            episode: 1,
            metadataSourceProvider: "tvdb",
            tvdbLanguage: "eng",
            fetchEpisodeTitle,
        });

        expect(title).toBe("Execution");
        expect(fetchEpisodeTitle).not.toHaveBeenCalled();
    });

    it("still fetches provider metadata when no parsed episode title exists", async () => {
        const fetchEpisodeTitle = vi.fn().mockResolvedValue("Hidden Inventory");

        const title = await resolveRuntimeEpisodeTitle({
            currentEpisodeTitle: null,
            episode: 1,
            metadataSourceProvider: "jikan",
            tvdbLanguage: "eng",
            fetchEpisodeTitle,
        });

        expect(title).toBe("Hidden Inventory");
        expect(fetchEpisodeTitle).toHaveBeenCalledTimes(1);
    });

    it("normalizes Portuguese variants before deciding whether TVDB localization is preferred", () => {
        expect(shouldPreferTvdbLocalizedEpisodeTitle("tvdb", "pt-BR")).toBe(true);
        expect(shouldPreferTvdbLocalizedEpisodeTitle("tvdb", "pt_br")).toBe(true);
        expect(shouldPreferTvdbLocalizedEpisodeTitle("tvdb", "en")).toBe(false);
        expect(shouldPreferTvdbLocalizedEpisodeTitle("jikan", "pt")).toBe(false);
    });
});
