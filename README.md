# MPV Discord RPC

Discord Rich Presence for MPV Media Player with anime metadata, optional watch sync, and Stremio Web playback through MPV.

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/gabszap/mpv-rpc?style=for-the-badge&color=22c55e" alt="Version">
  <img src="https://img.shields.io/github/package-json/v/gabszap/mpv-rpc?filename=stremio-mpv-bridge%2Fpackage.json&style=for-the-badge&label=bridge&color=8b5cf6" alt="Bridge Version">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white&style=for-the-badge" alt="TypeScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white&style=for-the-badge" alt="Windows">
  <img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black&style=for-the-badge" alt="Linux">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge" alt="License">
</p>

<p align="center">
  <img src="assets/demo.gif" alt="MPV Discord RPC demo" width="600">
  <br>
  <em>Discord Rich Presence in action</em>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_PT.md">Português</a>
</p>

---

## What this does

**MPV Discord RPC** watches your MPV playback through IPC and turns it into Discord Rich Presence. For anime files, it can parse the filename, fetch metadata and cover art, resolve episode titles, and optionally sync watch progress to MyAnimeList, Trakt.tv, and Stremio.

The project also includes **Stremio MPV Bridge**, a separate workspace that lets Stremio Web open streams directly in MPV with playlist support.

## Feature overview

| Area | Features |
| --- | --- |
| Discord RPC | Live playback status, pause/playing state, progress, privacy mode, optional idle hiding |
| Anime metadata | Filename parsing, cover art, official titles, episode titles, local cache |
| Providers | Jikan/MyAnimeList, AniList, Kitsu, TheTVDB |
| Parser fallback | GuessIt API, local GuessIt CLI, regex fallback |
| Sync | MyAnimeList episode progress, Trakt.tv scrobbling, Stremio Continue Watching and watched marking |
| Stremio bridge | Browser userscript, local bridge server, MPV launch, single/batch/all playlist modes, provider settings |
| Developer workflow | TypeScript, Vitest, Biome, semantic-release, independent root/bridge releases |

> Cover art is currently focused on anime metadata. For non-anime files, the app can still show playback status without anime-specific metadata.

## Requirements

- Node.js 22 or newer
- MPV Media Player
- Discord Desktop, if `DISCORD_RPC=true`
- Optional: Python 3.12+ and `guessit`, only if you want local GuessIt parsing instead of the cloud API
- Optional: a userscript manager, such as Tampermonkey or Violentmonkey, for Stremio Web integration

## Quick start

### 1. Install

```bash
git clone https://github.com/gabszap/mpv-rpc.git
cd mpv-rpc
npm install
```

### 2. Create your `.env`

```bash
# Windows PowerShell
Copy-Item .env.example .env

# Linux/macOS
cp .env.example .env
```

For the default no-Python parser setup, keep:

```env
USE_GUESSIT_API=true
GUESSIT_API_URL=https://guessit-api.vercel.app/api/parse
```

### 3. Enable MPV IPC

Add this to your `mpv.conf`:

```ini
# Windows
input-ipc-server=\\.\pipe\mpv

# Linux/macOS
input-ipc-server=/tmp/mpv-socket
```

Or start MPV manually with:

```bash
# Windows
mpv --input-ipc-server=\\.\pipe\mpv <file>

# Linux/macOS
mpv --input-ipc-server=/tmp/mpv-socket <file>
```

### 4. Build and run

```bash
npm run build
npm start
```

For development, build and run in one command:

```bash
npm run dev
```


## Setup paths

### Basic Discord RPC only

Use this path if you only want MPV playback in Discord:

1. Install dependencies.
2. Copy `.env.example` to `.env`.
3. Enable MPV IPC in `mpv.conf`.
4. Run `npm run build && npm start`.

### Discord RPC + Stremio Web playback

Use this path if you want Stremio Web to open streams in MPV:

1. Complete the basic Discord RPC setup.
2. Install `stremio-mpv-bridge/stremio-mpv.user.js` in your userscript manager.
3. Start both services:

   ```bash
   npm run start:all
   ```

4. Open `https://web.stremio.com/`, choose an episode/movie, and use the MPV bridge button or shortcut.

Full guide: [Stremio MPV Bridge Guide](docs/stremio-mpv-bridge.md)

### Sync services

