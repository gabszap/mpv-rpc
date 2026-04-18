const { execFileSync } = require("node:child_process");

const commitAnalyzer = require("@semantic-release/commit-analyzer");
const releaseNotesGenerator = require("@semantic-release/release-notes-generator");

const changedFilesByCommit = new Map();

function normalizePath(filePath) {
    return filePath.replace(/\\/g, "/");
}

function getChangedFilesForCommit(commitHash, cwd) {
    if (changedFilesByCommit.has(commitHash)) {
        return changedFilesByCommit.get(commitHash);
    }

    const rawOutput = execFileSync(
        "git",
        ["show", "--pretty=format:", "--name-only", commitHash],
        {
            cwd,
            encoding: "utf8",
        }
    );

    const changedFiles = rawOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(normalizePath);

    changedFilesByCommit.set(commitHash, changedFiles);
    return changedFiles;
}

function getScope(pluginConfig) {
    const releaseScope = pluginConfig.releaseScope;
    if (releaseScope === "root" || releaseScope === "bridge") {
        return releaseScope;
    }

    throw new Error(
        `Invalid releaseScope '${String(releaseScope)}'. Expected 'root' or 'bridge'.`
    );
}

function normalizeBridgePath(pluginConfig) {
    const configuredPath = pluginConfig.bridgePath || "stremio-mpv-bridge";
    const normalizedPath = normalizePath(configuredPath).replace(/\/+$/, "");
    if (!normalizedPath) {
        throw new Error("bridgePath cannot be empty.");
    }

    return `${normalizedPath}/`;
}

function isCommitRelevant(changedFiles, releaseScope, bridgePathPrefix) {
    if (releaseScope === "bridge") {
        return changedFiles.some((filePath) => filePath.startsWith(bridgePathPrefix));
    }

    return changedFiles.some((filePath) => !filePath.startsWith(bridgePathPrefix));
}

function getScopedCommits(pluginConfig, context) {
    const releaseScope = getScope(pluginConfig);
    const bridgePathPrefix = normalizeBridgePath(pluginConfig);
    const commits = Array.isArray(context.commits) ? context.commits : [];
    const relevantCommits = commits.filter((commit) => {
        if (!commit.hash) {
            return true;
        }

        const changedFiles = getChangedFilesForCommit(commit.hash, context.cwd);
        return isCommitRelevant(changedFiles, releaseScope, bridgePathPrefix);
    });

    context.logger.log(
        "Path-scoped release (%s): %d/%d relevant commits.",
        releaseScope,
        relevantCommits.length,
        commits.length
    );

    return relevantCommits;
}

async function analyzeCommits(pluginConfig, context) {
    const scopedCommits = getScopedCommits(pluginConfig, context);
    if (scopedCommits.length === 0) {
        context.logger.log("No relevant commits for this release scope.");
        return null;
    }

    const commitAnalyzerConfig = pluginConfig.commitAnalyzerConfig || {
        preset: "conventionalcommits",
    };

    return commitAnalyzer.analyzeCommits(commitAnalyzerConfig, {
        ...context,
        commits: scopedCommits,
    });
}

async function generateNotes(pluginConfig, context) {
    const scopedCommits = getScopedCommits(pluginConfig, context);
    if (scopedCommits.length === 0) {
        return "";
    }

    const releaseNotesConfig = pluginConfig.releaseNotesConfig || {
        preset: "conventionalcommits",
    };

    return releaseNotesGenerator.generateNotes(releaseNotesConfig, {
        ...context,
        commits: scopedCommits,
    });
}

module.exports = {
    analyzeCommits,
    generateNotes,
};
