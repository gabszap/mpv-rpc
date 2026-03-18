/**
 * Console module - Interactive REPL for manual title overrides
 */

export { ConsoleRepl, resolveDisplayTitle } from './repl';
export {
    EpisodeContext,
    ManualOverride,
    SeriesNameOverride,
    getManualOverride,
    setManualOverride,
    clearManualOverride,
    createEpisodeContext,
    getSeriesNameOverride,
    setSeriesNameOverride,
    clearSeriesNameOverride,
    checkSeriesNameOverride,
} from './types';
