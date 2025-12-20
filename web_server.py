import json
import re
import pywintypes
import win32file
import win32pipe
from flask import Flask, jsonify
from guessit import guessit
from anime_lookup import get_anime_cover, get_episode_title, get_anime_info

app = Flask(__name__)
PIPE_NAME = r"\\.\pipe\mpv"


def parse_title_data(filename):
    if not filename or filename == "N/A":
        return {
            "full_title": "N/A", 
            "series_title": "N/A",
            "season": None,
            "episode": None,
            "episode_title": None
        }
    
    guessed = guessit(filename)
    title = guessed.get("title", filename)
    season = guessed.get("season")
    episode = guessed.get("episode")
    episode_title = guessed.get("episode_title")
    
    # Fallback: try to extract S##E## with regex if guessit didn't detect it
    # This handles cases like "Re.Zero - S03E01" where guessit might fail
    if season is None or episode is None:
        se_match = re.search(r'[Ss](\d{1,2})[Ee](\d{1,3})', filename)
        if se_match:
            if season is None:
                season = int(se_match.group(1))
            if episode is None:
                episode = int(se_match.group(2))
            # Clean up title if it contains the S##E## pattern in alternative_title
            if guessed.get("alternative_title") and re.match(r'S\d+E\d+', guessed.get("alternative_title", "")):
                # guessit misidentified S##E## as alternative_title, keep just the title
                pass

    # Build full formatted title
    full_title = title
    if season is not None and episode is not None:
        full_title += f" - S{season:02d}E{episode:02d}"
    elif episode is not None:
        full_title += f" - E{episode:02d}"
    if episode_title:
        full_title += f" - {episode_title}"

    return {
        "full_title": full_title,
        "series_title": title,
        "season": season,
        "episode": episode,
        "episode_title": episode_title
    }


def get_mpv_data():
    try:
        handle = win32file.CreateFile(
            PIPE_NAME,
            win32file.GENERIC_READ | win32file.GENERIC_WRITE,
            0,
            None,
            win32file.OPEN_EXISTING,
            0,
            None,
        )

        def query(prop):
            msg = (
                json.dumps({"command": ["get_property", prop], "request_id": 1}).encode(
                    "utf-8"
                )
                + b"\n"
            )
            win32file.WriteFile(handle, msg)
            result, data = win32file.ReadFile(handle, 4096)
            
            # Handle multiple JSON responses in buffer - take only the first line
            text = data.decode("utf-8").strip()
            if "\n" in text:
                text = text.split("\n")[0]
            
            try:
                response = json.loads(text)
                return response.get("data", "N/A")
            except json.JSONDecodeError:
                return "N/A"

        filename = query("filename/no-ext")
        parsed = parse_title_data(filename)
        
        # Set media title in MPV (optional, keeps consistency)
        set_msg = (
            json.dumps(
                {
                    "command": ["set_property", "media-title", parsed["full_title"]],
                    "request_id": 2,
                }
            ).encode("utf-8")
            + b"\n"
        )
        win32file.WriteFile(handle, set_msg)
        win32file.ReadFile(handle, 1024)

        data = {
            "media_title": parsed["full_title"],
            "series_title": parsed["series_title"],
            "season": parsed["season"],
            "episode": parsed["episode"],
            "episode_title": parsed["episode_title"],
            "filename": query("filename"),
            "pause": query("pause"),
            "percent_pos": query("percent-pos"),
            "time_pos": query("time-pos"),
            "duration": query("duration"),
            "volume": query("volume"),
            "speed": query("speed"),
            "file_format": query("file-format"),
            "meta_title": query("metadata/by-key/Title"),
            "width": query("width"),
            "height": query("height"),
            "fps": query("estimated-vf-fps"),
            "buffering": query("paused-for-cache"),
            "loop_file": query("loop-file"),
            "loop_playlist": query("loop-playlist"),
            "artist": query("metadata/by-key/Artist"),
            "album": query("metadata/by-key/Album"),
            "mpv_version": query("mpv-version"),
        }

        # Combine media_title with meta_title if exists
        meta_title = data.get("meta_title")
        if meta_title and meta_title != "N/A" and isinstance(meta_title, str):
             # Avoid duplicating if meta_title is already in full_title
            if meta_title not in data["media_title"]:
                data["media_title"] += f" - {meta_title}"

        # Fetch anime metadata if it looks like an anime
        cover_url = None
        if parsed["series_title"] and parsed["series_title"] != "N/A":
            try:
                # Check if title is too short (likely truncated/abbreviated)
                title_is_short = len(parsed["series_title"]) < 10
                
                if title_is_short:
                    # Short title - fetch full title from API
                    anime_info = get_anime_info(
                        parsed["series_title"],
                        parsed["season"]
                    )
                    
                    if anime_info:
                        cover_url = anime_info.get("cover_url")
                        
                        # Use full title from API (prioritize English, fallback to Romaji)
                        full_title = anime_info.get("title_english") or anime_info.get("title_romaji")
                        if full_title:
                            data["series_title"] = full_title
                            # Update media_title to use full title
                            data["media_title"] = parsed["full_title"].replace(
                                parsed["series_title"], 
                                full_title
                            )
                else:
                    # Good title - only fetch cover, preserve filename title
                    cover_url = get_anime_cover(
                        parsed["series_title"],
                        parsed["season"]
                    )
                
                # Get episode title if not in filename
                if not parsed["episode_title"] and parsed["episode"]:
                    ep_title = get_episode_title(
                        parsed["series_title"],
                        parsed["season"],
                        parsed["episode"]
                    )
                    if ep_title:
                        data["episode_title"] = ep_title
                        # Update media_title to include episode title
                        if " - " not in data["media_title"] or data["media_title"].endswith(f"E{parsed['episode']:02d}"):
                            data["media_title"] += f" - {ep_title}"
                        
            except Exception as e:
                print(f"[web_server] Error fetching anime metadata: {e}")
        
        data["cover_image"] = cover_url


        win32file.CloseHandle(handle)
        return data
    except pywintypes.error:
        return {"error": "MPV não conectado"}


