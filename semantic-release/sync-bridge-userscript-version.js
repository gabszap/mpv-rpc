const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const USERSCRIPT_VERSION_LINE_REGEX = /^(\s*\/\/\s*@version\s+)(\S+)(\s*)$/m;

const DEFAULT_USERSCRIPT_PATHS = [
    "stremio-mpv-bridge/userscript/header.txt",
    "stremio-mpv-bridge/stremio-mpv.user.js",
];

function getUserscriptPaths(pluginConfig, context) {
    const configuredPaths = pluginConfig.userscriptPaths ||
        (pluginConfig.userscriptPath ? [pluginConfig.userscriptPath] : DEFAULT_USERSCRIPT_PATHS);
    return configuredPaths.map((relativePath) => ({
        relativePath,
        absolutePath: path.resolve(context.cwd, relativePath),
    }));
}

function ensureNextVersion(context) {
    const nextVersion = context.nextRelease && context.nextRelease.version;
    if (!nextVersion) {
        throw new Error(
            "Missing nextRelease.version in semantic-release context for bridge userscript sync."
        );
    }

    return nextVersion;
}

async function syncVersionInFile(nextVersion, { relativePath, absolutePath }, context) {
    let content;
    try {
        content = await readFile(absolutePath, "utf8");
    } catch (error) {
        throw new Error(
            `Could not read bridge userscript file at '${relativePath}': ${error.message}`
        );
    }

    const versionLineMatch = content.match(USERSCRIPT_VERSION_LINE_REGEX);
    if (!versionLineMatch) {
        throw new Error(
            `Could not find '// @version' line in bridge userscript file: ${relativePath}`
        );
    }

    const updatedContent = content.replace(
        USERSCRIPT_VERSION_LINE_REGEX,
        `${versionLineMatch[1]}${nextVersion}${versionLineMatch[3]}`
    );

    if (updatedContent === content) {
        context.logger.log(
            "Bridge userscript @version already set to %s in %s.",
            nextVersion,
            relativePath
        );
        return;
    }

    await writeFile(absolutePath, updatedContent, "utf8");
    context.logger.log(
        "Updated bridge userscript @version to %s in %s.",
        nextVersion,
        relativePath
    );
}

async function prepare(pluginConfig, context) {
    const nextVersion = ensureNextVersion(context);
    // The header source and the bundled output both carry the @version line;
    // updating both keeps `npm run build:userscript` reproducible after a release.
    for (const target of getUserscriptPaths(pluginConfig, context)) {
        await syncVersionInFile(nextVersion, target, context);
    }
}

module.exports = {
    prepare,
};
