# AGENTS.md (mpv-rpc)

Guidance for **AI agents** and **human developers** working on this repository.

This project connects **MPV** playback to:

1) **Discord Rich Presence** (optionally)
2) **Anime metadata providers** (Jikan/AniList/Kitsu/TVDB)
3) **Movie and series metadata** through TMDb (optionally, needs `TMDB_API_KEY`)
4) **MyAnimeList (MAL) sync** (optionally)
5) A separate **Stremio → MPV bridge** workspace

The intent of this file is to keep work safe, reproducible, and easy to troubleshoot.

---

## Non‑Negotiables (must stay true)

- **Build/test commands must remain accurate**:
  - Install dependencies: `npm install`
  - Build TypeScript (outputs to `dist/`): `npm run build`
  - Run tests: `npm test`
  - Run one test file: `npx vitest run tests/parser.test.ts`
  - Run a filtered test: `npx vitest run -t "test name"`
  - Run compiled app: `npm start`
  - Build and run in one command: `npm run dev`
  - Start the Stremio bridge workspace: `npm run bridge`
  - Rebuild the single-file userscript after editing `stremio-mpv-bridge/userscript/`: `npm run build:userscript`
  - Run MAL OAuth flow: `npm start -- mal-auth`

- **If you change anything under `src/`, you must finish with:**
  - `npm test`
  - `npm run build`

- **Parser fallback order (do not reorder):**
  - PTT → anime release regex → regex fallback
  - PTT is the native TypeScript parser (`src/core/parser-ptt.ts`, package `@aiostreams/release-parser`). The project has no Python dependency; do not reintroduce GuessIt.

- **`.env` loading must remain compatible with `src/core/config.ts`:**
  - use `dotenv` as the official loader
  - keep fallback behavior when `.env` is missing or partial

- **MPV IPC defaults must remain platform‑correct (`src/core/config.ts`):**
  - Windows: `\\.\pipe\mpv`
  - Unix (Linux/macOS): `/tmp/mpv-socket`

- **Equivalent video quality aliases must stay resolved by one implementation (`stremio-mpv-bridge/shared/stream-selection.js`):**
  - `getQualityAliases()` and the stream scoring (`findBestStream`, release group and season detection) live only in `shared/stream-selection.js`; `server.js` `require`s it and the userscript bundles it. Never re-implement them in either consumer.
  - Aliases must resolve equivalent terms (e.g., `4K` ↔ `2160p`, `2K` ↔ `1440p`, `FHD` ↔ `1080p`, `HD` ↔ `720p`) to prevent quality filtering from failing or falling back to lower resolution streams.
  - The module must stay free of Node-only and browser-only APIs. `tests/shared-stream-selection.test.ts` fails if a second definition appears.
  - After editing it, run `npm run build:userscript` so `stremio-mpv.user.js` includes the change.

- **Start script (`npm run start:all`) must bypass npm spawn overhead:**
  - The script must execute the direct node commands (`node dist/index.js` and `node stremio-mpv-bridge/server.js`) without intermediate `npm run` task chaining, keeping boot time under ~6 seconds.

---

## AI Agent Workflow (required)

### Task planning checklist (before editing)

1) **Define the user-visible goal**
   - What should change at runtime? What should not change?
2) **Identify the smallest safe surface area**
   - Which module owns this behavior? Prefer editing one layer at a time.
3) **List invariants and contracts**
   - Parser fallback order, env loading rules, IPC defaults, provider interfaces.
4) **Choose validation scope**
   - Targeted test vs full suite (see below).
5) **Write a rollback plan**
   - What files change? What log/caches may need clearing to verify?

### Safe change workflow (analyze → edit → test → report)

- **Analyze**
  - Locate the owning module (see Architecture Map).
  - Trace the data flow end-to-end (MPV → parser → provider → Discord/MAL).
  - Identify caches/logs that might make results look “sticky”.

- **Edit**
  - Keep changes minimal and scoped.
  - Avoid behavior changes that require new env variables unless absolutely necessary.
  - Preserve existing CLI entry points and defaults.

- **Test**
  - Always run targeted tests for the area you touched.
  - If you changed `src/`, you must also run `npm test` and `npm run build` before finishing.

- **Report**
  - Summarize what changed and why.
  - Provide exact commands used and outputs (including failures and fixes).
  - Include troubleshooting notes if behavior depends on caches or provider availability.

### When to run targeted tests vs the full suite

Run **targeted tests** when:

- You changed parsing heuristics or filename patterns.
  - Use: `npx vitest run tests/parser.test.ts`
- You changed provider resolution, caching, or resilience logic.
  - Run relevant provider/anime tests under `tests/`.
- You changed only documentation.
  - No tests required, but keep links and commands correct.

