module.exports = {
    branches: ["main"],
    tagFormat: "bridge-v${version}",
    plugins: [
        [
            "./semantic-release/path-scoped-release.js",
            {
                releaseScope: "bridge",
                bridgePath: "stremio-mpv-bridge",
                commitAnalyzerConfig: {
                    preset: "conventionalcommits",
                },
                releaseNotesConfig: {
                    preset: "conventionalcommits",
                },
            },
        ],
        [
            "@semantic-release/changelog",
            {
                changelogFile: "stremio-mpv-bridge/CHANGELOG.md",
            },
        ],
        [
            "@semantic-release/npm",
            {
                npmPublish: false,
                pkgRoot: "stremio-mpv-bridge",
            },
        ],
        "./semantic-release/sync-bridge-userscript-version.js",
        "@semantic-release/github",
        [
            "@semantic-release/git",
            {
                assets: [
                    "stremio-mpv-bridge/CHANGELOG.md",
                    "stremio-mpv-bridge/package.json",
                    "stremio-mpv-bridge/package-lock.json",
                    "stremio-mpv-bridge/stremio-mpv.user.js",
                ],
                message:
                    "chore(release): bridge ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
            },
        ],
    ],
};
