## 1.0.0 (2026-04-19)

### ⚠ BREAKING CHANGES

* Completely removes previous Python and PreMiD implementation

- Replace web_server.py, anime_lookup.py, and mpv_viewer.py with TypeScript modules
- Remove PreMiD dependency, now uses native discord-rpc
- Add new modules: anime.ts, discord.ts, mpv.ts, parser.ts, config.ts
- Add visual config assets (english, romaji, filename, privacymode)
- Reorganize directory structure (remove dist/, premid/, @types/)
- Update documentation with README.md and README_PT.md
- Add type system in functions/types.ts

### Features

* add anime detection to skip AniList for non-anime content ([18c8b0b](https://github.com/gabszap/mpv-rpc/commit/18c8b0b157723c48d436e8fbff910a14e052af47))
* add console REPL, provider detection and encoded URL fallback ([561ec76](https://github.com/gabszap/mpv-rpc/commit/561ec76b84ecbcb2b6643d5aed454fe1a2a0e0fe))
* Adiciona presença para MPV com Discord Rich Presence ([38b3785](https://github.com/gabszap/mpv-rpc/commit/38b378571b15efad459ca3d8b2beaead05398a03))
* Adiciona suporte a Discord Rich Presence para MPV com utilitários PreMiD e busca de anime. ([be6c257](https://github.com/gabszap/mpv-rpc/commit/be6c257ba1b03090477d2a06b8fe82c309680781))
* **bridge:** add automatic watched sync to Stremio ([ab4731f](https://github.com/gabszap/mpv-rpc/commit/ab4731f9c43e09fb4048d12fe5b92cb6a0a421e4))
* **bridge:** add guessit-api and update stremio integration ([ef5aab0](https://github.com/gabszap/mpv-rpc/commit/ef5aab0f8d6253ba4f1a71ab16e59d62206dff4e))
* **bridge:** enhanced metadata parsing and UI polish ([e4d1b59](https://github.com/gabszap/mpv-rpc/commit/e4d1b59d322cf1b383e2ce3aaf7e401c0d3659a5))
* **config:** migrate .env loading to dotenv ([ac4f226](https://github.com/gabszap/mpv-rpc/commit/ac4f226883db001b321e928f32aa6d13a132aaf4))
* **core:** refine RPC logic and improve media provider accuracy ([f891368](https://github.com/gabszap/mpv-rpc/commit/f8913681eac6a31bfb34f6578f70e230a967abc0))
* **mal-sync:** implement MyAnimeList watch progress synchronization and reliability improvements ([37990fb](https://github.com/gabszap/mpv-rpc/commit/37990fb8b77c65f0eb2c5ce989a876d679503894))
* **mal-sync:** replace bridge retry path with MAL diagnostic sync flow ([7a04656](https://github.com/gabszap/mpv-rpc/commit/7a04656b80afab0262176d3dbc1d71f8aff2536c))
* **metadata:** harden provider fallback resolution and error diagnostics ([466eec4](https://github.com/gabszap/mpv-rpc/commit/466eec4f9bbb3138621ed2f4e1f21767aae730b3))
* **providers:** add AniList and Kitsu metadata providers ([6d03091](https://github.com/gabszap/mpv-rpc/commit/6d030918fc1669ca83392e7f8c62382b79fd0ab6))
* **rpc:** add discord rpc toggle ([991dab4](https://github.com/gabszap/mpv-rpc/commit/991dab4293d6ce179c4b313a1e42336af6f535ae))
* **stremio-bridge:** add local bridge server and userscript for Stremio Web ([af496eb](https://github.com/gabszap/mpv-rpc/commit/af496eb60c3c0b284a0d36104e4db414c6bf8305))
* **tvdb:** add provider with localization and season support ([b6068ad](https://github.com/gabszap/mpv-rpc/commit/b6068ad13e2065cf07d2b1f142727d6d82d03f35))

### Bug Fixes

* **anime:** add MAL ID fallback for episode titles ([bd9d41a](https://github.com/gabszap/mpv-rpc/commit/bd9d41a8dbb12c1f05b9752c4d9c4a54921d2a51))
* **deps:** update discord-api-types to latest working version ([bb71aaa](https://github.com/gabszap/mpv-rpc/commit/bb71aaa696f9cfe3a04aec2e6b92ff54e6eb0d81))
* **parser:** improve episode marker recovery for hyphenated and URL-driven titles ([fbe8567](https://github.com/gabszap/mpv-rpc/commit/fbe8567d2ab3871d9aebcbe652fc8e820eac8ed8))
* **parser:** improve url decoding and guessit korean language bug ([470667c](https://github.com/gabszap/mpv-rpc/commit/470667ce0da05572fa19e357f1cc0238d2fd5d97))
* **release:** narrow bridge workflow triggers to bridge scope ([dfdc6e3](https://github.com/gabszap/mpv-rpc/commit/dfdc6e324ae783b7695b8fe06d77ee917e8070a8))
* **release:** run root workflow for shared path-scoping plugin updates ([c4803bf](https://github.com/gabszap/mpv-rpc/commit/c4803bf1b37d4b57960cc1ba3c94a1da2fd3b778))
* **release:** sync bridge userscript [@version](https://github.com/version) with bridge package ([b0fe483](https://github.com/gabszap/mpv-rpc/commit/b0fe483abd72400cff214c10cd42355bab352c06))

### Code Refactoring

* rewrite project from Python/PreMiD to native TypeScript ([21219a6](https://github.com/gabszap/mpv-rpc/commit/21219a6a19d20d5a98c2c5725d5797910644e88f))

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
