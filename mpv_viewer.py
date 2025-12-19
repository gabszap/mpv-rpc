import json
import time

import pywintypes
import win32file
import win32pipe

PIPE_NAME = r"\\.\pipe\mpv"


def connect_to_mpv():
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
        print("Conectado ao MPV!")
        return handle
    except pywintypes.error as e:
        print(f"Erro ao conectar: {e}")
        return None


def send_command(handle, command, request_id):
    msg = (
        json.dumps({"command": command, "request_id": request_id}).encode("utf-8")
        + b"\n"
    )
    win32file.WriteFile(handle, msg)


def receive_response(handle):
    try:
        result, data = win32file.ReadFile(handle, 1024)
        response = data.decode("utf-8").strip()
        return json.loads(response)
    except:
        return None


def main():
    handle = connect_to_mpv()
    if not handle:
        return

    request_id = 1
    while True:
        # Título (já tem)
        send_command(handle, ["get_property", "media-title"], request_id)
        response = receive_response(handle)
        title = response.get("data", "N/A") if response else "Erro"
        request_id += 1

        # Pausa (já tem)
        send_command(handle, ["get_property", "pause"], request_id)
        response = receive_response(handle)
        paused = response.get("data", False) if response else False
        status = "Pausado" if paused else "Tocando"
        request_id += 1

        # Novos: Posição (%)
        send_command(handle, ["get_property", "percent-pos"], request_id)
        response = receive_response(handle)
        percent = response.get("data", 0) if response else 0
        request_id += 1

        # Novos: Posição em segundos
        send_command(handle, ["get_property", "time-pos"], request_id)
        response = receive_response(handle)
        time_pos = response.get("data", 0) if response else 0
        request_id += 1

        # Novos: Duração total
        send_command(handle, ["get_property", "duration"], request_id)
        response = receive_response(handle)
        duration = response.get("data", 0) if response else 0
        request_id += 1

        # Novos: Volume
        send_command(handle, ["get_property", "volume"], request_id)
        response = receive_response(handle)
        volume = response.get("data", 0) if response else 0
        request_id += 1

        # Exibe tudo
        print(f"Título: {title}")
        print(
            f"Status: {status} | Posição: {percent:.1f}% ({time_pos:.1f}s / {duration:.1f}s)"
        )
        print(f"Volume: {volume}")
        print("---")

        time.sleep(1)

    win32file.CloseHandle(handle)


if __name__ == "__main__":
    main()