| Service | Enable in `.env` | Auth command | Guide |
| --- | --- | --- | --- |
| MyAnimeList | `MAL_SYNC=true` | `npm start -- mal-auth` | [MAL guide](docs/mal-sync-setup.md) |
| Trakt.tv | `TRAKT_SYNC=true` | `npm start -- trakt-auth` | [Trakt guide](docs/trakt-sync-setup.md) |
| Stremio | `STREMIO_SYNC=true` | Open media through the bridge so it can capture context/auth | [Stremio guide](docs/stremio-mpv-bridge.md) |

Tokens and Stremio context are stored under `.config/`, which is ignored by git.

## Filename parsing

The parser tries the safest available method in this order:

1. **GuessIt API**: enabled when `USE_GUESSIT_API=true` and `GUESSIT_API_URL` is set.
2. **Local GuessIt CLI**: used when the API is unavailable and `guessit` is installed locally.
3. **Regex fallback**: always available for basic title/episode extraction.

### Public GuessIt API

The default public endpoint is:

```env
USE_GUESSIT_API=true
GUESSIT_API_URL=https://guessit-api.vercel.app/api/parse
```

Only filenames are sent to the API. If you prefer maximum privacy or expect heavy usage, deploy your own API from the included `guessit-api/` folder.

### Deploy your own GuessIt API

```bash
cd guessit-api
npm i -g vercel
vercel
```

Then set the deployed endpoint in your root `.env`:

```env
USE_GUESSIT_API=true
GUESSIT_API_URL=https://your-project.vercel.app/api/parse
```

## Configuration reference

Copy `.env.example` to `.env`, then adjust only what you need. Missing values fall back to runtime defaults.

<details>
<summary>Core settings</summary>

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_CLIENT_ID` | bundled app ID | Discord application client ID |
| `DISCORD_RPC` | `true` | Enable Discord Rich Presence |
| `SHOW_COVER` | `true` | Show anime cover art when available |
| `PRIVACY_MODE` | `false` | Hide media details in Discord |
| `HIDE_IDLING` | `false` | Hide activity while MPV is idle |
| `SHOW_TITLE` | `true` | Use resolved title as Discord activity name |
| `TITLE_LANG` | `none` | Title language: `english`, `eng`, `romaji`, or `none` |
| `DEBUG` | `false` | Write detailed provider/sync logs under `.anime_cache/` |
| `AUTO_FETCH` | `true` | Global RPC-side kill switch for auto-fetching next episodes. Also requires the bridge config toggle `autoFetch.enabled` to be ON. |

</details>

<details>
<summary>MPV and bridge settings</summary>

| Variable | Default | Description |
| --- | --- | --- |
| `MPV_IPC_PATH` | Windows: `\\.\pipe\mpv`<br>Unix: `/tmp/mpv-socket` | IPC path shared by the RPC app and bridge |
| `MPV_PATH` | `mpv` | MPV executable path used by the bridge |
| `PORT` | `9632` | Bridge server port |

If you change `PORT`, update `CONFIG.SERVER_URL` inside `stremio-mpv-bridge/stremio-mpv.user.js` so the userscript points to the same bridge URL.

</details>

<details>
<summary>Metadata and parser settings</summary>

| Variable | Default | Description |
| --- | --- | --- |
| `METADATA_PROVIDER` | `jikan` | Metadata provider: `jikan`, `anilist`, `kitsu`, or `tvdb` |
| `TVDB_API_KEY` | empty | TheTVDB API key, required when using `tvdb` as the primary provider |
| `TVDB_LANG` | `eng` | TheTVDB language code for episode metadata |
| `USE_GUESSIT_API` | `true` | Use HTTP GuessIt parsing before local CLI fallback |
| `GUESSIT_API_URL` | empty in code, public endpoint in `.env.example` | GuessIt API endpoint |

</details>

<details>
<summary>Sync settings</summary>

| Variable | Default | Description |
| --- | --- | --- |
| `MAL_SYNC` | `false` | Enable MyAnimeList episode progress sync |
| `MAL_CLIENT_ID` | empty | MyAnimeList API client ID |
| `MAL_SYNC_THRESHOLD` | `90` | Percent watched before MAL sync triggers |
| `TRAKT_SYNC` | `false` | Enable Trakt.tv scrobbling |
| `TRAKT_CLIENT_ID` | empty | Trakt API client ID |
| `TRAKT_CLIENT_SECRET` | empty | Trakt API client secret |
| `TRAKT_SYNC_THRESHOLD` | `81` | Percent watched before Trakt scrobble triggers |
| `TRAKT_USE_TOR` | `false` | Route Trakt requests through a Tor SOCKS5 proxy |
| `TRAKT_TOR_PROXY` | `socks5://127.0.0.1:9050` | Tor SOCKS5 proxy URL |
| `STREMIO_SYNC` | `false` | Enable Stremio Continue Watching and watched marking |
| `STREMIO_SYNC_THRESHOLD` | `85` | Percent watched before Stremio marks an item watched |
| `STREMIO_PROGRESS_INTERVAL_MS` | `90000` | Minimum delay between Continue Watching writes, clamped to at least `30000` |
| `SYNC_DRY_RUN` | `false` | When enabled, all sync operations (Trakt scrobble, Stremio datastore writes, Auto-Fetch requests, MAL sync) are logged but NOT executed. Safe for testing configuration without side effects. |

