/**
 * Console module - Interactive REPL for manual title overrides
 */

export { ConsoleRepl, resolveDisplayTitle } from './repl';
export {
    EpisodeContext,
    ManualOverride,
    getManualOverride,
    setManualOverride,
    clearManualOverride,
    createEpisodeContext,
} from './types';
