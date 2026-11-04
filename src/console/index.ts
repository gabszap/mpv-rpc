/**
 * Console module - Interactive REPL for manual title overrides
 */

export { ConsoleRepl, resolveDisplayTitle } from "./repl";
export {
    checkSeriesNameOverride,
    clearManualOverride,
    clearSeriesNameOverride,
    createEpisodeContext,
    EpisodeContext,
    getManualOverride,
    getSeriesNameOverride,
    ManualOverride,
    SeriesNameOverride,
    setManualOverride,
    setSeriesNameOverride,
} from "./types";
