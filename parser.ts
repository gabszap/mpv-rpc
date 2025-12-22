/**
 * Filename Parser Module - Uses GuessIt CLI directly
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ParsedFilename {
    full_title: string;
    series_title: string;
    season: number | null;
    episode: number | null;
    episode_title: string | null;
}

const execFileAsync = promisify(execFile);

/**
 * Call GuessIt CLI directly for parsing
 */
async function callGuessIt(filename: string): Promise<Record<string, any> | null> {
    try {
        const { stdout } = await execFileAsync("guessit", [filename, "--json"], {
            timeout: 15000,
        });
        return JSON.parse(stdout.trim());
    } catch (e) {
        console.error("[Parser] GuessIt CLI error:", e);
        return null;
    }
}

/**
 * Clean up title - remove dots, underscores, etc.
 */
function cleanTitle(title: string): string {
    return title
        .replace(/\./g, " ")  // Replace dots with spaces
        .replace(/_/g, " ")   // Replace underscores with spaces
        .replace(/\s+/g, " ") // Collapse multiple spaces
        .trim();
}

/**
 * Parse a filename using GuessIt CLI
 */
export async function parseFilename(filename: string): Promise<ParsedFilename> {
    if (!filename || filename === "N/A") {
        return {
            full_title: "N/A",
            series_title: "N/A",
            season: null,
            episode: null,
            episode_title: null,
        };
    }

    // Try GuessIt CLI first
    const guessed = await callGuessIt(filename);

    if (guessed) {
        let title = guessed.title || filename;
        title = cleanTitle(title);

        let season = guessed.season ?? null;
        let episode = guessed.episode ?? null;
        const episode_title = guessed.episode_title ?? null;

        // If GuessIt didn't detect season/episode, try regex on original filename
        // Handles cases like "[Judas] Re.Zero - S03E01v2.mkv" where S##E## is in alternative_title
        if (season === null || episode === null) {
            const seMatch = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
            if (seMatch) {
                if (season === null) season = parseInt(seMatch[1], 10);
                if (episode === null) episode = parseInt(seMatch[2], 10);
            }
        }

        // If GuessIt didn't detect season, try to extract from title
        // Handles cases like "3rd Season", "Season 3", "2nd Season", etc.
        if (season === null) {
            const seasonMatch = title.match(/(\d+)(?:st|nd|rd|th)?\s*[Ss]eason|[Ss]eason\s*(\d+)/i);
            if (seasonMatch) {
                season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
                // Remove season part from title for cleaner display
                title = title.replace(/(\d+)(?:st|nd|rd|th)?\s*[Ss]eason|[Ss]eason\s*(\d+)/i, "").trim();
                title = title.replace(/\s+/g, " ").trim(); // Clean up extra spaces
            }
        }

        // Build full formatted title
        let full_title = title;
        if (season !== null && episode !== null) {
            full_title += ` - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
        } else if (episode !== null) {
            full_title += ` - E${String(episode).padStart(2, "0")}`;
        }
        if (episode_title) {
            full_title += ` - ${episode_title}`;
        }

        return {
            full_title,
            series_title: title,
            season,
            episode,
            episode_title,
        };
    }

    // Fallback: regex parsing
    return fallbackParse(filename);
}

/**
 * Fallback regex-based parsing if GuessIt fails
 */
function fallbackParse(filename: string): ParsedFilename {
    let title = cleanTitle(filename);
    let season: number | null = null;
    let episode: number | null = null;

    // Try to extract S##E## pattern
    const seMatch = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (seMatch) {
        season = parseInt(seMatch[1], 10);
        episode = parseInt(seMatch[2], 10);
        // Extract title (everything before S##E##)
        const idx = filename.indexOf(seMatch[0]);
        if (idx > 0) {
            title = cleanTitle(filename.substring(0, idx));
        }
    } else {
        // Try episode only patterns
        const epMatch = filename.match(/(?:Episode\s*|[Ee]|[-_]\s*)(\d{1,3})(?:[^\d]|$)/);
        if (epMatch) {
            episode = parseInt(epMatch[1], 10);
        }
    }

    let full_title = title;
    if (season !== null && episode !== null) {
        full_title += ` - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    } else if (episode !== null) {
        full_title += ` - E${String(episode).padStart(2, "0")}`;
    }

    return {
        full_title,
        series_title: title,
        season,
        episode,
        episode_title: null,
    };
}
