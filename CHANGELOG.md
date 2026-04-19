## [2.0.1](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.0.0...mpv-rpc-v2.0.1) (2026-04-19)

### Bug Fixes

* **deps:** update discord-api-types to latest working version ([bb71aaa](https://github.com/gabszap/mpv-rpc/commit/bb71aaa696f9cfe3a04aec2e6b92ff54e6eb0d81))
* **release:** narrow bridge workflow triggers to bridge scope ([dfdc6e3](https://github.com/gabszap/mpv-rpc/commit/dfdc6e324ae783b7695b8fe06d77ee917e8070a8))
* **release:** revert mistaken root 1.0.0 release and fetch full tag history ([dec2f86](https://github.com/gabszap/mpv-rpc/commit/dec2f86dfe8a5f800308f8301f2b17cb4fedd495))
* **release:** revert mistaken root 1.0.0 release and fetch full tag history ([48b4b2c](https://github.com/gabszap/mpv-rpc/commit/48b4b2cc0fe1134ec6ae7263bf2c5366c38b88c7))
* **release:** run root workflow for shared path-scoping plugin updates ([c4803bf](https://github.com/gabszap/mpv-rpc/commit/c4803bf1b37d4b57960cc1ba3c94a1da2fd3b778))
* **release:** sync bridge userscript [@version](https://github.com/version) with bridge package ([b0fe483](https://github.com/gabszap/mpv-rpc/commit/b0fe483abd72400cff214c10cd42355bab352c06))

# Changelog

## 2.0.0 - 2026-04-16

### Breaking/major highlights
- MAL sync runtime flow was reworked to diagnostic-first outcomes (`updated`, `already_synced`, `skipped`, `failed`) and the legacy bridge retry path was removed.
- Metadata resolution now uses stricter ordered/deduped fallback behavior with stronger provider diagnostics, affecting how fallback selection is evaluated.

### Features
- Hardened metadata provider fallback resolution with improved cross-provider episode lookup context.
- Standardized provider error detail formatting and expanded resilience diagnostics.
- Improved TVDB episode resolution using official/default order preference with bounded pagination.
- Migrated environment loading to `dotenv` as the official runtime loader while preserving fallback behavior.

### Fixes
- Improved parser episode-marker recovery beyond strict `SxxExx` patterns.
- Refined filename/media-title target selection to avoid parse loops and recover ambiguous hyphenated episode numbers.
- Improved GuessIt split-title reconciliation for arc/subtitle naming edge cases.

### Docs
- Rewrote the bilingual Stremio bridge guide with mirrored EN/PT structure, clearer architecture/setup, troubleshooting, and FAQ.
- Updated configuration/runtime docs in `AGENTS.md`, `README.md`, and `README_PT.md` to reflect dotenv-based loading.

### Migration note (dotenv)
- `.env` loading now uses `dotenv` as the official parser/loader. Existing `.env` files remain compatible, and partial/missing `.env` fallback behavior is preserved.
