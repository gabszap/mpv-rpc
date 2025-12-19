# MPV Presence para PreMiD

Esta presença permite mostrar o que você está assistindo no MPV diretamente no seu Discord!

Como o MPV não possui uma interface web nativa (como o VLC), precisamos rodar um pequeno script Python para criar essa "ponte" entre o player e o PreMiD.

## 🚀 Como Configurar

### 1. Preparar o MPV
Certifique-se de que o MPV está configurado para expor o servidor IPC.
Adicione a seguinte linha ao seu arquivo `mpv.conf` (geralmente em `%APPDATA%\mpv\`):

```conf
input-ipc-server=\\.\pipe\mpv
```
Ou inicie o MPV via linha de comando:
```powershell
mpv --input-ipc-server=\\.\pipe\mpv "seu_video.mkv"
```

### 2. Instalar Dependências
Você precisa ter o [Python](https://www.python.org/) instalado.
Instale as bibliotecas necessárias:

```bash
pip install flask pywin32 guessit
```

### 3. Rodar o Servidor
Baixe o script `web_server.py` deste repositório e execute-o:

```bash
python web_server.py
```
Isso iniciará um servidor local em `http://localhost:5000`.

### 4. Tudo pronto!
Com o script rodando e o MPV aberto, o PreMiD detectará automaticamente o status e atualizará seu Discord.

## ✨ Funcionalidades
- Mostra o nome do Anime/Série
- Formata Temporada e Episódio (S01E05)
- Mostra "Assistindo" com tempo decorrido correto
- Ícones de Play/Pause automáticos
