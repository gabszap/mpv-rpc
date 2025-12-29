# Stremio MPV Bridge

[English](#english) | [Português](#português)

---

<a name="english"></a>
## 🇺🇸 English

### 📝 Overview
**Stremio MPV Bridge** is a powerful integration that allows you to bypass the browser-based Stremio player and open your streams directly in **MPV**. It combines a local server with a browser userscript to fetch stream links from various Stremio addons (like Torrentio) and feed them into a high-performance MPV playlist. This allows for better playback control, shaders, and a superior viewing experience.

### 🚀 Features

*   **Seamless Integration**: A floating MPV purple button appears on Stremio Web.
*   **Smart Playlist**: Automatically fetches and adds subsequent episodes to MPV's playlist.
*   **Multiple Providers**: Support for Torrentio, Comet, MediaFusion, Torbox, Real-Debrid, and custom addons.
*   **Keyboard Shortcut**: Press `V` to instantly play the selected episode.
*   **In-App Settings**: Configure providers and playlist modes directly within the Stremio interface.

### 🛠️ Installation

#### 1. Local Bridge Server
The server acts as a bridge between your browser and the MPV player. This project uses **npm workspaces**, so all dependencies are installed from the root directory.

```bash
# 1. Open a terminal in the project root
# 2. Install all dependencies for both RPC and Bridge
npm install

# 3. Start the bridge server
npm run bridge
```
The server runs on `http://localhost:9632`.

> [!IMPORTANT]
> **Concurrent Usage**: If you want to use both **Discord RPC** and the **Stremio Bridge**, you currently need to keep **two separate terminals open**: 
> 1. One for the Discord RPC (`npm start` in the root folder).
> 2. One for the Stremio Bridge (`npm run start:bridge` in the root folder).

**Optional Environment Variables:**
- `PORT`: Server port (default: 9632).
- `MPV_PATH`: Full path to your MPV executable (default: `C:\Program Files\mpv\mpv.exe`).

#### 2. Userscript
1.  Install a userscript manager like **Violentmonkey** (recommended) or **Tampermonkey**.
2.  Install the `stremio-mpv.user.js` script.
3.  Ensure the script is active when visiting [web.stremio.com](https://web.stremio.com/).

### ⚙️ Configuration

1.  Open Stremio Web and go to any content detail page or the Addons page.
2.  Click the **Gear Icon** ⚙️ next to the MPV button.
3.  **Addons Setup**: Paste the "Manifest URL" of your favorite addons (found in the "Share" button of the addon).
4.  **Playlist Mode**:
    *   **Fixed**: Loads a specific number of next episodes.
    *   **All**: Attempts to load all remaining episodes of the season.
5.  **Shortcut**: Customize the key to trigger MPV playback.

### 📖 Usage

1.  Make sure the local server is running (`npm run bridge`).
2.  Navigate to an episode on Stremio Web.
3.  Click the **Purple MPV Icon** in the bottom right corner or press `V`.
4.  MPV will open and begin streaming immediately.

---

<a name="português"></a>
## 🇧🇷 Português

### 📝 Descrição Geral
O **Stremio MPV Bridge** é uma integração poderosa que permite ignorar o player padrão do navegador e abrir seus vídeos diretamente no **MPV**. Ele utiliza um servidor local em conjunto com um userscript para capturar links de stream de diversos addons (como Torrentio) e enviá-los para uma playlist no MPV. Com isso, você ganha acesso a todos os recursos avançados do MPV, como shaders, filtros e controle total de legendas.

### 🚀 Recursos

*   **Integração Fluida**: Um botão roxo flutuante do MPV aparece no Stremio Web.
*   **Playlist Inteligente**: Busca e adiciona automaticamente os episódios subsequentes à playlist do MPV.
*   **Múltiplos Provedores**: Suporte para Torrentio, Comet, MediaFusion, Torbox, Real-Debrid e addons personalizados.
*   **Atalho de Teclado**: Pressione `V` para reproduzir instantaneamente o episódio selecionado.
*   **Configurações Internas**: Configure provedores e modos de playlist diretamente na interface do Stremio.

### 🛠️ Instalação

#### 1. Servidor Bridge Local
O servidor atua como uma ponte entre o navegador e o player MPV. Este projeto utiliza **npm workspaces**, portanto todas as dependências são instaladas a partir da raiz.

```bash
# 1. Abra um terminal na raiz do projeto
# 2. Instale todas as dependências (RPC e Bridge)
npm install

# 3. Inicie o servidor bridge
npm run bridge
```
O servidor rodará em `http://localhost:9632`.

> [!IMPORTANT]
> **Uso Simultâneo**: Caso você queira utilizar tanto o **Discord RPC** quanto o **Stremio Bridge**, por enquanto é necessário manter **dois terminais abertos**:
> 1. Um para o Discord RPC (`npm start` na pasta raiz).
> 2. Outro para o Stremio Bridge (`npm run bridge` na pasta raiz).

**Variáveis de Ambiente Opcionais:**
- `PORT`: Porta do servidor (padrão: 9632).
- `MPV_PATH`: Caminho completo para o executável do MPV (padrão: `C:\Program Files\mpv\mpv.exe`).

#### 2. Userscript
1.  Instale um gerenciador de userscripts como **Violentmonkey** (recommended) ou **Tampermonkey**.
2.  Instale o script `stremio-mpv.user.js`.
3.  Verifique se o script está ativo ao visitar [web.stremio.com](https://web.stremio.com/).

### ⚙️ Configuração

1.  Abra o Stremio Web e vá para qualquer página de detalhes ou a página de Addons.
2.  Clique no **Ícone de Engrenagem** ⚙️ ao lado do botão do MPV.
3.  **Configuração de Addons**: Cole a "Manifest URL" dos seus addons favoritos (encontrada no botão "Share" do addon).
4.  **Modo de Playlist**:
    *   **Fixed**: Carrega um número específico de próximos episódios.
    *   **All**: Tenta carregar todos os episódios restantes da temporada.
5.  **Atalho**: Customize a tecla para abrir no MPV.

### 📖 Uso

1.  Certifique-se de que o servidor local está rodando (`npm run bridge`).
2.  Navegue até um episódio no Stremio Web.
3.  Clique no **Ícone Roxo do MPV** no canto inferior direito ou pressione `V`.
4.  O MPV abrirá e começará a reproduzir o vídeo imediatamente.
