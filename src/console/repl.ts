/**
 * Console REPL - Interactive command interface for manual title override
 *
 * Provides real-time manual title corrections that auto-expire when episode changes.
 */

import { EventEmitter } from "node:events";
import * as readline from "node:readline";
import { providerName } from "../core/anime";
import {
    clearManualOverride,
    clearSeriesNameOverride,
    type EpisodeContext,
    getManualOverride,
    getSeriesNameOverride,
    type ManualOverride,
    type SeriesNameOverride,
    setManualOverride,
    setSeriesNameOverride,
} from "./types";

/**
 * Console REPL for manual title override commands
 */
export class ConsoleRepl extends EventEmitter {
    private rl: readline.Interface;
    private currentContext: EpisodeContext | null = null;
    private currentFilename: string = "";
    private isPromptActive = false;
    private promptTimer: NodeJS.Timeout | null = null;

    constructor() {
        super();

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: "mpv-rpc> ",
        });

        this.rl.on("line", this.handleCommand.bind(this));
        this.rl.on("close", () => {
            this.clearPromptTimer();
            // Handle Ctrl+C gracefully
            this.emit("exit");
        });

        // Don't show prompt immediately - wait for first update
    }

    /**
     * Update the current episode context
     * Called from the main update loop
     */
    updateContext(context: EpisodeContext | null, filename?: string): void {
        const previousContext = this.currentContext;
        this.currentContext = context;
        if (filename) {
            this.currentFilename = filename;
        }

        // Auto-clear override only when the parsed-source S/E changed.
        // Canonical remapping (e.g. S04E35 → S04E11 after overflow resolution)
        // changes context.id but NOT context.parsedId, so the override survives.
        if (previousContext && context && previousContext.parsedId !== context.parsedId) {
            const override = getManualOverride();
            if (override) {
                console.log(
                    `\n[System] Parsed episode changed (${previousContext.parsedId} → ${context.parsedId}). Override auto-cleared.`,
                );
                console.log(
                    `[DETAIL] Override cleared: parsed-source identity changed from "${previousContext.parsedId}" to "${context.parsedId}" (resolved: ${previousContext.id} → ${context.id})`,
                );
                clearManualOverride();
                this.emit("overrideCleared");
            }
        }

        // Show prompt if not already active
        if (!this.isPromptActive) {
            this.isPromptActive = true;
            // Small delay to let other logs finish
            this.promptTimer = setTimeout(() => {
                this.promptTimer = null;
                this.rl.prompt();
            }, 100);
        }
    }

    /**
     * Handle user input commands
     */
    private handleCommand(input: string): void {
        const trimmed = input.trim();

        if (!trimmed) {
            this.rl.prompt();
            return;
        }

        // Parse command and argument
        // Handle: episode-title "title", series-name "name" (and aliases et, sn)
        const episodeTitleMatch = trimmed.match(/^(?:episode-title|et)(?:\s+["']?(.+?)["']?)?$/i);
        const seriesNameMatch = trimmed.match(/^(?:series-name|sn)(?:\s+["']?(.+?)["']?)?$/i);
        const command = trimmed.split(/\s+/)[0].toLowerCase();

        if (episodeTitleMatch) {
            this.handleEpisodeTitle(episodeTitleMatch[1]);
        } else if (seriesNameMatch) {
            this.handleSeriesName(seriesNameMatch[1]);
        } else {
            switch (command) {
                case "clear-episode":
                case "ce":
                    this.handleClearEpisode();
                    break;
                case "clear-series":
                case "cs":
                    this.handleClearSeries();
                    break;
                case "clear-all":
                case "ca":
                    this.handleClearAll();
                    break;
                case "status":
                case "st":
                    this.handleStatus();
                    break;
                case "help":
                case "?":
                    this.handleHelp();
                    break;
                case "exit":
                case "quit":
                    this.handleExit();
                    break;
                default:
                    console.log(`[Error] Unknown command: ${command}. Type 'help' for available commands.`);
            }
        }

        this.rl.prompt();
    }

    /**
     * Handle 'episode-title' command - set manual episode title override
     */
    private handleEpisodeTitle(title?: string): void {
        if (!title?.trim()) {
            console.log('[Error] Usage: episode-title "<title>"');
            return;
        }

        if (!this.currentContext) {
            console.log("[Error] No episode currently playing");
            return;
        }

        const override: ManualOverride = {
            title: title,
            context: this.currentContext,
            timestamp: new Date(),
        };

        setManualOverride(override);
        console.log(`[Manual] Episode title set to: "${title}"`);
        console.log(`[Manual] Active for episode: ${this.currentContext.id}`);
        console.log(
            `[DETAIL] Override anchored to parsed S/E: ${this.currentContext.parsedId}, resolved S/E: ${this.currentContext.id}`,
        );
        this.emit("overrideSet", override);
    }

    /**
     * Handle 'series-name' command - override the series name for metadata searches
     */
    private handleSeriesName(name?: string): void {
        if (!name?.trim()) {
            console.log('[Error] Usage: series-name "<name>"');
            return;
        }

        if (!this.currentContext) {
            console.log("[Error] No episode currently playing");
            return;
        }

        const override: SeriesNameOverride = {
            overrideName: name,
            filename: this.currentFilename,
            timestamp: new Date(),
        };

        setSeriesNameOverride(override);
        console.log(`[Manual] Series name set to: "${name}"`);
        console.log(`[Manual] Will re-search metadata with this name`);
        this.emit("renameSet", override);
    }

    /**
     * Handle 'clear-episode' command - remove episode title override only
     */
    private handleClearEpisode(): void {
        const override = getManualOverride();

        if (override) {
            console.log("[Manual] Episode title override cleared");
            console.log(
                `[DETAIL] Override cleared: user clear-episode command (anchored to parsed S/E: ${override.context.parsedId}, resolved S/E: ${override.context.id})`,
            );
            clearManualOverride();
            this.emit("overrideCleared");
        } else {
            console.log("[Manual] No episode title override active");
        }
    }

    /**
     * Handle 'clear-series' command - remove series name override only
     */
    private handleClearSeries(): void {
        const rename = getSeriesNameOverride();

        if (rename) {
            clearSeriesNameOverride();
            console.log("[Manual] Series name override cleared");
            this.emit("renameCleared");
        } else {
            console.log("[Manual] No series name override active");
        }
    }

    /**
     * Handle 'clear-all' command - remove all overrides
     */
    private handleClearAll(): void {
        const override = getManualOverride();
        const rename = getSeriesNameOverride();

        if (override) {
            console.log("[Manual] Episode title override cleared");
            console.log(
                `[DETAIL] Override cleared: user clear-all command (anchored to parsed S/E: ${override.context.parsedId}, resolved S/E: ${override.context.id})`,
            );
            clearManualOverride();
            this.emit("overrideCleared");
        }
        if (rename) {
            clearSeriesNameOverride();
            console.log("[Manual] Series name override cleared");
            this.emit("renameCleared");
        }
        if (!override && !rename) {
            console.log("[Manual] No active overrides to clear");
        }
    }

    /**
     * Handle 'status' command - show current state
     */
    private handleStatus(): void {
        console.log("\n--- Status ---");

        // Current episode
        if (this.currentContext) {
            console.log(`Parsed S/E: ${this.currentContext.parsedId}`);
            console.log(`Resolved S/E: ${this.currentContext.id}`);
            console.log(`  Series: ${this.currentContext.seriesName}`);
            if (this.currentContext.seasonNumber !== null) {
                console.log(`  Season: ${this.currentContext.seasonNumber}`);
            }
            console.log(`  Episode: ${this.currentContext.episodeNumber}`);
        } else {
            console.log("Current Episode: None playing");
        }

        // Override status
        const override = getManualOverride();
        if (override) {
            console.log(`\nEpisode Title Override: ACTIVE`);
            console.log(`  Title: "${override.title}"`);
            console.log(`  Anchored to Parsed S/E: ${override.context.parsedId}`);
            console.log(`  Resolved S/E: ${override.context.id}`);
            console.log(`  Set At: ${override.timestamp.toLocaleTimeString()}`);
        } else {
            console.log("\nEpisode Title Override: None");
        }

        // Rename status
        const rename = getSeriesNameOverride();
        if (rename) {
            console.log(`\nSeries Name Override: ACTIVE`);
            console.log(`  Name: "${rename.overrideName}"`);
            console.log(`  Set At: ${rename.timestamp.toLocaleTimeString()}`);
        } else {
            console.log("\nSeries Name Override: None");
        }

        // Provider info
        console.log(`\nMetadata Provider: ${providerName}`);
        console.log("--------------\n");
    }

    /**
     * Handle 'help' command - show available commands
     */
    private handleHelp(): void {
        console.log("\n--- Available Commands ---\n");
        console.log('  episode-title "<title>"    Override the episode title shown in Discord');
        console.log('                              Example: episode-title "The Battle Begins"');
        console.log("                              Alias: et");
        console.log("                              Note: Override is anchored to the parsed S/E");
        console.log("                              from the filename and survives canonical");
        console.log("                              remapping (e.g. overflow resolution).\n");
        console.log('  series-name "<name>"       Override the series name for metadata search');
        console.log("                              Useful when the parser got the anime name wrong");
        console.log('                              Example: series-name "One Piece"');
        console.log("                              Alias: sn\n");
        console.log("  clear-episode (ce)         Remove the episode title override");
        console.log("  clear-series (cs)          Remove the series name override");
        console.log("  clear-all (ca)             Remove all overrides");
        console.log("  status (st)                Show current state and active overrides");
        console.log("  help (?)                   Show this message");
        console.log("  exit (quit)                Quit the application\n");
        console.log("  All commands accept single or double quotes for arguments.");
        console.log("----------------------------\n");
    }

    /**
     * Handle 'exit' command - graceful shutdown
     */
    private handleExit(): void {
        console.log("[System] Exiting...");
        this.rl.close();
        this.emit("exit");
    }

    /**
     * Close the REPL interface
     */
    close(): void {
        this.clearPromptTimer();
        this.rl.close();
    }

    private clearPromptTimer(): void {
        if (!this.promptTimer) {
            return;
        }

        clearTimeout(this.promptTimer);
        this.promptTimer = null;
    }
}

/**
 * Resolve the display title, applying manual override if active.
 *
 * The override is matched against the parsed-source S/E identity (parsedId),
 * so it survives canonical remapping (e.g. overflow resolution changing
 * S04E35 → S04E11). The auto-clear logic lives exclusively in
 * ConsoleRepl.updateContext, which compares parsedId values.
 */
export function resolveDisplayTitle(
    autoTitle: string,
    episodeContext: EpisodeContext | null,
): { title: string; isOverride: boolean } {
    const override = getManualOverride();

    if (override && episodeContext) {
        if (override.context.parsedId === episodeContext.parsedId) {
            // Override is active for this parsed-source episode
            return {
                title: override.title,
                isOverride: true,
            };
        }
        // If parsedId differs, updateContext already handled the auto-clear.
        // Fall through to autoTitle.
    }

    return {
        title: autoTitle,
        isOverride: false,
    };
}