Run the **full suite** (`npm test`) when:

- You touched any code under `src/`.
- You changed shared types or provider interfaces.
- You modified MAL sync logic.
- You changed the update loop, MPV communication, or Discord integration.

Also run a **build** (`npm run build`) whenever you changed `src/` to ensure `dist/` output remains valid.

---

## Build, Test, Run (developer quick reference)

### Install

```bash
npm install
```

### Test

```bash
npm test
```

Single file:

```bash
npx vitest run tests/parser.test.ts
```

Filtered:

```bash
npx vitest run -t "test name"
```

### Build

```bash
npm run build
```

### Run

Compiled app:

```bash
npm start
```

Build + run:

```bash
npm run dev
```

### MAL OAuth

```bash
npm start -- mal-auth
```

### Stremio bridge workspace

```bash
npm run bridge
```

---

## Architecture Map (deeper view)

### High-level runtime data flow

1) **MPV → IPC**
   - `src/integrations/mpv.ts` connects to MPV’s IPC server and fetches playback state.
   - IPC path defaults are OS-specific (see Non‑Negotiables).

2) **Parser → episode context**
   - `src/core/parser.ts` extracts:
     - series title
     - season (optional)
     - episode (optional)
   - Fallback order is fixed:
     1. PTT (`src/core/parser-ptt.ts`)
     2. Anime release regex
     3. Regex fallback

3) **Metadata routing → two pipelines**
   - `src/core/metadata-router.ts` picks the pipeline for each file (called from `getMpvData` in `src/integrations/mpv.ts`):
     1. Stremio says `type=movie` → media pipeline (TMDb) first, anime pipeline as fallback.
     2. The parser marked the file `anime` → anime pipeline only.
     3. Anything else → media pipeline first, anime pipeline as fallback.
   - **Media pipeline** (movies and non-anime series): `src/core/media.ts` resolves through the `MediaProvider` contract (`src/providers/media-types.ts`), implemented by `src/providers/tmdb.ts`. Without `TMDB_API_KEY` it returns nothing and the anime pipeline runs. Its cache is persisted at `.anime_cache/media_cache.json` (24 hours for hits, 10 minutes for misses), excluding episode names (kept in memory only). Legacy persisted episode entries are removed on load. Series use the main series poster in `TMDB_LANG` without requesting season artwork. Empty or malformed cache files recover to a valid JSON object. TMDb requests are always logged to `.anime_cache/api_log.txt`, even with `DEBUG=false`, with credentials excluded; transient failures are never cached; a 401 disables TMDb until `.reload`. Results carry no `mal_id`, so MAL sync does not run for them; for that reason a TMDb match flagged `animeLikely` (genre Animation with a Japanese origin) is treated as a miss and the anime pipeline runs instead. After a transient TMDb failure the media pipeline pauses for 60 seconds.
   - **Anime pipeline**: `resolveAnimeMetadata` in `src/integrations/mpv.ts`, described below. Do not change its behavior when working on the media pipeline; the two are kept separate on purpose.
   - Discord renders a movie (`media_kind === "movie"`) in `buildActivityContent` (`src/integrations/discord.ts`).

   Anime pipeline details:
   - `src/core/anime.ts` calls the configured provider (from `src/core/config.ts`).
   - Providers implement `AnimeProvider` (`src/providers/types.ts`).
   - Resolution strategy:
     - Use primary provider for anime + episode titles.
     - If episode title is missing or provider fails, try fallback providers.
   - **Cache behavior (important for troubleshooting):**
     - Directory: `.anime_cache/`
     - Anime cache file: `.anime_cache/anime_cache.json`
     - Cache TTL:
       - successful results: 24 hours
       - negative (not found): 10 minutes
     - Episode titles are also cached in-memory for the current run.

4) **Discord + MAL sync**
   - `src/index.ts` orchestrates the periodic update loop:
     - pull MPV state
     - update Discord activity (`src/integrations/discord.ts`)
     - optionally trigger MAL sync (`src/mal-sync/`)
   - MAL sync triggers only when:
     - `MAL_SYNC=true`
     - authenticated session exists
     - playback percent ≥ `MAL_SYNC_THRESHOLD` (default 90)
     - episode number is detected
     - MAL ID is available for the resolved anime
     - Playback is not explicitly classified as a TMDb movie/series (`media_kind` is absent)

5) **Interactive overrides**
   - `src/console/` provides an interactive REPL for manual overrides.
   - `src/index.ts` feeds it context derived from MPV filename / parsed fields.

### Critical files by change type

- **Parser changes / filename detection**
  - edit: `src/core/parser.ts`
  - validate: `tests/parser.test.ts`
  - keep: PTT → anime release regex → regex fallback order

