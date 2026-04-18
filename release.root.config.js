module.exports = {
    branches: ["main"],
    tagFormat: "mpv-rpc-v${version}",
    plugins: [
        [
            "./semantic-release/path-scoped-release.js",
            {
                releaseScope: "root",
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
                changelogFile: "CHANGELOG.md",
            },
        ],
        [
            "@semantic-release/npm",
            {
                npmPublish: false,
            },
        ],
        "@semantic-release/github",
        [
            "@semantic-release/git",
            {
                assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
                message:
                    "chore(release): mpv-rpc ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
            },
        ],
    ],
};
