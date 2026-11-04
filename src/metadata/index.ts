/**
 * Metadata Module - Handles metadata resolution and fallback chains
 */

export {
    type ApiMetadata,
    type FallbackContext,
    type FallbackStrategy,
    getFallbackStrategy,
    isGenericTitle,
    resolveEpisodeTitle,
    resolveTitleWithFallback,
} from "./fallbackResolver";
