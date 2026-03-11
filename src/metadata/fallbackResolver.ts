/**
 * Fallback Resolver Module
 * Handles edge-case providers that return empty or generic titles
 * Implements a priority-based fallback chain for title resolution
 */

/**
 * Patterns that match generic/placeholder titles that should trigger fallback
 */
const GENERIC_TITLES: RegExp[] = [
    /^(video|episode|episodio|episódio|ep|capitulo|capítulo)$/i,
    /^\d+$/,                        // Just a number like "0", "1", "25"
    /^untitled$/i,
    /^(unknown|desconhecido)$/i,
    /^\s*$/,                        // Empty/whitespace only
    /^(media|arquivo|file)$/i,
    /^track\s*\d*$/i,               // "Track", "Track 1"
    /^title\s*\d*$/i,               // "Title", "Title 1"
];

/**
 * Metadata from API responses
 */
export interface ApiMetadata {
    title?: string | null;
    description?: string | null;
    synopsis?: string | null;
}

/**
 * Context for fallback resolution
 */
export interface FallbackContext {
    filenameTitle: string | null;       // Title parsed from filename
    apiMetadata: ApiMetadata;           // Metadata from API
    rawFilename: string | null;         // Original filename (basename without extension)
}

/**
 * Strategy for handling edge-case providers
 */
export interface FallbackStrategy {
    skipFields: string[];               // Fields to skip (always generic)
    useFields: string[];                // Fields to prefer
    descriptionMaxLength: number;       // Max length for description fallback
}

/**
 * Default fallback strategy
 */
const DEFAULT_STRATEGY: FallbackStrategy = {
    skipFields: [],
    useFields: ['title', 'description'],
    descriptionMaxLength: 50,
};

/**
 * Registry of known problematic providers with custom strategies
 */
const EDGE_CASE_PROVIDERS: Record<string, FallbackStrategy> = {
    'brazucatorrents': {
        skipFields: ['title', 'filename'],
        useFields: ['description', 'file_path'],
        descriptionMaxLength: 60,
    },
    'brazuca': {
        skipFields: ['title', 'filename'],
        useFields: ['description', 'file_path'],
        descriptionMaxLength: 60,
    },
};

/**
 * Check if a title is generic/placeholder
 * @param title The title to check
 * @returns true if the title matches any generic pattern
 */
export function isGenericTitle(title: string | null | undefined): boolean {
    if (!title) return true;
    
    const trimmed = title.trim();
    if (trimmed.length === 0) return true;
    
    return GENERIC_TITLES.some(pattern => pattern.test(trimmed));
}

/**
 * Extract first sentence from description text
 * @param text The text to extract from
 * @param maxLength Maximum length to return
 * @returns Truncated first sentence
 */
function extractFirstSentence(text: string, maxLength: number): string {
    // Split by sentence-ending punctuation
    const firstSentence = text.split(/[.!?]/)[0].trim();
    
    if (firstSentence.length <= maxLength) {
        return firstSentence;
    }
    
    // Find last word boundary before maxLength
    const truncated = firstSentence.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    
    if (lastSpace > maxLength * 0.5) {
        return truncated.substring(0, lastSpace) + '...';
    }
    
    return truncated + '...';
}

/**
 * Get fallback strategy for a provider
 * @param providerName Name of the provider (optional)
 * @returns Fallback strategy to use
 */
export function getFallbackStrategy(providerName?: string): FallbackStrategy {
    if (!providerName) return DEFAULT_STRATEGY;
    
    const normalized = providerName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return EDGE_CASE_PROVIDERS[normalized] || DEFAULT_STRATEGY;
}

/**
 * Resolve episode title using fallback chain
 * 
 * Priority:
 * 1. Parsed filename title (if not generic)
 * 2. API response title field (if not generic)
 * 3. API response description/synopsis (truncated)
 * 4. Raw filename (basename without extension)
 * 5. "Unknown Episode"
 * 
 * @param context Fallback context with all available data
 * @param providerName Optional provider name for custom strategies
 * @returns Resolved title with source indicator
 */
export function resolveTitleWithFallback(
    context: FallbackContext,
    providerName?: string
): { title: string; source: string } {
    const strategy = getFallbackStrategy(providerName);
    
    // Priority 1: Filename title (if not generic)
    if (!strategy.skipFields.includes('filename') && 
        context.filenameTitle && 
        !isGenericTitle(context.filenameTitle)) {
        return { title: context.filenameTitle, source: 'filename' };
    }
    
    // Priority 2: API title (if not generic)
    if (!strategy.skipFields.includes('title') && 
        context.apiMetadata.title && 
        !isGenericTitle(context.apiMetadata.title)) {
        return { title: context.apiMetadata.title, source: 'api-title' };
    }
    
    // Priority 3: Description/synopsis fallback
    const description = context.apiMetadata.description || context.apiMetadata.synopsis;
    if (description && description.trim().length > 0) {
        const truncated = extractFirstSentence(description.trim(), strategy.descriptionMaxLength);
        if (truncated.length > 5 && !isGenericTitle(truncated)) {
            return { title: truncated, source: 'api-description' };
        }
    }
    
    // Priority 4: Raw filename
    if (context.rawFilename && context.rawFilename.trim().length > 0) {
        const cleaned = context.rawFilename
            .replace(/\.[^.]+$/, '')  // Remove extension if present
            .replace(/[._-]+/g, ' ')  // Replace separators with spaces
            .trim();
        
        if (cleaned.length > 0 && !isGenericTitle(cleaned)) {
            return { title: cleaned, source: 'raw-filename' };
        }
    }
    
    // Priority 5: Ultimate fallback
    return { title: 'Unknown Episode', source: 'fallback' };
}

/**
 * Resolve episode title with simplified interface
 * Returns just the title string for easy integration
 * 
 * @param filenameTitle Title from filename parsing
 * @param apiTitle Title from API response
 * @param apiDescription Description from API response (optional)
 * @param rawFilename Original filename (optional)
 * @returns Resolved title
 */
export function resolveEpisodeTitle(
    filenameTitle: string | null,
    apiTitle: string | null,
    apiDescription?: string | null,
    rawFilename?: string | null
): string {
    const context: FallbackContext = {
        filenameTitle,
        apiMetadata: {
            title: apiTitle,
            description: apiDescription,
        },
        rawFilename: rawFilename || null,
    };
    
    const result = resolveTitleWithFallback(context);
    
    // Log when fallback is used (for debugging)
    if (result.source !== 'filename' && result.source !== 'api-title') {
        console.log(`[Fallback] Episode title resolved from ${result.source}: "${result.title}"`);
    }
    
    return result.title;
}
