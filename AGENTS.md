# AGENTS.md (mpv-rpc)

Guidance for **AI agents** and **human developers** working on this repository.

This project connects **MPV** playback to:

1) **Discord Rich Presence** (optionally)
2) **Anime metadata providers** (Jikan/AniList/Kitsu/TVDB)
3) **MyAnimeList (MAL) sync** (optionally)
4) A separate **Stremio → MPV bridge** workspace

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
  - Run MAL OAuth flow: `npm start -- mal-auth`

- **If you change anything under `src/`, you must finish with:**
  - `npm test`
  - `npm run build`

- **Parser fallback order (do not reorder):**
  - GuessIt API → local GuessIt CLI → regex fallback

- **`.env` loading must remain compatible with `src/config.ts`:**
  - use `dotenv` as the official loader
  - keep fallback behavior when `.env` is missing or partial

- **MPV IPC defaults must remain platform‑correct (`src/config.ts`):**
  - Windows: `\\.\pipe\mpv`
  - Unix (Linux/macOS): `/tmp/mpv-socket`

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
   - `src/mpv.ts` connects to MPV’s IPC server and fetches playback state.
   - IPC path defaults are OS-specific (see Non‑Negotiables).

2) **Parser → episode context**
   - `src/parser.ts` extracts:
     - series title
     - season (optional)
     - episode (optional)
   - Fallback order is fixed:
     1. GuessIt API
     2. GuessIt CLI
     3. Regex fallback
   - `src/parser.ts` also exposes parser availability checks.

3) **Metadata resolution → providers + caching**
   - `src/anime.ts` calls the configured provider (from `src/config.ts`).
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
     - update Discord activity (`src/discord.ts`)
     - optionally trigger MAL sync (`src/mal-sync/`)
   - MAL sync triggers only when:
     - `MAL_SYNC=true`
     - authenticated session exists
     - playback percent ≥ `MAL_SYNC_THRESHOLD` (default 90)
     - episode number is detected
     - MAL ID is available for the resolved anime

5) **Interactive overrides**
   - `src/console/` provides an interactive REPL for manual overrides.
   - `src/index.ts` feeds it context derived from MPV filename / parsed fields.

### Critical files by change type

- **Parser changes / filename detection**
  - edit: `src/parser.ts`
  - validate: `tests/parser.test.ts`
  - keep: GuessIt API → GuessIt CLI → regex fallback order

- **Provider logic / search matching / resilience**
  - edit: `src/anime.ts`, `src/providers/*`, `src/providers/types.ts`
  - validate: provider/anime tests under `tests/`
  - note: caching can mask fixes; see Troubleshooting → Cache

- **Env variables / defaults / configuration**
  - edit: `src/config.ts`, `.env.example`
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

- If the **primary provider** errors, `src/anime.ts` attempts other providers in order.
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
   - The parser may have fallen back to regex if GuessIt is unavailable.
3) Check provider search matching.
   - Providers may return the “most popular” match for ambiguous queries.
4) Clear confusion caused by cache.
   - A cached wrong match can persist for up to 24 hours.
5) Use the console REPL overrides (if appropriate) to confirm the correct target.

Where to fix:

- If the extracted title/season is wrong: `src/parser.ts`.
- If the extracted title is correct but provider picks the wrong series:
  - provider search/ranking logic in `src/providers/*`
  - resolution + fallback logic in `src/anime.ts`

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
- `src/anime.ts` normalizes fields for Jikan so that `mal_id` is available.
- Verify the configured provider and the resolved anime info.

### D) Stremio bridge expectations (no legacy scrobble)

This repo includes a separate workspace in `stremio-mpv-bridge/`.

Contract:

- `GET /health` returns server status (used by clients to verify connectivity).
- `POST /play` opens URLs in MPV.
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

---

## Documentation Index

- Project overview and setup: [README.md](README.md)
- Portuguese overview: [README_PT.md](README_PT.md)
- MAL OAuth and sync setup: [docs/mal-sync-setup.md](docs/mal-sync-setup.md)
- Stremio bridge setup and usage: [docs/stremio-mpv-bridge.md](docs/stremio-mpv-bridge.md)
- GuessIt API deployment and local dev: [guessit-api/README.md](guessit-api/README.md)

Prefer linking to the docs above for long setup steps instead of duplicating them here.
