# Stremio MPV Bridge

One file, bilingual, mirrored sections.

- [English](#english)
- [Português](#português)

---

<a id="english"></a>
## English

### Index

- [Overview](#en-overview)
- [Why use Bridge + MPV-RPC together](#en-why-bridge-rpc)
- [Architecture at a glance](#en-architecture)
- [Features (current)](#en-features)
- [Install / setup](#en-install)
- [Concurrent usage (single terminal recommended)](#en-concurrent)
- [Configuration](#en-configuration)
- [Usage flows](#en-usage-flows)
- [Troubleshooting](#en-troubleshooting)
- [Contract (endpoints)](#en-contract)
- [FAQ + limitations](#en-faq)
- [Security / privacy note](#en-security)

---

<a id="en-overview"></a>
### Overview

**Stremio MPV Bridge** lets **Stremio Web** hand off playback to **MPV**.

It does this with two pieces:

1) a **browser userscript** that runs on `https://web.stremio.com/*`
2) a **local bridge server** (`stremio-mpv-bridge/server.js`) that receives a playlist and spawns MPV

If you also run **MPV-RPC** (`npm start` in this repo), you can get your usual MPV-RPC features while the Bridge focuses on “open this Stremio stream in MPV”.

<a id="en-why-bridge-rpc"></a>
### Why use Bridge + MPV-RPC together

The Bridge and the RPC app solve different parts of the workflow:

- **Bridge**: “From Stremio Web, open the selected stream in MPV (optionally as a playlist).”
- **MPV-RPC (this repo’s main app)**: “While MPV is playing, read MPV state and drive integrations (e.g., Discord Rich Presence; optional anime metadata / MAL sync depending on your config).”

Practical daily workflow (typical):

1) Start both services with a single command: `npm run start:all`
   (or run them separately: `npm start` + `npm run bridge`)
2) In Stremio Web, click the MPV button (or your shortcut) to open the episode in MPV.

Benefits:

- You keep Stremio’s discovery/UI, but playback happens in MPV.
- MPV gets you advanced playback controls, audio/subtitle handling, and your existing MPV configuration.
- The Bridge is intentionally small and local; the RPC app remains the place for “rich presence / metadata / sync”.

<a id="en-architecture"></a>
### Architecture at a glance

```
Stremio Web (browser)
  └─ userscript (stremio-mpv.user.js)
       └─ HTTP to local bridge
            ├─ GET  http://localhost:9632/health
            └─ POST http://localhost:9632/play   (playlist / urls)
                 └─ spawns MPV (MPV_PATH) with a temporary .m3u playlist

Meanwhile (optional, but recommended):
MPV-RPC app (npm start)
  └─ connects to MPV IPC and publishes activity (Discord / metadata / MAL sync if enabled)
```

Key point: **the Bridge does not replace MPV-RPC**. It’s an “open in MPV” companion.

<a id="en-features"></a>
### Features (current)

Only features that exist in the current code/userscript are listed here.

- **Stremio Web integration** via userscript (`@match https://web.stremio.com/*`).
- **Floating MPV button** inside Stremio Web UI (opens the currently selected content in MPV).
- **Keyboard shortcut** (default: `v`, configurable in the userscript settings modal).
- **Playlist support**:
  - single item
  - batch mode (loads current + N next episodes; `extraEpisodes`, default `2`, range `1..25`)
  - “all” mode (attempt to load all remaining episodes)
- **Provider list + ordering** inside a settings modal (built-in + debrid + custom manifests).
  - Built-in providers include: Torrentio, Comet, MediaFusion, Sootio, AIOStreams
  - Debrid options include: Torbox, Real Debrid
  - Custom providers: paste an addon URL (the userscript can resolve a display name via `/manifest.json`)
- **Open arbitrary URL** from the settings modal (handy for quick testing).
- **Local server endpoints**:
  - `GET /health` (returns `{ status: "ok", mpvPath: ... }`)
  - `POST /play` (accepts a playlist and starts MPV)

Non-features (intentionally not claimed):

- The Bridge does not itself do Discord Rich Presence / MAL sync.

<a id="en-install"></a>
### Install / setup

#### Prerequisites

- Node.js + npm
- MPV installed (you may need to set `MPV_PATH` if it’s not in the default location)
- A userscript manager:
  - **Violentmonkey** (often easiest)
  - Tampermonkey also works

#### 1) Install dependencies (workspace root)

From the repository root:

```bash
npm install
```

#### 2) Start the Bridge server

From the repository root:

```bash
npm run bridge
```

By default it listens on:

- `http://localhost:9632`

#### 3) Install the userscript

Install this file in your userscript manager:

- `stremio-mpv-bridge/stremio-mpv.user.js`

Then open:

- https://web.stremio.com/

and confirm the script is enabled for that site.

> [!NOTE]
> The userscript’s default bridge URL is `http://localhost:9632`.
> If you change the server port (via `PORT`), you must also update the userscript’s `SERVER_URL` constant to match.

<a id="en-concurrent"></a>
### Concurrent usage (single terminal recommended)

### Single terminal (recommended)

Use the `start:all` script to run both the RPC app and the bridge in one terminal with a single command:

```bash
npm run start:all
```

This launches both services. The RPC app's interactive REPL (for commands like `status`, `set`, `rename`) receives keyboard input, while the bridge server runs silently in the background.

> [!TIP]
> Commands typed into the terminal go to the RPC REPL by default. Use `help` to see available commands.

Can also be run in separate terminals:

Terminal A (MPV-RPC app):

```bash
npm start
```

Terminal B (Bridge server):

```bash
npm run bridge
```

<a id="en-configuration"></a>
### Configuration

#### Bridge server (environment variables)

The bridge server reads:

- `PORT` — server port (default: `9632`)
- `MPV_PATH` — full path to your MPV executable
  - default in code: `"mpv"` (resolves via system `PATH` on Linux/macOS; Windows users should set it explicitly)

> [!TIP]
> The recommended way is to set `MPV_PATH` in the **`.env` file** at the project root (shared with the RPC app).
> Example `.env` entry:
> ```
> MPV_PATH=C:\Program Files\mpv\mpv.exe
> ```

Can also be passed via environment variable:

Windows (PowerShell):

```powershell
$env:MPV_PATH="C:\\Program Files\\mpv\\mpv.exe"
npm run bridge
```

macOS / Linux (bash/zsh):

```bash
MPV_PATH=/usr/bin/mpv npm run bridge
```

#### Userscript settings (inside Stremio Web)

The userscript includes a settings modal (“MPV Bridge Settings”) that lets you adjust:

- Active providers (enable/disable, add custom provider URLs, reorder)
- Playlist mode (`single`, `batch`, `all`)
- Extra episodes count (only in batch mode)
- Keyboard shortcut (default `v`)

#### Userscript bridge URL (port mismatch)

Currently, the bridge URL is a constant in the userscript:

- `CONFIG.SERVER_URL` (default: `http://localhost:9632`)

If your bridge is not on `9632`, edit that value in `stremio-mpv-bridge/stremio-mpv.user.js`, then re-install / re-save the script in your userscript manager.

<a id="en-usage-flows"></a>
### Usage flows

#### First-time setup flow

1) Run the bridge: `npm run bridge`
2) Install/enable the userscript in your browser.
3) Open Stremio Web.
4) Open the userscript settings (gear icon next to the MPV UI button).
5) (Optional) Add or reorder providers.
6) Pick a playlist mode:
   - **Single** for “just play this episode”
   - **Batch** for “play this episode + next N”
   - **All** for “try to enqueue everything remaining”
7) Click the MPV button (or press your shortcut) on an episode.

#### Daily use flow

1) Start both services (recommended):
   ```bash
   npm run start:all
   ```
   (Or run them separately: `npm start` + `npm run bridge` in two terminals.)
2) Browse in Stremio Web and pick an episode.
3) Click the MPV button (or press the shortcut).
4) MPV opens with a temporary `.m3u` playlist.