- **Provider logic / search matching / resilience**
  - edit: `src/core/anime.ts`, `src/providers/*`, `src/providers/types.ts`
  - validate: provider/anime tests under `tests/`
  - note: caching can mask fixes; see Troubleshooting → Cache

- **Movie and series metadata (TMDb)**
  - edit: `src/providers/tmdb.ts`, `src/providers/media-types.ts`, `src/core/media.ts`, `src/core/metadata-router.ts`
  - validate: `tests/tmdb-provider.test.ts`, `tests/media-resolver.test.ts`, `tests/metadata-router.test.ts`, `tests/mpv-media-metadata.test.ts`, `tests/discord-activity-content.test.ts` (no network; axios is mocked, fixtures in `tests/fixtures/tmdb`)
  - keep: the anime pipeline untouched (`tests/mpv-anime-metadata.test.ts` pins it)

- **Env variables / defaults / configuration**
  - edit: `src/core/config.ts`, `.env.example`
  - keep: `dotenv`-based `.env` loading behavior
  - keep: IPC default paths

- **MAL sync behavior**
  - edit: `src/mal-sync/` + `src/index.ts`
  - validate: MAL-related tests under `tests/`
  - note: runtime diagnostics are logged (see playbooks)

- **Bridge behavior (Stremio integration)**
  - edit: `stremio-mpv-bridge/`
  - validate: bridge tests under `tests/` (if applicable)
  - keep: endpoint expectations `/health` + `/play` (see playbook)

- **Stremio userscript (`stremio-mpv-bridge/stremio-mpv.user.js`) — generated file, do not edit by hand**
  - edit: `stremio-mpv-bridge/userscript/src/**` (code) and `stremio-mpv-bridge/userscript/header.txt` (metadata block)
  - layout: `main.js` (entry/`init`), `settings.js` (persisted settings, exposed as the mutable `settings` object — ES module imports cannot be reassigned), `bridge-api.js`, `bridge-polling.js`, `providers.js`, `stream-selection.js` (thin adapter over `shared/stream-selection.js`), `playback.js`, `config-modal.js`, `floating-ui.js`, `toasts.js`, `url-parser.js`, `page-scraper.js`, `icon-mode.js`, `logging.js`, `constants.js`
  - globals `GM_*` come from Violentmonkey; do not import them
  - rebuild: `npm run build:userscript` (esbuild bundles to the single file Violentmonkey needs)
  - verify: `npm run check:userscript`; `tests/userscript-bundle.test.ts` fails when the committed output is stale
  - note: semantic-release bumps `@version` in both `header.txt` and the built file

- **Release workflows**
  - `.github/workflows/release-root.yml` and `release-bridge.yml` are manual-only (`workflow_dispatch`); do not restore automatic push triggers.
  - Keep CI automatic on PRs and pushes to `main`. Publishing is an explicit manual action, independently for root and bridge.

- **Semantic-Release configuration updates**
  - edit: `semantic-release/`
  - keep: explicit `-e ./semantic-release/release.config.js` configuration path in `package.json` release scripts

---

## Logging & Diagnostics Policy

This repo uses two “channels”:

### 1) Console output (primary)

- Startup diagnostics and status messages go to stdout/stderr.
- MAL sync decisions (skips + success) are logged in `src/index.ts`.
- Provider fallback attempts may log to console when relevant.

### 2) Provider/API call log (debug-only)

- When `DEBUG=true`, providers may write detailed API logs to:
  - `.anime_cache/api_log.txt`
- This log is intended for:
  - tracking provider outages/timeouts (e.g., Jikan issues)
  - confirming which endpoints were called
  - understanding fallback behavior

Guideline:

- Prefer **console logs** for actionable user feedback.
- Use **`.anime_cache/api_log.txt`** for high-volume diagnostics that would otherwise spam the terminal.

---

## Cache Notes (important for debugging)

Caching is necessary for rate limits and performance, but it can confuse validation.

What to know:

- `getAnimeInfo()` caches both “found” and “not found” results.
  - Not found results are cached for ~10 minutes.
- Cache keys include provider name + normalized title + season.
  - Changing providers or title normalization can change cache hit rates.
- Provider fallbacks can succeed even if the primary provider is failing.
  - This is expected; verify which provider supplied the data when debugging.

When diagnosing “why didn’t it change?”

- Check `.anime_cache/anime_cache.json` for stale entries.
- Temporarily switch `DEBUG=true` to confirm what the system is doing.
- Consider reproducing in a clean working directory (tests already do this).

---

## Runtime Troubleshooting Playbooks

### A) Provider outages (example: Jikan 503 / timeouts)

Symptoms:

