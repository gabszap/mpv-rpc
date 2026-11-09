export interface ResolvedMetadata {
    coverImage: string | null;
    seriesTitle: string;
    episodeTitle: string | null;
    malId: number | null;
    totalEpisodes: number | null;
    adjustedEpisode: number | null;
    metadataSourceProvider: string | null;
    mediaKind?: "movie" | "series";
    year?: number | null;
}

export interface RouteInput {
    parsedMediaType: "anime" | "series" | "unknown";
    stremioType: "movie" | "series" | undefined;
}

export type PipelineName = "anime" | "media";

export interface MetadataPipelines {
    anime: () => Promise<ResolvedMetadata | null>;
    media: () => Promise<ResolvedMetadata | null>;
}

const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
    if (warnedMessages.has(message)) return;
    warnedMessages.add(message);
    console.warn(message);
}

/**
 * Decides which pipeline runs first and which one is the fallback:
 * 1. Stremio says movie -> media, then anime.
 * 2. The parser marked the file as anime -> anime only.
 * 3. Anything else -> media, then anime.
 */
export function planMetadataRoute(input: RouteInput): { first: PipelineName; fallback: PipelineName | null } {
    if (input.stremioType === "movie") return { first: "media", fallback: "anime" };
    if (input.parsedMediaType === "anime") return { first: "anime", fallback: null };
    return { first: "media", fallback: "anime" };
}

async function runPipeline(name: PipelineName, pipelines: MetadataPipelines): Promise<ResolvedMetadata | null> {
    if (name === "anime") return pipelines.anime();
    try {
        return await pipelines.media();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnOnce(`[Metadata] Media pipeline failed (${message}); falling back to the anime pipeline`);
        return null;
    }
}

export async function routeMetadata(
    input: RouteInput,
    pipelines: MetadataPipelines,
): Promise<{ result: ResolvedMetadata | null; pipeline: PipelineName | null }> {
    const plan = planMetadataRoute(input);

    const first = await runPipeline(plan.first, pipelines);
    if (first) return { result: first, pipeline: plan.first };

    if (plan.fallback) {
        const fallback = await runPipeline(plan.fallback, pipelines);
        if (fallback) return { result: fallback, pipeline: plan.fallback };
    }
    return { result: null, pipeline: null };
}