@app.route("/")
def home():
    data = get_mpv_data()
    has_error = "error" in data
    
    # Initial values for display
    if has_error:
        json_data = json.dumps(data)
        media_title = f"Erro: {data['error']}"
        status_text = "N/A"
        position_text = "N/A"
        volume_text = "N/A"
        format_text = "N/A"
        meta_text = "N/A"
        loop_text = "N/A"
        mpv_version = "N/A"
    else:
        json_data = json.dumps(data)
        status = "Pausado" if data["pause"] else "Tocando"
        buffering = "Sim" if data["buffering"] else "Não"
        media_title = data["media_title"]
        status_text = f"Status: {status} | Buffering: {buffering}"
        
        # Handle N/A values for numeric fields (when MPV is open but no media playing)
        percent = data.get('percent_pos')
        time = data.get('time_pos')
        dur = data.get('duration')
        if isinstance(percent, (int, float)) and isinstance(time, (int, float)) and isinstance(dur, (int, float)):
            position_text = f"Posição: {percent:.1f}% ({time:.1f}s / {dur:.1f}s)"
        else:
            position_text = "Posição: N/A"
        
        volume_text = f"Volume: {data['volume']} | Velocidade: {data['speed']}"
        format_text = f"Formato: {data['file_format']} | Resolução: {data['width']}x{data['height']} | FPS: {data['fps']}"
        meta_text = f"Metadados - Título: {data['meta_title']} | Artista: {data['artist']} | Álbum: {data['album']}"
        loop_text = f"Loop - Arquivo: {data['loop_file']} | Playlist: {data['loop_playlist']}"
        mpv_version = f"Versão MPV: {data['mpv_version']}"

    return f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>MPV Web Interface</title>
        <script id="premid-data" type="application/json">
            {json_data}
        </script>
        <script>
            setInterval(async () => {{
                try {{
                    const res = await fetch('/api');
                    if (res.ok) {{
                        const data = await res.json();
                        document.getElementById('premid-data').textContent = JSON.stringify(data);
                        
                        // Check for error state
                        if (data.error) {{
                            document.querySelector('h1').textContent = "Erro: " + data.error;
                            document.getElementById('status').textContent = "N/A";
                            document.getElementById('position').textContent = "N/A";
                            document.getElementById('volume').textContent = "N/A";
                            document.getElementById('format').textContent = "N/A";
                            document.getElementById('meta').textContent = "N/A";
                            document.getElementById('loop').textContent = "N/A";
                            document.getElementById('version').textContent = "N/A";
                            return;
                        }}
                        
                        // Update UI with valid data
                        const status = data.pause ? "Pausado" : "Tocando";
                        const buffering = data.buffering ? "Sim" : "Não";
                        document.querySelector('h1').textContent = "Mídia atual: " + data.media_title;
                        document.getElementById('status').textContent = `Status: ${{status}} | Buffering: ${{buffering}}`;
                        
                        // Handle N/A values for position
                        if (typeof data.percent_pos === 'number' && typeof data.time_pos === 'number' && typeof data.duration === 'number') {{
                            document.getElementById('position').textContent = `Posição: ${{data.percent_pos.toFixed(1)}}% (${{data.time_pos.toFixed(1)}}s / ${{data.duration.toFixed(1)}}s)`;
                        }} else {{
                            document.getElementById('position').textContent = "Posição: N/A";
                        }}
                        document.getElementById('volume').textContent = `Volume: ${{data.volume}} | Velocidade: ${{data.speed}}`;
                        document.getElementById('format').textContent = `Formato: ${{data.file_format}} | Resolução: ${{data.width}}x${{data.height}} | FPS: ${{data.fps}}`;
                        document.getElementById('meta').textContent = `Metadados - Título: ${{data.meta_title}} | Artista: ${{data.artist}} | Álbum: ${{data.album}}`;
                        document.getElementById('loop').textContent = `Loop - Arquivo: ${{data.loop_file}} | Playlist: ${{data.loop_playlist}}`;
                        document.getElementById('version').textContent = `Versão MPV: ${{data.mpv_version}}`;
                    }}
                }} catch (e) {{ console.error(e); }}
            }}, 1000);
        </script>
        <style>
            body {{ font-family: sans-serif; background: #121212; color: #fff; padding: 2rem; }}
        </style>
    </head>
    <body>
        <h1>Mídia atual: {media_title}</h1>
        <p id="status">{status_text}</p>
        <p id="position">{position_text}</p>
        <p id="volume">{volume_text}</p>
        <p id="format">{format_text}</p>
        <p id="meta">{meta_text}</p>
        <p id="loop">{loop_text}</p>
        <p id="version">{mpv_version}</p>
    </body>
    </html>
    """


@app.route("/api")
def api():
    return jsonify(get_mpv_data())


if __name__ == "__main__":
    app.run(debug=True)