<a id="en-troubleshooting"></a>
### Troubleshooting

#### Bridge not reachable (button does nothing / errors)

Checklist:

- Is the bridge running in a terminal? (`npm run bridge`)
- Is the port correct? (default is `9632`)
- Does the health check work?
  - Open in your browser: `http://localhost:9632/health`
  - Expected: JSON with `status: "ok"`

If you changed `PORT`, also update the userscript’s `CONFIG.SERVER_URL`.

#### MPV path issues (bridge runs, but MPV never opens)

Symptoms:

- Bridge prints an error on `POST /play`.
- No MPV window appears.

Fix:

- Set `MPV_PATH` to your MPV executable.
  - Windows example: `C:\\Program Files\\mpv\\mpv.exe`
  - Linux example: `/usr/bin/mpv`
  - If you use `flatpak`, you may need a wrapper command rather than a direct path.

#### Userscript inactive (no MPV button)

Checklist:

- Confirm your userscript manager is enabled.
- Confirm the script is enabled for `https://web.stremio.com/*`.
- Reload the page after enabling.

#### Port mismatch

Symptoms:

- Bridge health works on a non-default port, but the userscript still targets `9632`.

Fix:

- Either run the bridge on `9632` (default), or edit the userscript `CONFIG.SERVER_URL` to match your chosen port.

