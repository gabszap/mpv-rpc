# MPV Presence for PreMiD

This presence allows you to display what you are watching on MPV directly on your Discord!

Since MPV does not have a native web interface (like VLC), we need to run a small Python script to bridge the player and PreMiD.

## 🚀 Setup Guide

### 1. Configure MPV
Ensure MPV is configured to expose the IPC server.
Add the following line to your `mpv.conf` file (usually in `%APPDATA%\mpv\`):

```conf
input-ipc-server=\\.\pipe\mpv
```
Or start MPV via command line:
```powershell
mpv --input-ipc-server=\\.\pipe\mpv "your_video.mkv"
```

### 2. Install Dependencies
You need [Python](https://www.python.org/) installed.
Install the required libraries:

```bash
pip install flask pywin32 guessit
```

### 3. Run the Server
Download the `web_server.py` script from this repository and run it:

```bash
python web_server.py
```
This will start a local server at `http://localhost:5000`.

### 4. You're set!
With the script running and MPV open, PreMiD will automatically detect the status and update your Discord.

## ✨ Features
- Displays Anime/Series Title
- Formats Season and Episode (S01E05)
- Shows "Watching" with correct elapsed time
- Automatic Play/Pause icons