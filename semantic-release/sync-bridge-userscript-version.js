const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const USERSCRIPT_VERSION_LINE_REGEX = /^(\s*\/\/\s*@version\s+)(\S+)(\s*)$/m;

function getUserscriptPath(pluginConfig, context) {
    const configuredPath =
        pluginConfig.userscriptPath || "stremio-mpv-bridge/stremio-mpv.user.js";
    return {
        relativePath: configuredPath,
        absolutePath: path.resolve(context.cwd, configuredPath),
    };
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

async function prepare(pluginConfig, context) {
    const nextVersion = ensureNextVersion(context);
    const { relativePath, absolutePath } = getUserscriptPath(pluginConfig, context);

    let userscriptContent;
    try {
        userscriptContent = await readFile(absolutePath, "utf8");
    } catch (error) {
        throw new Error(
            `Could not read bridge userscript at '${relativePath}': ${error.message}`
        );
    }

    const versionLineMatch = userscriptContent.match(USERSCRIPT_VERSION_LINE_REGEX);
    if (!versionLineMatch) {
        throw new Error(
            `Could not find '// @version' line in bridge userscript: ${relativePath}`
        );
    }

    const updatedUserscriptContent = userscriptContent.replace(
        USERSCRIPT_VERSION_LINE_REGEX,
        `${versionLineMatch[1]}${nextVersion}${versionLineMatch[3]}`
    );

    if (updatedUserscriptContent === userscriptContent) {
        context.logger.log(
            "Bridge userscript @version already set to %s in %s.",
            nextVersion,
            relativePath
        );
        return;
    }

    await writeFile(absolutePath, updatedUserscriptContent, "utf8");
    context.logger.log(
        "Updated bridge userscript @version to %s in %s.",
        nextVersion,
        relativePath
    );
}

module.exports = {
    prepare,
};
