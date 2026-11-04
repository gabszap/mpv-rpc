// Stream parsing, release group / season detection and best-stream scoring.

import { log } from "./logging.js";
import { settings } from "./settings.js";

function extractStreamLeafFilename(stream) {
    if (typeof stream?.behaviorHints?.filename === "string" && stream.behaviorHints.filename.trim().length > 0) {
        const parts = stream.behaviorHints.filename.trim().split(/[\\/]/);
        return parts[parts.length - 1].trim();
    }

    const text = [stream?.title, stream?.description]
        .filter((v) => typeof v === "string" && v.trim().length > 0)
        .join("\n");
    if (!text) {
        return "";
    }

    const lines = text
        .split(/\r?\n|\\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    for (let i = lines.length - 1; i >= 0; i--) {
        const cleanedLine = lines[i].replace(/^📁\s*/u, "").trim();
        if (/\.(?:mkv|mp4|avi|webm|m4v|ts)$/i.test(cleanedLine) || lines[i].includes("📁")) {
            const parts = cleanedLine.split(/[\\/]/);
            return parts[parts.length - 1].trim();
        }
    }

    const firstLineParts = lines[0].split(/[\\/]/);
    return firstLineParts[firstLineParts.length - 1].trim();
}

function parseSingleStream(stream) {
    let url = stream.url || stream.externalUrl;
    if (!url && stream.infoHash) {
        url = `magnet:?xt=urn:btih:${stream.infoHash}`;
        if (stream.sources)
            stream.sources.forEach((s) => {
                url += `&tr=${encodeURIComponent(s)}`;
            });
    }

    const leafFilename = extractStreamLeafFilename(stream);
    let title =
        stream.behaviorHints?.filename ||
        (leafFilename ? leafFilename : null) ||
        (stream.title ? stream.title.split("\n")[0].split("\\n")[0] : null) ||
        (stream.description ? stream.description.split("\n")[0].split("\\n")[0] : null) ||
        stream.name ||
        "Video";
    if (title.length > 200) title = `${title.substring(0, 200)}...`;

    return { url, title };
}

function getQualityAliases(quality) {
    const q = quality.toLowerCase();
    if (q === "4k" || q === "2160p") return ["4k", "2160p"];
    if (q === "2k" || q === "1440p") return ["2k", "1440p"];
    if (q === "fhd" || q === "1080p") return ["fhd", "1080p"];
    if (q === "hd" || q === "720p") return ["hd", "720p"];
    return [q];
}

const TECHNICAL_BRACKET_TAGS = new Set([
    "1080p",
    "720p",
    "2160p",
    "1440p",
    "480p",
    "4k",
    "2k",
    "fhd",
    "hd",
    "hevc",
    "avc",
    "x264",
    "x265",
    "h264",
    "h265",
    "10bit",
    "8bit",
    "hdr",
    "dv",
    "web-dl",
    "webrip",
    "bluray",
    "bdrip",
    "aac",
    "eac3",
    "ac3",
    "flac",
    "multisub",
    "dual-audio",
    "dual audio",
    "dublado",
    "legendado",
    "tb+",
    "rd+",
    "ad+",
    "pm+",
    "dl",
]);

const ROMAN_SEASON_MAP = {
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
};

export function extractReleaseGroup(text) {
    if (typeof text !== "string" || text.trim().length === 0) {
        return null;
    }

    // 1. Check 🏷️ Tag format used by AIOStreams / Comet / Stremio addons (e.g. "🏷️ DB", "🏷️ VARYG")
    const tagIconMatch = text.match(/(?:🏷️?|🏷)\s*([A-Za-z0-9._-]{2,25})/u);
    if (tagIconMatch) {
        const candidate = tagIconMatch[1].trim().toLowerCase();
        if (candidate && !TECHNICAL_BRACKET_TAGS.has(candidate)) {
            return candidate;
        }
    }

    const lines = text
        .split(/\r?\n|\\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    // Prioritize 📁 filename lines, then other lines
    const orderedLines = [
        ...lines.filter((line) => line.includes("📁") || /\.(?:mkv|mp4|avi|webm|m4v|ts)$/i.test(line)),
        ...lines,
    ];

    for (const rawLine of orderedLines) {
        const lineParts = rawLine.replace(/^📁\s*/u, "").split(/[\\/]/);
        const leafLine = lineParts[lineParts.length - 1].trim();

        const bracketMatches = leafLine.matchAll(/\[([^[\]]{2,30})\]/g);
        for (const match of bracketMatches) {
            const candidate = match[1].trim().toLowerCase();
            if (!candidate || TECHNICAL_BRACKET_TAGS.has(candidate) || /^[0-9a-f]{8}$/i.test(candidate)) {
                continue;
            }
            if (/^\d{3,4}p$/i.test(candidate) || /season/i.test(candidate) || /audio/i.test(candidate)) {
                continue;
            }
            return candidate;
        }

        const withoutExtension = leafLine.replace(/\.(?:mkv|mp4|avi|webm|m4v|ts)$/i, "");
        const suffixMatch = withoutExtension.match(/(?:^|[\s._])-([A-Za-z0-9]{2,20})$/);
        if (suffixMatch) {
            const candidate = suffixMatch[1].trim().toLowerCase();
            if (!TECHNICAL_BRACKET_TAGS.has(candidate) && !/^\d+$/i.test(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function inferSeasonFromTitlePrefix(titlePrefix) {
    if (!titlePrefix) {
        return null;
    }

    const cleaned = titlePrefix
        .replace(/^\[[^[\]]+\]\s*/g, "")
        .replace(/[._]+/g, " ")
        .trim();

    if (/\b(?:bridon\s+arc|yingdu\s+pian)\b/i.test(cleaned)) {
        return 3;
    }

    const explicitSeasonMatch =
        cleaned.match(/\bseason\s*0*(\d{1,2})\b/i) ||
        cleaned.match(/\b(\d{1,2})(?:nd|rd|th)\s+season\b/i) ||
        cleaned.match(/\bs0*(\d{1,2})\b/i);
    if (explicitSeasonMatch) {
        return Number.parseInt(explicitSeasonMatch[1], 10);
    }

    const romanMatch = cleaned.match(/\b(ii|iii|iv|v|vi)\s*$/i);
    if (romanMatch) {
        return ROMAN_SEASON_MAP[romanMatch[1].toLowerCase()] ?? null;
    }

    return null;
}

function evaluateStreamEpisodeMatch(stream, targetSeason, targetEpisode, seriesName = null) {
    if (!Number.isInteger(targetSeason) || targetSeason < 1 || !Number.isInteger(targetEpisode) || targetEpisode < 1) {
        return "neutral";
    }

    const leafFilename = extractStreamLeafFilename(stream);
    const candidateText =
        leafFilename ||
        [stream?.behaviorHints?.filename, stream?.title, stream?.description, stream?.name]
            .filter((v) => typeof v === "string" && v.trim().length > 0)
            .join("\n");
    if (!candidateText) {
        return "neutral";
    }

    const explicitPairs = [];
    for (const match of candidateText.matchAll(/\bS0*(\d{1,2})[\s._-]*E0*(\d{1,3})\b/gi)) {
        const prefixBeforeMatch = candidateText.slice(0, match.index ?? 0);
        const prefixSeason = inferSeasonFromTitlePrefix(prefixBeforeMatch);
        let effectiveSeason = Number.parseInt(match[1], 10);

        if (effectiveSeason === 1 && prefixSeason !== null && prefixSeason !== 1) {
            effectiveSeason = prefixSeason;
        } else if (effectiveSeason === 1 && targetSeason === 1 && typeof seriesName === "string" && seriesName.trim()) {
            const normSeries = seriesName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .trim();
            const normPrefix = prefixBeforeMatch
                .replace(/^\[[^[\]]+\]\s*/g, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .trim();
            if (normSeries && normPrefix.startsWith(`${normSeries} `) && normPrefix.length > normSeries.length + 2) {
                const extraWords = normPrefix.slice(normSeries.length).trim();
                if (/\b(?:arc|pian|part|cour|chapter|hen)\b/i.test(extraWords)) {
                    effectiveSeason = -1;
                }
            }
        }

        explicitPairs.push({
            season: effectiveSeason,
            episode: Number.parseInt(match[2], 10),
        });
    }
    for (const match of candidateText.matchAll(/(?<!\d)0*(\d{1,2})x0*(\d{1,3})(?!\d)/gi)) {
        explicitPairs.push({
            season: Number.parseInt(match[1], 10),
            episode: Number.parseInt(match[2], 10),
        });
    }

    if (explicitPairs.length > 0) {
        const hasExactMatch = explicitPairs.some(
            (pair) => pair.season === targetSeason && pair.episode === targetEpisode,
        );
        return hasExactMatch ? "exact" : "mismatch";
    }

    // Check anime-style "<Title> - <Episode>" or "<Title>_-_<Episode>_" in leafFilename
    if (leafFilename) {
        const normalizedLeaf = leafFilename
            .replace(/\.(?:mkv|mp4|avi|webm|m4v|ts)$/i, "")
            .replace(/^\[[^[\]]+\]\s*/g, "")
            .replace(/_/g, " ");
        const dashEpMatch = normalizedLeaf.match(/^(.*?)\s*-\s*0*(\d{1,3})(?:v\d+)?(?:\s|\(|\[|$)/i);
        if (dashEpMatch) {
            const titlePart = dashEpMatch[1].trim();
            const parsedEp = Number.parseInt(dashEpMatch[2], 10);
            if (parsedEp !== targetEpisode) {
                return "mismatch";
            }
            const inferredSeason = inferSeasonFromTitlePrefix(titlePart);
            if (inferredSeason !== null) {
                return inferredSeason === targetSeason ? "exact" : "mismatch";
            }
            if (targetSeason === 1) {
                return "exact";
            }
            if (typeof seriesName === "string" && seriesName.trim()) {
                const normSeries = seriesName
                    .toLowerCase()
                    .replace(/['’`´]+/g, "")
                    .replace(/[^a-z0-9]+/g, " ")
                    .trim();
                const normTitlePart = titlePart
                    .toLowerCase()
                    .replace(/['’`´]+/g, "")
                    .replace(/[^a-z0-9]+/g, " ")
                    .trim();
                if (normSeries && normTitlePart === normSeries) {
                    return "mismatch";
                }
            }
            return "exact";
        }
    }

    const hasSeasonRange = /\b(?:season\s*|s)0*\d{1,2}\s*-\s*(?:season\s*|s)?0*\d{1,2}\b/i.test(candidateText);
    if (!hasSeasonRange) {
        const explicitSeasons = [];
        for (const match of candidateText.matchAll(/\b(?:season\s+|s0*)(\d{1,2})\b/gi)) {
            explicitSeasons.push(Number.parseInt(match[1], 10));
        }
        if (explicitSeasons.length > 0 && !explicitSeasons.includes(targetSeason)) {
            return "mismatch";
        }
    }

    return "neutral";
}

export function findBestStream(
    streams,
    targetSeason = null,
    targetEpisode = null,
    fallbackGroup = null,
    seriesName = null,
) {
    if (!streams?.length) return null;

    const validStreams = streams.filter((s) => (s.url || s.externalUrl || "").startsWith("http") || s.infoHash);
    if (!validStreams.length) return null;

    const episodeMatchByStream = new Map();
    for (const s of validStreams) {
        episodeMatchByStream.set(s, evaluateStreamEpisodeMatch(s, targetSeason, targetEpisode, seriesName));
    }

    const candidateStreams = validStreams.filter((s) => episodeMatchByStream.get(s) !== "mismatch");
    if (!candidateStreams.length) return null;

    const preferredGroups = (settings.preferredGroup || "")
        .split(",")
        .map((g) => g.trim().toLowerCase())
        .filter((g) => g.length > 0);
    const inferredGroup =
        preferredGroups.length === 0 && typeof fallbackGroup === "string" ? fallbackGroup.trim().toLowerCase() : "";
    const selectedQualities = (settings.preferredQuality || "")
        .split(",")
        .map((q) => q.trim().toLowerCase())
        .filter((q) => q.length > 0);
    const hasEpisodeMatchSignal = candidateStreams.some((s) => episodeMatchByStream.get(s) === "exact");

    if (
        preferredGroups.length > 0 ||
        inferredGroup.length > 0 ||
        selectedQualities.length > 0 ||
        hasEpisodeMatchSignal
    ) {
        let bestStream = candidateStreams[0];
        let bestScore = -1;

        for (const s of candidateStreams) {
            const t = [s.behaviorHints?.filename, s.title, s.description, s.name, s.id]
                .filter((v) => typeof v === "string")
                .join(" ")
                .toLowerCase();
            const normalizedTitle = t.replace(/[[\]]/g, "");
            let score = 0;

            if (episodeMatchByStream.get(s) === "exact") {
                score += 3;
            }

            if (preferredGroups.length > 0) {
                if (preferredGroups.some((g) => normalizedTitle.includes(g.replace(/[[\]]/g, "")))) {
                    score += 4;
                }
            } else if (inferredGroup.length > 0) {
                const streamGroup = extractReleaseGroup(
                    s.behaviorHints?.filename || s.title || s.description || s.name || "",
                );
                if (streamGroup === inferredGroup || normalizedTitle.includes(inferredGroup.replace(/[[\]]/g, ""))) {
                    score += 2;
                }
            }

            if (selectedQualities.length > 0) {
                const matched = selectedQualities.some((q) => {
                    const aliases = getQualityAliases(q);
                    return aliases.some((alias) => t.includes(alias));
                });
                if (matched) {
                    score += 1;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestStream = s;
            }
        }

        if (bestStream) {
            log(`Found preferred stream matching criteria (Score: ${bestScore > -1 ? bestScore : 0})`);
            return parseSingleStream(bestStream);
        }
    }

    return parseSingleStream(candidateStreams[0]);
}
