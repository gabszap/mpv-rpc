# Changelog

This file is managed by semantic-release.

## [1.12.0](https://github.com/gabszap/mpv-rpc/compare/bridge-v1.11.0...bridge-v1.12.0) (2026-11-04)

### Features

* **bridge-ui:** restrict button visibility by Stremio route ([725aa2f](https://github.com/gabszap/mpv-rpc/commit/725aa2fc11e32fd06c5f0f697e691c32f59069e4))
* **bridge:** add config schema versioning and strict validation ([6e29bda](https://github.com/gabszap/mpv-rpc/commit/6e29bda33831b156b2528c205b94b03c53af5f71))
* **bridge:** improve stream selection and quality alias handling ([d6b6c5b](https://github.com/gabszap/mpv-rpc/commit/d6b6c5bb9c37d6b43ed3e6eb68656f2e1e29d23c))
* **bridge:** map equivalent quality aliases for stream selection ([6185cf3](https://github.com/gabszap/mpv-rpc/commit/6185cf344c5631d14e153a70f2742836d1b14c9d))
* **bridge:** skip unreleased targets and optimize auto-fetch cooldowns ([69d4a36](https://github.com/gabszap/mpv-rpc/commit/69d4a36179bc363886e79c3087f7ebefa29219fe))
* **core:** add .reload REPL command for live config changes ([8572133](https://github.com/gabszap/mpv-rpc/commit/8572133101289695a1d0cfecec17f3699259b5f2))
* **core:** Phase 5 - iconMode enum, Discord title filter, graceful disconnect ([bfd536d](https://github.com/gabszap/mpv-rpc/commit/bfd536d7bae82150d0e47f9b21c61591d3b1a717))

### Bug Fixes

* add icon mode enum and Discord URL filtering ([ef5243e](https://github.com/gabszap/mpv-rpc/commit/ef5243e817663940adfdcf4544502b7eccdaf290))
* **auto-fetch:** preserve context across playlist handoff ([8f09538](https://github.com/gabszap/mpv-rpc/commit/8f09538d75d2f39ce4bd909929130038e3821f6c))
* **bridge-ui:** disable torbox and add stremthru and intell debrid services ([1472d35](https://github.com/gabszap/mpv-rpc/commit/1472d35a43b969dfbb474cc2088657b312a35342))
* **bridge-ui:** resolve layout shifts and tab button size inconsistencies ([fd1056a](https://github.com/gabszap/mpv-rpc/commit/fd1056add58a3d9390ed923e77913103a0bf1418))
* **bridge:** fix compact config icon alignment and positioning on navigation ([e9e46d5](https://github.com/gabszap/mpv-rpc/commit/e9e46d5c42a5f5ac75de39161e78b2a2a0a5e4ee))
* **bridge:** increase stream fetch timeout to 25s ([099cf01](https://github.com/gabszap/mpv-rpc/commit/099cf01ac7d04adfc440489235138f777ae69c59))
* **bridge:** make auto-fetch idempotent ([cd8deca](https://github.com/gabszap/mpv-rpc/commit/cd8decade59cf5c15efa7ffd3caaaff185fe787e))
* **bridge:** restore userscript stream selection changes dropped in merge ([ada181d](https://github.com/gabszap/mpv-rpc/commit/ada181d87733df938c49376335ba496eed62e24e)), closes [#10](https://github.com/gabszap/mpv-rpc/issues/10)
* **bridge:** track the userscript build script ignored by .gitignore ([f3fdb2a](https://github.com/gabszap/mpv-rpc/commit/f3fdb2a8d54fcfcc3e634711baf137b2f5487673))
* cover MAL dry-run and polish bridge settings ([5362745](https://github.com/gabszap/mpv-rpc/commit/5362745c1599a0dc1eb986b37e5bd9b2edc6ab2f))
* harden parser, bridge config, and dry-run sync ([475d7fc](https://github.com/gabszap/mpv-rpc/commit/475d7fc24e6ec2d2de4a977857fc219faca604ff))
* improve bridge icon modes and config sync ([84cb269](https://github.com/gabszap/mpv-rpc/commit/84cb2699faba9a76a074d6cb4dca93f0e4bf8c60))
* refine bridge controls and auto-fetch toggles ([4847084](https://github.com/gabszap/mpv-rpc/commit/4847084f5d86fb92e100657920fc2a86ac5380b6))
* **userscript:** align compact icon with fullscreen button ([2c21d49](https://github.com/gabszap/mpv-rpc/commit/2c21d49acd25ad2d8dd23a964397aa7dafc4dbb0))
* **userscript:** reposition compact icon on SPA navigation ([f022dee](https://github.com/gabszap/mpv-rpc/commit/f022dee964ab911ce9124704ca11a53f700dd0b7))

## [1.11.0](https://github.com/gabszap/mpv-rpc/compare/bridge-v1.10.0...bridge-v1.11.0) (2026-11-04)

### Features

* **bridge:** add auto-fetch and config persistence endpoints ([ab52a30](https://github.com/gabszap/mpv-rpc/commit/ab52a30b6206761854a680c402ab96b60eeacc03))
* **stremio-sync:** add Continue Watching sync with Stremio API ([2d1804a](https://github.com/gabszap/mpv-rpc/commit/2d1804a23b582c05eb5bcfd31964152a4e3752a7))
* **userscript:** improve series name detection and config sync ([a916a63](https://github.com/gabszap/mpv-rpc/commit/a916a6343e64ebfe3c8db6057f05a6483102d950))

### Bug Fixes

* add auto-fetch deduplication and unify config defaults ([a2affbd](https://github.com/gabszap/mpv-rpc/commit/a2affbdb25d37a0d381a25d5f2a0720b29a30c7c))
* **release:** deduplicate bridge changelog header [skip ci] ([5085fab](https://github.com/gabszap/mpv-rpc/commit/5085fabe3f00b0eaff7092425714c771eda9231c))

## [1.10.0](https://github.com/gabszap/mpv-rpc/compare/bridge-v1.9.0...bridge-v1.10.0) (2026-04-25)

### Features

* **bridge-userscript:** implement stacked toast notifications ([e3c1e91](https://github.com/gabszap/mpv-rpc/commit/e3c1e91c807d396f8611c59005cf46bb3e7bd99a))

### Bug Fixes

* **bridge-userscript:** show fetch progress and fix init notifications ([7edbdc6](https://github.com/gabszap/mpv-rpc/commit/7edbdc6a44addbcb82f2f40e92584744d5e0a012))
* **bridge:** load MPV_PATH from shared .env and improve reliability ([08fa1da](https://github.com/gabszap/mpv-rpc/commit/08fa1daeb38c50f8d193bf1a1ca9dad2ed01389a))

## [1.9.0](https://github.com/gabszap/mpv-rpc/compare/bridge-v1.8.0...bridge-v1.9.0) (2026-04-24)

### Features

* **bridge-userscript:** add debug toggle, json episode discovery, and retry logic ([8be465a](https://github.com/gabszap/mpv-rpc/commit/8be465a3c6482657e965248e9e55a4b3d0f6bf20))

### Bug Fixes

* **bridge-server:** improve playlist handling and input validation ([97f74d5](https://github.com/gabszap/mpv-rpc/commit/97f74d5770e1346fa9c90b71bc108bcf20c3f99b))