<a id="en-contract"></a>
### Contract (endpoints)

The Bridge server is intentionally minimal.

- `GET /health` — status check
- `POST /play` — open one or more items in MPV

> [!IMPORTANT]
> If you’re looking for playback tracking and integrations (Discord/metadata/MAL), that belongs in the MPV-RPC app, not in this bridge.

<a id="en-faq"></a>
### FAQ + limitations

**Does the Bridge work without MPV-RPC?**

Yes. The Bridge can open MPV on its own. MPV-RPC is optional and provides the “while MPV plays, integrate with Discord/metadata/MAL” side.

**Does the Bridge control MPV over IPC?**

No. It spawns MPV with a temporary playlist file. MPV-RPC separately talks to MPV via IPC.

**Can I change the bridge URL from the UI?**

Not currently. The server URL is a constant (`CONFIG.SERVER_URL`) in the userscript.

**What does “playlist support” mean here?**

The userscript can send multiple URLs (current + next episodes) and the bridge converts them into a `.m3u` file that MPV loads.

**Limitations to be aware of**

- The bridge is local-only and intended for personal use.
- If your MPV path is non-standard, you must set `MPV_PATH`.
- If your port changes, you must keep userscript `SERVER_URL` in sync.

<a id="en-security"></a>
### Security / privacy note

- The bridge listens on `localhost` and is designed to be used from your machine.
- The browser userscript sends stream URLs to your local bridge so it can spawn MPV.
- Treat stream URLs as sensitive: they may include tokens or session identifiers depending on your addon/provider.

---

<a id="português"></a>
## Português

### Índice

