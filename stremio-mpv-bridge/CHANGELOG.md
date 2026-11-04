# Changelog

This file is managed by semantic-release.

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
