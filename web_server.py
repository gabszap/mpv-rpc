import json
import re

import pywintypes
import win32file
import win32pipe
from flask import Flask, jsonify
from guessit import guessit

app = Flask(__name__)
PIPE_NAME = r"\\.\pipe\mpv"


def parse_title(filename):
    if not filename or filename == "N/A":
        return "N/A"
    guessed = guessit(filename)
    title = guessed.get("title", filename)
    season = guessed.get("season")
    episode = guessed.get("episode")
    episode_title = guessed.get("episode_title")

    result = title
    if season is not None and episode is not None:
        result += f" - S{season:02d}E{episode:02d}"
    elif episode is not None:
        result += f" - E{episode:02d}"  # Para anime sem temporada, adiciona só E01
    if episode_title:
        result += f" - {episode_title}"

    return result


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
            result, data = win32file.ReadFile(handle, 1024)
            response = json.loads(data.decode("utf-8").strip())
            return response.get("data", "N/A")

        filename = query("filename/no-ext")
        parsed_title = parse_title(filename)
        set_msg = (
            json.dumps(
                {
                    "command": ["set_property", "media-title", parsed_title],
                    "request_id": 2,
                }
            ).encode("utf-8")
            + b"\n"
        )
        win32file.WriteFile(handle, set_msg)
        win32file.ReadFile(handle, 1024)  # Consome resposta (opcional)

        data = {
            "media_title": parsed_title,
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
            "mpv_version": query("mpv-version"),
        }

        # Adicione aqui: Combine media_title com meta_title se existir
        meta_title = data.get("meta_title")
        if meta_title and meta_title != "N/A":
            data["media_title"] += f" - {meta_title}"

        win32file.CloseHandle(handle)
        return data
    except pywintypes.error:
        return {"error": "MPV não conectado"}


@app.route("/")
def home():
    data = get_mpv_data()
    if "error" in data:
        return f"<h1>Erro: {data['error']}</h1>"

    status = "Pausado" if data["pause"] else "Tocando"
    buffering = "Sim" if data["buffering"] else "Não"
    return f"""
    <h1>Mídia atual: {data["media_title"]}</h1>
    <p>Status: {status} | Buffering: {buffering}</p>
    <p>Posição: {data["percent_pos"]:.1f}% ({data["time_pos"]:.1f}s / {data["duration"]:.1f}s)</p>
    <p>Volume: {data["volume"]} | Velocidade: {data["speed"]}</p>
    <p>Formato: {data["file_format"]} | Resolução: {data["width"]}x{data["height"]} | FPS: {data["fps"]}</p>
    <p>Metadados - Título: {data["meta_title"]} | Artista: {data["artist"]} | Álbum: {data["album"]}</p>
    <p>Loop - Arquivo: {data["loop_file"]} | Playlist: {data["loop_playlist"]}</p>
    <p>Versão MPV: {data["mpv_version"]}</p>
    """


@app.route("/api")
def api():
    return jsonify(get_mpv_data())


if __name__ == "__main__":
    app.run(debug=True)
