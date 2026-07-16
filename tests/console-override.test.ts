import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleRepl, resolveDisplayTitle } from "../src/console/repl";
import { clearManualOverride, createEpisodeContext, getManualOverride, setManualOverride } from "../src/console/types";

type ReplInternals = {
    handleClearEpisode(): void;
    handleStatus(): void;
};

function createRequiredContext(filename: string, resolvedEpisode: number, parsedEpisode: number) {
    const context = createEpisodeContext(filename, "Dr. Stone", 4, resolvedEpisode, 4, parsedEpisode);
    if (!context) {
        throw new Error("Expected episode context");
    }
    return context;
}

describe("console episode-title overrides", () => {
    beforeEach(() => {
        clearManualOverride();
    });

    afterEach(() => {
        clearManualOverride();
        vi.restoreAllMocks();
    });

    it("keeps an S04E35 override active after overflow resolution maps display to S04E11", () => {
        const parsedContext = createRequiredContext("Dr.STONE.S04E35", 35, 35);
        const resolvedContext = createRequiredContext("Dr.STONE.S04E35", 11, 35);

        setManualOverride({
            title: "Giant Step",
            context: parsedContext,
            timestamp: new Date(),
        });

        expect(resolveDisplayTitle("Automatic Title", resolvedContext)).toEqual({
            title: "Giant Step",
            isOverride: true,
        });
    });

    it("shows parsed and resolved S/E plus the active override anchor in status", () => {
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const repl = new ConsoleRepl();
        const context = createRequiredContext("Dr.STONE.S04E35", 11, 35);

        try {
            repl.updateContext(context, "Dr.STONE.S04E35");
            setManualOverride({
                title: "Giant Step",
                context,
                timestamp: new Date("2026-06-12T00:00:00.000Z"),
            });

            (repl as unknown as ReplInternals).handleStatus();

            expect(consoleLogSpy).toHaveBeenCalledWith("Parsed S/E: S04E35");
            expect(consoleLogSpy).toHaveBeenCalledWith("Resolved S/E: S04E11");
            expect(consoleLogSpy).toHaveBeenCalledWith("  Anchored to Parsed S/E: S04E35");
            expect(consoleLogSpy).toHaveBeenCalledWith("  Resolved S/E: S04E11");
        } finally {
            repl.close();
        }
    });

    it("clears an override when the parsed-source S/E changes", () => {
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const repl = new ConsoleRepl();
        const firstContext = createRequiredContext("Dr.STONE.S04E35", 11, 35);
        const nextContext = createRequiredContext("Dr.STONE.S04E36", 12, 36);

        try {
            repl.updateContext(firstContext, "Dr.STONE.S04E35");
            setManualOverride({
                title: "Giant Step",
                context: firstContext,
                timestamp: new Date(),
            });

            repl.updateContext(nextContext, "Dr.STONE.S04E36");

            expect(getManualOverride()).toBeNull();
        } finally {
            repl.close();
            consoleLogSpy.mockRestore();
        }
    });

    it("clear-episode clears the override regardless of resolved state", () => {
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const repl = new ConsoleRepl();
        const context = createRequiredContext("Dr.STONE.S04E35", 11, 35);

        try {
            setManualOverride({
                title: "Giant Step",
                context,
                timestamp: new Date(),
            });

            (repl as unknown as ReplInternals).handleClearEpisode();

            expect(getManualOverride()).toBeNull();
        } finally {
            repl.close();
            consoleLogSpy.mockRestore();
        }
    });
});
