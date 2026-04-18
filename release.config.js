const releaseScope = process.env.RELEASE_SCOPE;

if (releaseScope === "bridge") {
    module.exports = require("./release.bridge.config.js");
} else {
    module.exports = require("./release.root.config.js");
}
