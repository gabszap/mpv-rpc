## [1.0.1](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v1.0.0...mpv-rpc-v1.0.1) (2026-04-19)

### Bug Fixes

* **release:** revert mistaken root 1.0.0 release and fetch full tag history ([48b4b2c](https://github.com/gabszap/mpv-rpc/commit/48b4b2cc0fe1134ec6ae7263bf2c5366c38b88c7))

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
