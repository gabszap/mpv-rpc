/**
 * Metadata Module - Handles metadata resolution and fallback chains
 */

export {
    isGenericTitle,
    resolveTitleWithFallback,
    resolveEpisodeTitle,
    getFallbackStrategy,
    type ApiMetadata,
    type FallbackContext,
    type FallbackStrategy,
} from './fallbackResolver';
