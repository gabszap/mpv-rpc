import type { MpvData } from "../integrations/mpv";

export type CanonicalEpisodePosition = {
    season: number;
    episode: number;
    source: "split-part-rule";
};

type SplitPartRule = {
    seriesPattern: RegExp;
    arcPattern: RegExp;
    canonicalSeason: number;
    partEpisodeCounts: number[];
};

type SplitPartCandidate = {
    normalizedTitle: string;
    part: number;
    episode: number;
};

const SPLIT_PART_RULES: SplitPartRule[] = [
    {
        seriesPattern: /\bdr\s*stone\b/,
        arcPattern: /\bscience\s*future\b/,
        canonicalSeason: 4,
        partEpisodeCounts: [12, 12, 13],
    },
];

function normalizeTitleForCanonicalMapping(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function readPositiveInteger(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return null;
    }

    return value;
}

function stripExtension(filename: string): string {
    return filename.replace(/\.[^.\\/]+$/, "");
}

function getCanonicalTitleCandidates(data: MpvData): string[] {
    const candidates = [data.series_title, data.media_title, stripExtension(data.filename)];
    const seen = new Set<string>();
    const normalizedCandidates: string[] = [];

    for (const candidate of candidates) {
        const normalizedCandidate = normalizeTitleForCanonicalMapping(candidate);
        if (!normalizedCandidate || seen.has(normalizedCandidate)) {
            continue;
        }

        seen.add(normalizedCandidate);
        normalizedCandidates.push(normalizedCandidate);
    }

    return normalizedCandidates;
}

function readSplitPartCandidate(data: MpvData): SplitPartCandidate | null {
    if (readPositiveInteger(data.season)) {
        return null;
    }

    const episode = readPositiveInteger(data.episode);
    if (!episode) {
        return null;
    }

    for (const normalizedTitle of getCanonicalTitleCandidates(data)) {
        const partMatch = normalizedTitle.match(/\bpart\s*(\d+)\b/);
        if (!partMatch) {
            continue;
        }

        const part = Number.parseInt(partMatch[1], 10);
        if (!Number.isInteger(part) || part < 2) {
            continue;
        }

        return { normalizedTitle, part, episode };
    }

    return null;
}

function findSplitPartRule(candidate: SplitPartCandidate): SplitPartRule | null {
    return (
        SPLIT_PART_RULES.find(
            (rule) =>
                rule.seriesPattern.test(candidate.normalizedTitle) && rule.arcPattern.test(candidate.normalizedTitle),
        ) ?? null
    );
}

export function resolveCanonicalSplitPartEpisode(data: MpvData): CanonicalEpisodePosition | null {
    const candidate = readSplitPartCandidate(data);
    if (!candidate) {
        return null;
    }

    const rule = findSplitPartRule(candidate);
    if (!rule) {
        return null;
    }

    const currentPartEpisodeCount = rule.partEpisodeCounts[candidate.part - 1];
    if (currentPartEpisodeCount === undefined || candidate.episode > currentPartEpisodeCount) {
        return null;
    }

    const priorEpisodeCount = rule.partEpisodeCounts
        .slice(0, candidate.part - 1)
        .reduce((total, episodeCount) => total + episodeCount, 0);

    return {
        season: rule.canonicalSeason,
        episode: priorEpisodeCount + candidate.episode,
        source: "split-part-rule",
    };
}
