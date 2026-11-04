const CONJUNCTION_STOP_WORDS = new Set(["and", "e", "y", "und", "et"]);
const YEAR_TOKEN_PATTERN = /^(?:19|20)\d{2}$/;
const PARENTHESIZED_YEAR_PATTERN = /\(\s*(?:19|20)\d{2}\s*\)/g;

/**
 * Drops bare years and conjunction stop words from already-split tokens.
 * Falls back to the raw tokens when filtering would leave nothing.
 */
export function filterTitleStopTokens(tokens: string[]): string[] {
    const filtered = tokens.filter((token) => !YEAR_TOKEN_PATTERN.test(token) && !CONJUNCTION_STOP_WORDS.has(token));
    return filtered.length > 0 ? filtered : tokens;
}

/**
 * Lowercases a title, strips "(YYYY)" suffixes and punctuation, and returns
 * comparison tokens without years or conjunction stop words.
 */
export function normalizeTitleTokens(title: string): string[] {
    const rawTokens = title
        .replace(PARENTHESIZED_YEAR_PATTERN, " ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
    return filterTitleStopTokens(rawTokens);
}