- Anime metadata missing intermittently.
- Episode titles not resolving.
- Debug log shows 5xx, timeouts, or retries.

Expected behavior:

- If the **primary provider** errors, `src/core/anime.ts` attempts other providers in order.
- For **episode titles**, fallbacks are attempted when the primary returns no data or fails.

Checklist:

1) Set `DEBUG=true` and reproduce.
2) Inspect `.anime_cache/api_log.txt` for status lines for the failing provider.
3) Confirm whether fallbacks resolved:
   - look for console messages like “trying fallbacks…” and “Found episode title via …”.
4) If the outage persists:
   - switch `METADATA_PROVIDER` to another provider temporarily
   - keep rate-limit friendly behavior (avoid tight retry loops)

What not to do:

- Do not remove caching to “fix” outages; it will worsen rate limiting.
- Do not hard-fail the entire app if a single provider is down; resilience is a goal.

### B) Wrong season / wrong title

Symptoms:

- Rich Presence shows a different series than the filename.
- Season inference is wrong (common with sequels / “Season 2” naming).

Debug steps:

1) Start from the filename.
   - Verify it contains an episode marker (e.g., `E02`, `- 02`, etc.).
2) Check parsing result.
   - The parser may have fallen back to regex if PTT could not be loaded (look for the "Failed to load PTT" warning).
3) Check provider search matching.
   - Providers may return the “most popular” match for ambiguous queries.
4) Clear confusion caused by cache.
   - A cached wrong match can persist for up to 24 hours.
5) Use the console REPL overrides (if appropriate) to confirm the correct target.

Where to fix:

- If the extracted title/season is wrong: `src/core/parser.ts`.
- If the extracted title is correct but provider picks the wrong series:
  - provider search/ranking logic in `src/providers/*`
  - resolution + fallback logic in `src/core/anime.ts`

### C) MAL sync not triggering

Symptoms:

- Playback passes the expected threshold but MAL does not update.

MAL sync gate conditions (all must be true):

1) `MAL_SYNC=true`
2) Authenticated session exists
   - If not authenticated, run: `npm start -- mal-auth`
3) Playback percent ≥ `MAL_SYNC_THRESHOLD` (default 90)
4) Episode number detected
5) MAL ID resolved for the anime

Diagnostics flow (what to look for):

- `src/index.ts` logs explicit skip reasons:
  - missing episode marker
  - missing MAL ID
  - sync request failed
- These logs are de-duplicated per filename to avoid spam; if you want to see them again,
  restart the process.

If MAL ID is missing:

- The metadata provider may not return MAL IDs (depending on provider and mapping).
- `src/core/anime.ts` normalizes fields for Jikan so that `mal_id` is available.
- Verify the configured provider and the resolved anime info.

### D) Stremio bridge expectations (no legacy scrobble)

This repo includes a separate workspace in `stremio-mpv-bridge/`.

Contract:

- `GET /health` returns server status (used by clients to verify connectivity).
- `POST /play` opens URLs in MPV. Bridge-created sessions use `--autocreate-playlist=no` after custom arguments, preventing MPV from scanning the temporary playlist directory (where TypeScript `.ts` files can be mistaken for transport-stream videos). Keep legitimate remote `.ts` streams playable.
- There is **no legacy scrobble endpoint** in the intended contract; do not reintroduce it.

Debug steps:

1) Start the bridge: `npm run bridge`
2) Confirm `/health` is reachable.
3) Confirm `/play` receives payloads and MPV opens content.
4) If MPV does not open:
   - verify MPV is installed / discoverable (or `MPV_PATH` configured)
   - verify MPV is allowed to be spawned by the bridge process

---

## Code Style & Maintenance Rules

- Indentation: **4 spaces**.
- Quotes: **double quotes** for imports/strings.
- Semicolons: consistent use.
- Filenames/dirs: **kebab-case**.
- TypeScript: keep strict-safe; avoid `any`.
  - Prefer explicit return types for exported functions.
- Naming:
  - variables/functions: `camelCase`
  - types/classes: `PascalCase`
  - constants: `UPPER_SNAKE_CASE`
- Imports:
  - external dependencies first
  - internal modules second
- Commits:
  - use Conventional Commits style
  - provide high-quality and detailed descriptions in the commit body (not just the title) detailing all files affected and structural reasoning

---

## Documentation Index

- Project overview and setup: [README.md](README.md)
- Portuguese overview: [README_PT.md](docs/README_PT.md)
- System Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- MAL OAuth and sync setup: [docs/mal-sync-setup.md](docs/mal-sync-setup.md)
- Stremio bridge setup and usage: [docs/stremio-mpv-bridge.md](docs/stremio-mpv-bridge.md)

Prefer linking to the docs above for long setup steps instead of duplicating them here.