</details>

### Auto-Fetch (Dual Gate)

The Auto-Fetch feature has two independent gates:

1. **`.env` gate** — `AUTO_FETCH` (default `true`): the RPC-side kill switch. When `false`, the RPC never triggers auto-fetch regardless of the bridge config.
2. **Bridge config gate** — `autoFetch.enabled`: the bridge-side toggle, controlled via the userscript modal (Playback → Auto-Fetch Episodes). When OFF, the bridge ignores auto-fetch requests even if the RPC triggers.

Both must be `true` for auto-fetch to fire. The `.env` gate is the global kill switch; the bridge toggle is per-instance fine control.

## How it works

```text
MPV playback
  -> MPV IPC socket / named pipe
  -> filename parser
  -> metadata provider + cache
  -> Discord Rich Presence
  -> optional MAL / Trakt / Stremio sync
```

The Stremio bridge runs separately:

```text
Stremio Web userscript
  -> local bridge server on http://localhost:9632
  -> temporary MPV playlist
  -> MPV playback
  -> optional Stremio context for Continue Watching sync
```

## Screenshots

### Title display modes

| Romaji title | English title | Filename fallback |
| :---: | :---: | :---: |
| ![Romaji title mode](assets/romaji.png) | ![English title mode](assets/english.png) | ![Filename mode](assets/filename.png) |

### Privacy mode

![Privacy mode preview](assets/privacymode.png)

## Troubleshooting

| Problem | Check |
| --- | --- |
| Discord status does not appear | Discord Desktop is running, `DISCORD_RPC=true`, app was rebuilt after config changes |
| MPV is not detected | `input-ipc-server` in `mpv.conf` matches `MPV_IPC_PATH` |
| Stremio button says server offline | Run `npm run bridge` or `npm run start:all` |
| Stremio works on a custom port in browser but not userscript | Update `CONFIG.SERVER_URL` in the userscript |
| Anime title/episode looks wrong | Clear `.anime_cache/`, enable `DEBUG=true`, check parser/provider logs |
| MAL or Trakt does not sync | Re-run the auth command and confirm the relevant `*_SYNC=true` setting |


## Releases

Releases are automated with **semantic-release** and split into two independent streams:

| App | Tag format | Changelog | Scope |
| --- | --- | --- | --- |
| Root RPC app | `mpv-rpc-v${version}` | `CHANGELOG.md` | Non-bridge paths |
| Stremio bridge | `bridge-v${version}` | `stremio-mpv-bridge/CHANGELOG.md` | `stremio-mpv-bridge/**` |

Use Conventional Commits. Do not run `npm version` manually for project releases.

Local release helpers:

```bash
npm run release:dry
npm run release
npm run release:bridge:dry
npm run release:bridge
```

For local semantic-release runs, keep `GH_TOKEN` or `GITHUB_TOKEN` in `.env`.

## Recommended MPV scripts

| Script | Description |
| --- | --- |
| [SmartSkip](https://github.com/Eisa01/mpv-scripts#smartskip) | Automatically skip intros, outros, and silence |
| [SmartCopyPaste](https://github.com/Eisa01/mpv-scripts#smartcopypaste) | Copy/paste video paths, URLs, and timestamps |

## Credits

- [iamkroot/trakt-scrobbler](https://github.com/iamkroot/trakt-scrobbler) — reference implementation for Trakt.tv scrobbling and OAuth device flow patterns.
- [PreMiD](https://premid.app/) — asset reference.

## License

MIT License. See [LICENSE](LICENSE) for details.