- [Descrição geral](#pt-descricao-geral)
- [Por que usar Bridge + MPV-RPC juntos](#pt-por-que-bridge-rpc)
- [Arquitetura em resumo](#pt-arquitetura)
- [Recursos (atuais)](#pt-recursos)
- [Instalação / configuração](#pt-instalacao)
- [Uso simultâneo (terminal único recomendado)](#pt-uso-simultaneo)
- [Configuração](#pt-configuracao)
- [Fluxos de uso](#pt-fluxos)
- [Solução de problemas](#pt-troubleshooting)
- [Contrato (endpoints)](#pt-contrato)
- [FAQ + limitações](#pt-faq)
- [Nota rápida de segurança/privacidade](#pt-seguranca)

---

<a id="pt-descricao-geral"></a>
### Descrição geral

O **Stremio MPV Bridge** permite que o **Stremio Web** envie a reprodução para o **MPV**.

Ele funciona com duas partes:

1) um **userscript** que roda no navegador em `https://web.stremio.com/*`
2) um **servidor local (bridge)** (`stremio-mpv-bridge/server.js`) que recebe uma playlist e abre o MPV

Se você também rodar o **MPV-RPC** (`npm start` neste repositório), você mantém os recursos do MPV-RPC enquanto o Bridge cuida do “abrir o stream do Stremio no MPV”.

<a id="pt-por-que-bridge-rpc"></a>
### Por que usar Bridge + MPV-RPC juntos

O Bridge e o app principal (MPV-RPC) resolvem partes diferentes do fluxo:

- **Bridge**: “No Stremio Web, abrir o stream selecionado no MPV (opcionalmente como playlist).”
- **MPV-RPC (app principal deste repo)**: “Enquanto o MPV toca, ler o estado do MPV e alimentar integrações (ex.: Discord Rich Presence; e opcionalmente metadados/MAL sync dependendo da sua configuração).”

Fluxo prático do dia a dia (comum):

1) Inicie ambos os serviços com um único comando: `npm run start:all`
   (ou separadamente: `npm start` + `npm run bridge`)
2) No Stremio Web, clique no botão do MPV (ou use o atalho) para abrir o episódio no MPV.

Benefícios:

- Você continua usando a UI do Stremio, mas a reprodução acontece no MPV.
- O MPV oferece controles avançados, melhor manuseio de áudio/legendas e sua configuração pessoal.
- O Bridge é propositalmente simples e local; o MPV-RPC é onde ficam “presence / metadados / sync”.

<a id="pt-arquitetura"></a>
### Arquitetura em resumo

```
Stremio Web (navegador)
  └─ userscript (stremio-mpv.user.js)
       └─ HTTP para o bridge local
            ├─ GET  http://localhost:9632/health
            └─ POST http://localhost:9632/play   (playlist / urls)
                 └─ abre o MPV (MPV_PATH) com uma playlist .m3u temporária

Em paralelo (opcional, mas recomendado):
App MPV-RPC (npm start)
  └─ conecta no IPC do MPV e publica atividade (Discord / metadados / MAL sync se habilitado)
```

Ponto-chave: **o Bridge não substitui o MPV-RPC**. Ele é um complemento para “abrir no MPV”.

<a id="pt-recursos"></a>
### Recursos (atuais)

Somente recursos que existem no código/userscript atual estão listados aqui.

- **Integração com Stremio Web** via userscript (`@match https://web.stremio.com/*`).
- **Botão flutuante do MPV** na UI do Stremio Web (abre o conteúdo atual no MPV).
- **Atalho de teclado** (padrão: `v`, configurável no modal de configurações).
- **Suporte a playlist**:
  - item único
  - modo em lote (episódio atual + N próximos; `extraEpisodes`, padrão `2`, intervalo `1..25`)
  - modo “all” (tentar enfileirar todos os episódios restantes)
- **Lista de provedores + ordem** dentro de um modal de configurações (embutidos + debrid + manifests custom).
  - Provedores embutidos: Torrentio, Comet, MediaFusion, Sootio, AIOStreams
  - Opções de debrid: Torbox, Real Debrid
  - Provedores custom: cole a URL do addon (o userscript pode resolver o nome via `/manifest.json`)
- **Abrir URL manualmente** a partir do modal (útil para testes rápidos).
- **Endpoints do servidor local**:
  - `GET /health`
  - `POST /play`

Não é recurso (não afirmar):

- O Bridge não faz Discord Rich Presence / MAL sync por conta própria.

<a id="pt-instalacao"></a>
### Instalação / configuração

#### Pré-requisitos

- Node.js + npm
- MPV instalado (talvez você precise definir `MPV_PATH` se não estiver no caminho padrão)
- Um gerenciador de userscripts:
  - **Violentmonkey** (geralmente o mais simples)
  - Tampermonkey também funciona

#### 1) Instalar dependências (na raiz do workspace)

Na raiz do repositório:

```bash
npm install
```

#### 2) Iniciar o servidor Bridge

Na raiz do repositório:

```bash
npm run bridge
```

Por padrão ele escuta em:

- `http://localhost:9632`

#### 3) Instalar o userscript

Instale este arquivo no seu gerenciador de userscripts:

- `stremio-mpv-bridge/stremio-mpv.user.js`

Depois abra:

- https://web.stremio.com/

e confirme que o script está ativo.

> [!NOTE]
> O userscript usa por padrão `http://localhost:9632`.
> Se você mudar a porta do servidor (via `PORT`), também precisa atualizar a constante `SERVER_URL` no userscript.

<a id="pt-uso-simultaneo"></a>
### Uso simultâneo (terminal único recomendado)

### Terminal único (recomendado)

Use o script `start:all` para rodar o app RPC e o bridge em um único terminal com um só comando:

```bash
npm run start:all
```

Isso inicia ambos os serviços. O REPL interativo do app RPC (comandos como `status`, `set`, `rename`) recebe o input do teclado, enquanto o servidor bridge roda silenciosamente em segundo plano.

> [!TIP]
> Comandos digitados no terminal vão para o REPL do RPC por padrão. Use `help` para ver os comandos disponíveis.

### Dois terminais (ainda funciona)

Para usar **Bridge + MPV-RPC** ao mesmo tempo, rode os dois em paralelo:

Terminal A (app MPV-RPC):

```bash
npm start
```

Terminal B (servidor Bridge):

```bash
npm run bridge
```

> [!IMPORTANT]
> O comando correto do bridge neste repositório é **`npm run bridge`**.
> Se você encontrar referências antigas como `npm run start:bridge`, elas estão desatualizadas.

<a id="pt-configuracao"></a>
### Configuração

#### Servidor Bridge (variáveis de ambiente)

O servidor do bridge lê:

- `PORT` — porta do servidor (padrão: `9632`)
- `MPV_PATH` — caminho completo para o executável do MPV
  - padrão no código: `"mpv"` (resolve via `PATH` do sistema no Linux/macOS; usuários Windows devem definir explicitamente)

> [!TIP]
> O jeito recomendado é definir `MPV_PATH` no arquivo **`.env`** na raiz do projeto (compartilhado com o app RPC).
> Exemplo de entrada no `.env`:
> ```
> MPV_PATH=C:\Program Files\mpv\mpv.exe
> ```

Também pode ser passado via variável de ambiente:

Windows (PowerShell):

```powershell
$env:MPV_PATH="C:\\Program Files\\mpv\\mpv.exe"
npm run bridge
```

macOS / Linux (bash/zsh):

```bash
MPV_PATH=/usr/bin/mpv npm run bridge
```

#### Configurações do userscript (dentro do Stremio Web)

O userscript tem um modal (“MPV Bridge Settings”) com:

- Provedores ativos (habilitar/desabilitar, adicionar URLs custom, reordenar)
- Modo de playlist (`single`, `batch`, `all`)
- Quantidade de episódios extras (apenas no modo batch)
- Atalho de teclado (padrão `v`)

#### URL do bridge no userscript (mismatch de porta)

No momento, a URL do servidor é uma constante no userscript:

- `CONFIG.SERVER_URL` (padrão: `http://localhost:9632`)

Se seu bridge não estiver na porta `9632`, edite esse valor em `stremio-mpv-bridge/stremio-mpv.user.js` e re-instale / re-salve o script no gerenciador.

<a id="pt-fluxos"></a>
### Fluxos de uso

#### Primeiro uso (setup inicial)

1) Rode o bridge: `npm run bridge`
2) Instale/ative o userscript no navegador.
3) Abra o Stremio Web.
4) Abra as configurações do userscript (ícone de engrenagem ao lado do botão do MPV).
5) (Opcional) Adicione ou reordene provedores.
6) Escolha o modo de playlist:
   - **Single** para “tocar só este episódio”
   - **Batch** para “tocar este episódio + próximos N”
   - **All** para “tentar enfileirar tudo o que falta”
7) Clique no botão do MPV (ou pressione o atalho) em um episódio.

#### Uso diário

1) Inicie ambos os serviços (recomendado):
   ```bash
   npm run start:all
   ```
   (Ou inicie separadamente: `npm start` + `npm run bridge` em dois terminais.)
