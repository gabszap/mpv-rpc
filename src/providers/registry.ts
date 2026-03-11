// src/providers/registry.ts
export interface FallbackStrategy {
    skipFields: string[];
    useFields: string[];
    descriptionMaxLength?: number;
}

export const DEFAULT_STRATEGY: FallbackStrategy = {
    skipFields: [],
    useFields: ['title'],
    descriptionMaxLength: 0
};

const EDGE_CASE_PROVIDERS: Record<string, FallbackStrategy> = {
    'brazucatorrents': {
        skipFields: ['title', 'filename'],
        useFields: ['description', 'file_path'],
        descriptionMaxLength: 60
    }
};

export function getFallbackStrategy(providerName: string): FallbackStrategy {
    return EDGE_CASE_PROVIDERS[providerName.toLowerCase()] || DEFAULT_STRATEGY;
}
