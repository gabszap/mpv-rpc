# MPV Discord RPC

Discord Rich Presence for MPV Media Player with automatic anime metadata support.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-blue?style=for-the-badge" alt="English"></a>
  <a href="README_PT.md"><img src="https://img.shields.io/badge/Português-green?style=for-the-badge" alt="Português"></a>
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Demo" width="600">
  <br>
  <em>Demo</em>
</p>

## About

**MPV Discord RPC** is a tool developed in Node.js that integrates your MPV Media Player with Discord, displaying what you're watching in real time. The main highlight of this project is its ability to automatically identify anime through the file name and fetch detailed information, such as covers and official titles, using the MyAnimeList API (Jikan).

> [!NOTE]
> The **showCover** feature only works for anime at the moment. Configuration can be done via `.env` file.


### Features

- Automatic anime detection from file name
- Metadata fetching via Jikan API (MyAnimeList)
- Anime cover display in Rich Presence
- Local cache to avoid repeated requests
- Privacy mode

## Requirements

- Node.js 20+
- Python 3.12+
- MPV Media Player
- Discord Desktop

> **Note:** Python is required to run the `guessit` library, used in the parsing module to identify titles, seasons, and episodes from file names.

## Quick Start

```bash
# Clone and install
git clone https://github.com/gabszap/mpv-rpc.git && cd mpv-rpc
pip install guessit && npm install

# Add to mpv.conf
echo 'input-ipc-server=\\.\pipe\mpv' >> "%APPDATA%/mpv/mpv.conf"  # Windows
echo 'input-ipc-server=/tmp/mpv-socket' >> ~/.config/mpv/mpv.conf  # Linux

# Build and run
npm run dev
```

## Installation

1. Clone the repository:
```bash
git clone https://github.com/gabszap/mpv-rpc.git
cd mpv-rpc
```

2. Install GuessIt (file name parsing):
```bash
pip install guessit
```

3. Install Node dependencies:
```bash
npm install
```

4. Build the project:
```bash
npm run build
```

## MPV Configuration

MPV needs to be started with the IPC server enabled. Add to your `mpv.conf`:

```ini
input-ipc-server=\\.\pipe\mpv
```

Or start manually:
```bash
mpv --input-ipc-server=\\.\pipe\mpv <file>
```

## Usage

Start the application:
```bash
npm start
```

Or build and run in a single command:
```bash
npm run dev
```

> **Note:** Any changes made to the project require running `npm run build` or `npm run dev` to rebuild and execute the updates.

The application will:
1. Connect to Discord
2. Look for MPV (with automatic reconnection)
3. Update Rich Presence in real time

## Configuration

Settings can be adjusted in `.env`:

| Option | Description | Default |
|--------|-------------|---------|
| `showCover` | Show anime cover | `true` |
| `privacyMode` | Hide media details | `false` |
| `hideIdling` | Hide status when idle | `false` |
| `showTitleAsPresence` | Use anime title as activity name | `true` |
| `preferredTitleLanguage` | Preferred title language (`english`, `romaji`, `none`) | `none` |

## How It Works

1. **IPC Connection**: The application connects to MPV via named pipe to obtain real-time playback data (title, position, duration, pause state).

2. **Parsing**: The file name is analyzed to extract information such as series title, season, and episode.

3. **Metadata**: If detected as anime, the Jikan API is queried to obtain cover, translated titles, and episode information.

4. **Rich Presence**: The data is formatted and sent to Discord, including progress bar and state icons.

## Examples

### Title Language Preference

| Romaji | English | Filename |
|:------:|:-------:|:--------:|
| ![Romaji](assets/romaji.png) | ![English](assets/english.png) | ![Filename](assets/filename.png) |

> *"Filename" displays the original file name as the title.*

### Cover Display and Title as Activity

| showCover | showTitleAsPresence |
|:---------:|:-------------------:|
| ![showCover](assets/filename.png) | ![showTitleAsPresence](assets/english.png) |

### Privacy Mode

![Privacy Mode](assets/privacymode.png)

## Recommended MPV Scripts

For an even better MPV experience, check out these useful scripts from [Eisa01/mpv-scripts](https://github.com/Eisa01/mpv-scripts):

| Script | Description |
|--------|-------------|
| [SmartSkip](https://github.com/Eisa01/mpv-scripts#smartskip) | Automatically skip intros, outros, and silence in videos |
| [SmartCopyPaste](https://github.com/Eisa01/mpv-scripts#smartcopypaste) | Copy/paste video paths, URLs, and timestamps with Ctrl+C/V |

## Dependencies

- [@xhayper/discord-rpc](https://www.npmjs.com/package/@xhayper/discord-rpc) - Discord RPC Client
- [axios](https://www.npmjs.com/package/axios) - HTTP Client
- [guessit](https://pypi.org/project/guessit/) - File name parser
- [jikan](https://jikan.moe/) - Authless MAL API
- [PreMiD](https://premid.app/) - I got some assets from here

## Contributing

Contributions are welcome! Feel free to open issues and pull requests.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## TODO

- [x] Linux support (Unix sockets)
- [x] Configuration via `.env` file
- [ ] Metadata for movies and TV series (TMDb/OMDb)
- [ ] MAL sync (mark as watched)
- [ ] System Tray (run in background)
- [ ] AniList and Kitsu API support
- [ ] Graphical interface (GUI) for easy configuration
- [ ] Mini Mode (Show only "Watching [Filename]" without metadata fetch)

## License

MIT