2) Escolha um episódio no Stremio Web.
3) Clique no botão do MPV (ou use o atalho).
4) O MPV abre com uma playlist `.m3u` temporária.

<a id="pt-troubleshooting"></a>
### Solução de problemas

#### Bridge não alcançável (botão não faz nada / dá erro)

Checklist:

- O bridge está rodando em algum terminal? (`npm run bridge`)
- A porta está correta? (padrão `9632`)
- O health check funciona?
  - Abra no navegador: `http://localhost:9632/health`
  - Esperado: JSON com `status: "ok"`

Se você alterou `PORT`, também precisa atualizar `CONFIG.SERVER_URL` no userscript.

#### Problema no caminho do MPV (bridge roda, mas o MPV não abre)

Sintomas:

- O bridge imprime erro ao receber `POST /play`.
- Nenhuma janela do MPV aparece.

Correção:

- Defina `MPV_PATH` apontando para o executável do MPV.
  - Windows: `C:\\Program Files\\mpv\\mpv.exe`
  - Linux: `/usr/bin/mpv`
  - Se você usa `flatpak`, talvez precise de um wrapper em vez de um caminho direto.

#### Userscript inativo (não aparece botão do MPV)

Checklist:

- Confirme que o gerenciador de userscripts está habilitado.
- Confirme que o script está ativo para `https://web.stremio.com/*`.
- Recarregue a página após ativar.

