# Trakt.tv Sync Setup

[English](#english) | [Português](#português)

---

## English

This feature allows you to automatically scrobble your anime watch progress to your Trakt.tv profile.

### Prerequisites

1. **Trakt API Application**:
   - Go to [Trakt OAuth Applications](https://trakt.tv/oauth/applications).
   - Click "New Application".
   - Fill in:
     - **Name**: `trakt-sync` (or any name)
     - **Redirect URI**: `urn:ietf:wg:oauth:2.0:oob`
     - **Javascript Origins**: leave empty
     - **Permissions**: select `scrobble`
   - Save and copy your **Client ID** and **Client Secret**.

2. **TheTVDB API Key (recommended for anime)**: Needed to safely map aired/default season+episode numbers to absolute episode numbers for some anime syncs.

3. **Tor (optional)**: If your IP is blocked by Cloudflare, you can route requests through Tor. Requires Tor Browser or Tor service running.

### Configuration

Edit your `.env` file with the following settings:

```env
TRAKT_SYNC=true
TRAKT_CLIENT_ID=your_client_id_here
TRAKT_CLIENT_SECRET=your_client_secret_here
TRAKT_SYNC_THRESHOLD=80
TVDB_API_KEY=your_tvdb_key_here
```

- `TRAKT_SYNC`: Set to `true` to enable the feature.
- `TRAKT_CLIENT_ID`: The Client ID from your Trakt application.
- `TRAKT_CLIENT_SECRET`: The Client Secret from your Trakt application.
- `TRAKT_SYNC_THRESHOLD`: Percentage of the episode (0-100) that must be watched to trigger scrobble (default is 80).
- `TVDB_API_KEY`: TheTVDB key used for safe anime episode order mapping when needed.

#### Optional: Tor Proxy

If you encounter Cloudflare blocks, enable Tor:

```env
TRAKT_USE_TOR=true
TRAKT_TOR_PROXY=socks5://127.0.0.1:9150
```

- `TRAKT_USE_TOR`: Set to `true` to route Trakt requests through Tor.
- `TRAKT_TOR_PROXY`: Tor SOCKS5 proxy URL. Use `9150` for Tor Browser, `9050` for Tor service.

### Authentication

After configuring the `.env` file, you need to authorize the application:

1. Run the following command in your terminal:
   ```bash
   npm start -- trakt-auth
   ```
2. A browser window will open to `https://trakt.tv/activate`.
3. Enter the 8-character code shown in your terminal.
4. Click "Connect" to authorize the app.
5. Once you see "Authorization Successful", you can close the browser and start the RPC normally.

### How It Works

- **Media Resolution**: IMDB ID (from Stremio bridge) → TVDB ID → Title search fallback
- **Episode Order Mapping**: TheTVDB can map aired/default SxxEyy to absolute anime episodes; ambiguous syncs skip safely if mapping is unavailable.
- **Anime-only**: Only scrobbles when anime metadata is resolved (mal_id detected)
- **State Machine**: Tracks play/pause/stop transitions for accurate scrobbling
- **Cooldown**: 60-second cooldown per episode to avoid duplicate scrobbles

---

## Português

Esta funcionalidade permite sincronizar automaticamente o seu progresso de episódios assistidos com o seu perfil no Trakt.tv.

### Pré-requisitos

1. **Aplicação Trakt API**:
   - Vá para [Trakt OAuth Applications](https://trakt.tv/oauth/applications).
   - Clique em "New Application".
   - Preencha:
     - **Name**: `mpv-rpc` (ou qualquer nome)
     - **Redirect URI**: `urn:ietf:wg:oauth:2.0:oob`
     - **Javascript Origins**: deixe vazio
     - - **Permissões**: selecione `scrobble`
   - Salve e copie seu **Client ID** e **Client Secret**.

2. **Chave da API TheTVDB (recomendada para anime)**: Necessária para mapear com segurança temporada+episódio em ordem aired/default para episódio absoluto em alguns syncs de anime.

3. **Tor (opcional)**: Se seu IP estiver bloqueado pelo Cloudflare, você pode rotear as requisições pelo Tor. Requer Tor Browser ou serviço Tor rodando.

### Configuração

Edite o seu arquivo `.env` com as seguintes definições:

```env
TRAKT_SYNC=true
TRAKT_CLIENT_ID=seu_client_id_aqui
TRAKT_CLIENT_SECRET=seu_client_secret_aqui
TRAKT_SYNC_THRESHOLD=80
TVDB_API_KEY=sua_chave_tvdb_aqui
```

- `TRAKT_SYNC`: Defina como `true` para ativar a funcionalidade.
- `TRAKT_CLIENT_ID`: O Client ID da sua aplicação Trakt.
- `TRAKT_CLIENT_SECRET`: O Client Secret da sua aplicação Trakt.
- `TRAKT_SYNC_THRESHOLD`: Porcentagem do episódio (0-100) que deve ser assistida para disparar o scrobble (padrão é 80).
- `TVDB_API_KEY`: Chave TheTVDB usada para mapeamento seguro de ordem de episódios de anime quando necessário.

#### Opcional: Proxy Tor

Se encontrar bloqueios do Cloudflare, ative o Tor:

```env
TRAKT_USE_TOR=true
TRAKT_TOR_PROXY=socks5://127.0.0.1:9150
```

- `TRAKT_USE_TOR`: Defina como `true` para rotear requisições Trakt pelo Tor.
- `TRAKT_TOR_PROXY`: URL do proxy SOCKS5 do Tor. Use `9150` para Tor Browser, `9050` para serviço Tor.

### Autenticação

Após configurar o arquivo `.env`, você precisa autorizar a aplicação:

1. Execute o seguinte comando no terminal:
   ```bash
   npm start -- trakt-auth
   ```
2. Uma janela do navegador será aberta em `https://trakt.tv/activate`.
3. Digite o código de 8 caracteres mostrado no terminal.
4. Clique em "Connect" para autorizar o app.
5. Quando aparecer "Authorization Successful", você pode fechar o navegador e iniciar o RPC normalmente.

### Como Funciona

- **Resolução de Mídia**: IMDB ID (da bridge Stremio) → TVDB ID → Busca por título como fallback
- **Mapeamento de Ordem de Episódios**: TheTVDB pode mapear SxxEyy em ordem aired/default para episódios absolutos de anime; syncs ambíguos são pulados com segurança se o mapeamento estiver indisponível.
- **Apenas Anime**: Só faz scrobble quando metadados de anime são resolvidos (mal_id detectado)
- **State Machine**: Rastreia transições play/pause/stop para scrobble preciso
- **Cooldown**: 60 segundos de cooldown por episódio para evitar duplicatas
