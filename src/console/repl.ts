/**
 * Console REPL - Interactive command interface for manual title override
 * 
 * Provides real-time manual title corrections that auto-expire when episode changes.
 */

import * as readline from 'readline';
import { EventEmitter } from 'events';
import {
    EpisodeContext,
    ManualOverride,
    SeriesNameOverride,
    getManualOverride,
    setManualOverride,
    clearManualOverride,
    setSeriesNameOverride,
    getSeriesNameOverride,
    clearSeriesNameOverride,
} from './types';
import { providerName } from '../anime';

/**
 * Console REPL for manual title override commands
 */
export class ConsoleRepl extends EventEmitter {
    private rl: readline.Interface;
    private currentContext: EpisodeContext | null = null;
    private currentFilename: string = "";
    private isPromptActive = false;

    constructor() {
        super();
        
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'mpv-rpc> ',
        });

        this.rl.on('line', this.handleCommand.bind(this));
        this.rl.on('close', () => {
            // Handle Ctrl+C gracefully
            this.emit('exit');
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

        // Auto-clear override if episode changed
        if (previousContext && context && previousContext.id !== context.id) {
            const override = getManualOverride();
            if (override) {
                console.log(`\n[System] Episode changed (${previousContext.id} → ${context.id}). Override auto-cleared.`);
                clearManualOverride();
                this.emit('overrideCleared');
            }
        }

        // Show prompt if not already active
        if (!this.isPromptActive) {
            this.isPromptActive = true;
            // Small delay to let other logs finish
            setTimeout(() => this.rl.prompt(), 100);
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
        // Handle: set "title", rename "title"
        const setMatch = trimmed.match(/^set\s+["']?(.+?)["']?$/i);
        const renameMatch = trimmed.match(/^rename\s+["']?(.+?)["']?$/i);
        const command = trimmed.split(/\s+/)[0].toLowerCase();

        if (setMatch) {
            this.handleSet(setMatch[1]);
        } else if (renameMatch) {
            this.handleRename(renameMatch[1]);
        } else {
            switch (command) {
                case 'clear':
                    this.handleClear();
                    break;
                case 'status':
                    this.handleStatus();
                    break;
                case 'help':
                case '?':
                    this.handleHelp();
                    break;
                case 'exit':
                case 'quit':
                    this.handleExit();
                    break;
                default:
                    console.log(`[Error] Unknown command: ${command}. Type 'help' for available commands.`);
            }
        }

        this.rl.prompt();
    }

    /**
     * Handle 'set' command - set manual title override
     */
    private handleSet(title: string): void {
        if (!title) {
            console.log('[Error] Usage: set "<title>"');
            return;
        }

        if (!this.currentContext) {
            console.log('[Error] No episode currently playing');
            return;
        }

        const override: ManualOverride = {
            title: title,
            context: this.currentContext,
            timestamp: new Date(),
        };

        setManualOverride(override);
        console.log(`[Manual] Title set to: "${title}"`);
        console.log(`[Manual] Active for episode: ${this.currentContext.id}`);
        this.emit('overrideSet', override);
    }

    /**
     * Handle 'rename' command - override the series name for metadata searches
     */
    private handleRename(name: string): void {
        if (!name) {
            console.log('[Error] Usage: rename "<series name>"');
            return;
        }

        if (!this.currentContext) {
            console.log('[Error] No episode currently playing');
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
        this.emit('renameSet', override);
    }

    /**
     * Handle 'clear' command - remove manual override and/or rename
     */
    private handleClear(): void {
        const override = getManualOverride();
        const rename = getSeriesNameOverride();
        
        if (override) {
            clearManualOverride();
            console.log('[Manual] Episode title override cleared');
            this.emit('overrideCleared');
        }
        if (rename) {
            clearSeriesNameOverride();
            console.log('[Manual] Series name override cleared');
            this.emit('renameCleared');
        }
        if (!override && !rename) {
            console.log('[Manual] No active override to clear');
        }
    }

    /**
     * Handle 'status' command - show current state
     */
    private handleStatus(): void {
        console.log('\n--- Status ---');
        
        // Current episode
        if (this.currentContext) {
            console.log(`Current Episode: ${this.currentContext.id}`);
            console.log(`  Series: ${this.currentContext.seriesName}`);
            if (this.currentContext.seasonNumber !== null) {
                console.log(`  Season: ${this.currentContext.seasonNumber}`);
            }
            console.log(`  Episode: ${this.currentContext.episodeNumber}`);
        } else {
            console.log('Current Episode: None playing');
        }

        // Override status
        const override = getManualOverride();
        if (override) {
            console.log(`\nEpisode Title Override: ACTIVE`);
            console.log(`  Title: "${override.title}"`);
            console.log(`  For Episode: ${override.context.id}`);
            console.log(`  Set At: ${override.timestamp.toLocaleTimeString()}`);
        } else {
            console.log('\nEpisode Title Override: None');
        }

        // Rename status
        const rename = getSeriesNameOverride();
        if (rename) {
            console.log(`\nSeries Name Override: ACTIVE`);
            console.log(`  Name: "${rename.overrideName}"`);
            console.log(`  Set At: ${rename.timestamp.toLocaleTimeString()}`);
        } else {
            console.log('\nSeries Name Override: None');
        }

        // Provider info
        console.log(`\nMetadata Provider: ${providerName}`);
        console.log('--------------\n');
    }

    /**
     * Handle 'help' command - show available commands
     */
    private handleHelp(): void {
        console.log('\n--- Available Commands ---');
        console.log('  set "<title>"     - Override the current episode title');
        console.log('  rename "<name>"   - Override the series name (for metadata search)');
        console.log('  clear             - Remove all active overrides');
        console.log('  status            - Display current state and override info');
        console.log('  help              - Show this help message');
        console.log('  exit              - Quit the application');
        console.log('--------------------------\n');
    }

    /**
     * Handle 'exit' command - graceful shutdown
     */
    private handleExit(): void {
        console.log('[System] Exiting...');
        this.rl.close();
        this.emit('exit');
    }

    /**
     * Close the REPL interface
     */
    close(): void {
        this.rl.close();
    }
}

/**
 * Resolve the display title, applying manual override if active
 */
export function resolveDisplayTitle(
    autoTitle: string,
    episodeContext: EpisodeContext | null
): { title: string; isOverride: boolean } {
    const override = getManualOverride();

    if (override && episodeContext) {
        if (override.context.id === episodeContext.id) {
            // Override is active for this episode
            return {
                title: override.title,
                isOverride: true,
            };
        } else {
            // Episode changed - invalidate override
            console.log(`[System] Episode changed (${override.context.id} → ${episodeContext.id}). Override auto-cleared.`);
            clearManualOverride();
        }
    }

    return {
        title: autoTitle,
        isOverride: false,
    };
}