#### Porta diferente (mismatch)

Sintomas:

- O health do bridge funciona em outra porta, mas o userscript continua mirando `9632`.

Correção:

- Rode o bridge em `9632` (padrão) **ou** edite `CONFIG.SERVER_URL` no userscript para bater com sua porta.

<a id="pt-contrato"></a>
### Contrato (endpoints)

O servidor do bridge é propositalmente minimalista.

- `GET /health` — checagem de status
- `POST /play` — abre um ou mais itens no MPV

> [!IMPORTANT]
> Se você busca acompanhamento da reprodução e integrações (Discord/metadados/MAL), isso deve ficar no app MPV-RPC, não neste bridge.

<a id="pt-faq"></a>
### FAQ + limitações

**O Bridge funciona sem o MPV-RPC?**

Sim. O Bridge consegue abrir o MPV sozinho. O MPV-RPC é opcional e fornece a parte de “integrar com Discord/metadados/MAL enquanto o MPV toca”.

**O Bridge controla o MPV via IPC?**

Não. Ele abre o MPV passando uma playlist temporária. O MPV-RPC fala com o MPV via IPC separadamente.

**Dá para mudar a URL do bridge pela UI?**

Ainda não. A URL é uma constante (`CONFIG.SERVER_URL`) dentro do userscript.

**O que significa “suporte a playlist” aqui?**

O userscript pode enviar múltiplas URLs (episódio atual + próximos) e o bridge transforma isso em um `.m3u` que o MPV carrega.

**Limitações importantes**

- O bridge é local e voltado para uso pessoal.
- Se o caminho do MPV for diferente, você precisa definir `MPV_PATH`.
- Se você mudar a porta, mantenha `SERVER_URL` do userscript sincronizado.

<a id="pt-seguranca"></a>
### Nota rápida de segurança/privacidade

- O bridge escuta em `localhost` e foi pensado para rodar na sua máquina.
- O userscript envia URLs de stream para o seu bridge local para que ele consiga abrir o MPV.
- Trate URLs de stream como sensíveis: dependendo do addon/provedor, podem existir tokens/sessões embutidos.
