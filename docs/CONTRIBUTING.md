# Contributing to mpv-rpc

Thank you for your interest in contributing to **mpv-rpc**! This guide will help you get started with the development workflow, code standards, and project structure.

---

## Getting Started

### Prerequisites

- **Node.js** (LTS recommended)
- **npm** (comes with Node.js)
- **MPV** installed and accessible on your system

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/mpv-rpc.git
   cd mpv-rpc
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file from the example (optional):
   ```bash
   cp .env.example .env
   ```

4. Build and run:
   ```bash
   npm run dev
   ```

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install all dependencies |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Build and run the app |
| `npm start` | Run the compiled app |
| `npm run bridge` | Start the Stremio → MPV bridge workspace |
| `npm start -- mal-auth` | Run the MAL OAuth authentication flow |

---

## Code Style

This project uses **[Biome](https://biomejs.dev/)** for linting and formatting.

| Command | Description |
|---------|-------------|
| `npm run check` | Run linting and formatting checks |
| `npm run check:fix` | Auto-fix linting and formatting issues |
| `npm run lint` | Run linting only |
| `npm run lint:fix` | Auto-fix linting issues only |
| `npm run format` | Check formatting only |
| `npm run format:fix` | Auto-format code |

### Style Guidelines

- **Indentation**: 4 spaces
- **Quotes**: Double quotes for imports and strings
- **Semicolons**: Consistent use
- **Filenames/directories**: `kebab-case`
- **TypeScript**: Strict-safe; avoid `any`. Prefer explicit return types for exported functions.
- **Naming**:
  - Variables/functions: `camelCase`
  - Types/classes: `PascalCase`
  - Constants: `UPPER_SNAKE_CASE`
- **Imports**: External dependencies first, internal modules second

---

## Testing

Tests are run with **[Vitest](https://vitest.dev/)**.

```bash
# Run the full test suite
npm test

# Run a single test file
npx vitest run tests/parser.test.ts

# Run tests matching a pattern
npx vitest run -t "test name"
```

### When to Run Tests

- **Targeted tests**: When changing parsing heuristics, provider logic, or specific modules.
- **Full suite (`npm test`)**: When modifying any code under `src/`, shared types, MAL sync logic, or the update loop.
- **Always run `npm run build`** after changing `src/` to ensure the compiled output remains valid.

---

## Development Tools

### Parse Diagnostics

Test filename parsing without starting MPV or requiring network dependencies:

```bash
npm start -- parse "[Erai-raws] Dr Stone - Science Future Part 3 - 06 [1080p].mkv"
```

This runs the parser pipeline (PTT → anime release regex → regex fallback) and prints the extracted title, season, episode, and other metadata. Useful for debugging parsing issues during development.

### Dry-Run Mode

Set `SYNC_DRY_RUN=true` in your `.env` file to run the app without affecting any external services:

- ✅ Discord Rich Presence still works (read-only — no writing)
- ✅ MPV monitoring and filename parsing work
- ✅ Logs show what WOULD be synced
- ❌ Trakt scrobbles are skipped (logged)
- ❌ Stremio Continue Watching and watched marking are skipped (logged)
- ❌ Auto-Fetch requests are skipped (logged)
- ❌ MAL sync operations are skipped (logged)

Useful for testing parser results, provider resolution, or configuration changes without leaving traces on external services during development.

> **Note:** The `SYNC_DRY_RUN` env var is also listed in the main [README](../README.md) configuration table — this section explains its development use case.

---

## Commit Messages

This project follows **[Conventional Commits](https://www.conventionalcommits.org/)** for automated versioning and changelog generation via `semantic-release`.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, semicolons, etc.)
- `refactor`: Code refactoring (no feature or fix)
- `perf`: Performance improvements
- `test`: Adding or fixing tests
- `chore`: Maintenance tasks, dependencies, CI

### Examples

```
feat(parser): add support for season inference from filename
fix(discord): handle missing episode title gracefully
docs: update MAL OAuth setup instructions
refactor(providers): simplify search ranking logic
```

### Breaking Changes

Add `BREAKING CHANGE:` in the commit footer or append `!` to the type:

```
feat(api)!: change provider interface signature

BREAKING CHANGE: The AnimeProvider interface now requires a timeout parameter.
```

---

## Pull Requests

When submitting a PR, please include:

1. **Clear title** following Conventional Commits format.
2. **Description** explaining:
   - What changed and why.
   - Any user-visible behavior changes.
   - Links to related issues (if applicable).
3. **Testing evidence**:
   - Commands run and their output.
   - Notes on any edge cases or provider-specific behavior.
4. **Checklist**:
   - [ ] `npm test` passes
   - [ ] `npm run build` succeeds
   - [ ] `npm run check` passes (or fixes are included)
   - [ ] No new `any` types introduced
   - [ ] Parser fallback order preserved (PTT → anime release regex → regex)
   - [ ] `.env` loading behavior unchanged

---

## Architecture Overview

### Project Structure

The repository is organized as an **npm workspace** with two main parts:

```
mpv-rpc/
├── src/                  # Core mpv-rpc application
│   ├── index.ts          # Main entry point & update loop
│   ├── core/             # Core intelligence & shared utilities
│   │   ├── anime.ts          # Metadata resolution & caching
│   │   ├── auto-fetch.ts     # Next-episode auto-fetch logic
│   │   ├── config.ts         # Configuration & env loading
│   │   ├── parser.ts         # Filename parsing (PTT + regex)
│   │   ├── canonical-episode.ts
│   │   ├── playbackIdentity.ts
│   │   ├── bridge-config-migration.ts
│   │   └── userscript-config-sync.ts
│   ├── integrations/         # System socket integration
│   │   ├── mpv.ts            # MPV IPC connection
│   │   └── discord.ts       # Discord Rich Presence
│   ├── console/              # Interactive REPL for overrides
│   ├── functions/            # Global TypeScript type declarations
│   ├── metadata/             # Fallback resolution
│   ├── providers/            # Anime metadata providers (Jikan, AniList, Kitsu, TVDB)
│   ├── mal-sync/             # MyAnimeList synchronization
│   ├── stremio-sync/         # Stremio library sync
│   └── trakt-sync/           # Trakt.tv sync
├── stremio-mpv-bridge/   # Separate workspace: Stremio → MPV bridge
├── tests/                # Vitest test suite
├── .anime_cache/         # Runtime cache (auto-generated)
└── docs/                 # Additional documentation
```

### Data Flow

1. **MPV → IPC**: `src/integrations/mpv.ts` connects to MPV's IPC server and fetches playback state.
2. **Parser → Context**: `src/core/parser.ts` extracts series title, season, and episode from filenames (PTT → anime release regex → regex fallback).
3. **Metadata Resolution**: `src/core/anime.ts` queries configured providers with caching (`.anime_cache/`).
4. **Discord + MAL Sync**: `src/index.ts` orchestrates the update loop, updating Discord activity and optionally syncing to MAL.
5. **Stremio Bridge**: `stremio-mpv-bridge/` provides a separate HTTP server (`/health`, `/play`) for Stremio integration.

### Key Invariants

- **Parser fallback order**: PTT → anime release regex → regex (do not reorder).
- **MPV IPC defaults**: Windows `\\.\pipe\mpv`, Unix `/tmp/mpv-socket`.
- **Cache behavior**: Successful results cached for 24h, negative results for 10min.
- **MAL sync gates**: Requires `MAL_SYNC=true`, authenticated session, playback ≥ 90%, episode detected, and MAL ID resolved.

---

## Troubleshooting

### Cache Issues

If changes don't appear to take effect, check for stale cache entries:

```bash
# View cached results
cat .anime_cache/anime_cache.json

# Enable debug logging
DEBUG=true npm run dev
```

Debug logs are written to `.anime_cache/api_log.txt`.

### Provider Outages

If a metadata provider is down, the app automatically falls back to other providers. You can temporarily switch providers via `METADATA_PROVIDER` in `.env`.

### MAL Sync Not Triggering

Ensure all gate conditions are met:
1. `MAL_SYNC=true` in `.env`
2. Authenticated session (`npm start -- mal-auth`)
3. Playback percent ≥ 80
4. Episode number detected
5. MAL ID resolved for the anime

---

## Documentation

- [README.md](../README.md) — Project overview and setup
- [README_PT.md](README_PT.md) — Portuguese overview
- [mal-sync-setup.md](mal-sync-setup.md) — MAL OAuth and sync setup
- [stremio-mpv-bridge.md](stremio-mpv-bridge.md) — Stremio bridge setup

---

## Questions?

Feel free to open an issue for bugs, feature requests, or questions. For larger changes, consider opening an issue first to discuss the approach before implementing.
