# MPV Discord RPC

Discord Rich Presence para o MPV Media Player com suporte automático a metadados de anime.

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

## Sobre

O **MPV Discord RPC** é uma ferramenta desenvolvida em Node.js que integra o seu MPV Media Player ao Discord, exibindo o que você está assistindo em tempo real. O grande diferencial deste projeto é a sua capacidade de identificar automaticamente animes através do nome do arquivo e buscar informações detalhadas, como capas e títulos oficiais, utilizando a API do MyAnimeList (Jikan).

> [!NOTE]
> A função **showCover** funciona apenas para animes no momento. A configuração pode ser feita via arquivo `.env`.


### Recursos

- Detecção automática de anime a partir do nome do arquivo
- Busca de metadados via API Jikan (MyAnimeList)
- Exibição de capas de anime no Rich Presence
- Sincronização MyAnimeList: Atualização automática do seu progresso
- Stremio MPV Bridge: Abra streams do Stremio Web diretamente no MPV
    - Suporte a Playlists automáticas
    - Sincronização de progresso para filmes e séries
    - Compatibilidade de player para animes (Kitsu)
- Cache local para evitar requisições repetidas
- Modo privacidade

## Requisitos

- Node.js 20+
- Python 3.12+
- MPV Media Player
- Discord Desktop

> [!IMPORTANT]
> Certifique-se de que o **Node.js** e o **Python** estejam adicionados ao **PATH** do seu sistema.

> **Nota:** O Python é necessário para executar a biblioteca `guessit`, usada no módulo de parsing para identificar títulos, temporadas e episódios a partir dos nomes dos arquivos.

## Início Rápido

```bash
# Clone e instale
git clone https://github.com/gabszap/mpv-rpc.git && cd mpv-rpc
pip install guessit && npm install

# Configure o .env com o ID da aplicação do Discord Developer Portal
cp .env.example .env

# Adicione ao mpv.conf
echo 'input-ipc-server=\\.\pipe\mpv' >> "%APPDATA%/mpv/mpv.conf"  # Windows
echo 'input-ipc-server=/tmp/mpv-socket' >> ~/.config/mpv/mpv.conf  # Linux

# Compile e execute
npm run dev
```

## Instalação

1. Clone o repositório:
```bash
git clone https://github.com/gabszap/mpv-rpc.git
cd mpv-rpc
```

2. Instale o GuessIt (parsing de nomes de arquivos):
```bash
pip install guessit
```

3. Instale as dependências Node:
```bash
npm install
```

4. Compile o projeto:
```bash
npm run build
```

## Configuração do MPV

O MPV precisa ser iniciado com o servidor IPC habilitado. Adicione ao seu `mpv.conf`:

```ini
input-ipc-server=\\.\pipe\mpv
```

Ou inicie manualmente:
```bash
mpv --input-ipc-server=\\.\pipe\mpv <arquivo>
```

## Uso

Inicie a aplicação:
```bash
npm start
```

Ou compile e execute em um único comando:
```bash
npm run dev
```

> **Nota:** Qualquer alteração feita no projeto requer a execução de `npm run build` ou `npm run dev` para recompilar e aplicar as atualizações.

A aplicação irá:
1. Conectar ao Discord
2. Procurar pelo MPV (com reconexão automática)
3. Atualizar o Rich Presence em tempo real
4. Sincronizar progresso com o MyAnimeList (se ativado e autenticado)

## Sincronização com o MAL

Você pode sincronizar automaticamente o seu progresso de episódios assistidos com o MyAnimeList. Isso requer uma autenticação única.

Para instruções detalhadas de como configurar e autorizar a sincronização, consulte o [Guia de Configuração do MyAnimeList](docs/mal-sync-setup.md).

## Stremio MPV Bridge

Você pode integrar o Stremio Web com o MPV usando a bridge (ponte). Isso permite abrir streams diretamente no MPV com suporte inteligente a playlists para episódios.

> [!IMPORTANT]
> **Limitação de Sincronização:** O progresso de visualização (marcar como assistido) de volta para o Stremio funciona **apenas para itens baseados em IDs do IMDb (tt0000000)**. 
> Conteúdos de catálogos como o Kitsu possuem estruturas de ID incompatíveis e funcionarão apenas no modo player (sem sincronizar o progresso no Stremio).

**Destaques:**
- **Sincronização:** O progresso de filmes e séries é sincronizado automaticamente com sua conta do Stremio (marcando como "visto" ao atingir 90%).
- **Compatibilidade:** Suporte completo para reprodução de conteúdos do Kitsu (apenas player, sincronização de progresso não suportada).
- **Metadados:** Identificação aprimorada de títulos de séries e episódios diretamente da interface do Stremio.

Para instruções de configuração e uso, consulte o [Guia do Stremio MPV Bridge](docs/stremio-mpv-bridge.md).

## Configuração

As configurações podem ser ajustadas em `.env`:

| Opção | Descrição | Padrão |
|-------|-----------|--------|
| `showCover` | Exibir capa do anime | `true` |
| `privacyMode` | Ocultar detalhes da mídia | `false` |
| `hideIdling` | Ocultar status quando ocioso | `false` |
| `showTitleAsPresence` | Usar título do anime como nome da atividade | `true` |
| `preferredTitleLanguage` | Idioma preferido do título (`english`, `romaji`, `none`) | `none` |
| `MAL_SYNC` | Ativar sincronização com MyAnimeList | `false` |
| `MAL_CLIENT_ID` | MyAnimeList API Client ID | (vazio) |
| `MAL_SYNC_THRESHOLD` | % assistido para disparar sync (0-100) | `90` |
| `DISCORD_RPC` | Ativar o Discord Rich Presence | `true` |

## Como Funciona

1. **Conexão IPC**: A aplicação se conecta ao MPV via named pipe para obter dados de reprodução em tempo real (título, posição, duração, estado de pausa).

2. **Parsing**: O nome do arquivo é analisado para extrair informações como título da série, temporada e episódio.

3. **Metadados**: Se detectado como anime, a API Jikan é consultada para obter capa, títulos traduzidos e informações de episódio.

4. **Rich Presence**: Os dados são formatados e enviados ao Discord, incluindo barra de progresso e ícones de estado.

## Exemplos

### Preferência de Idioma do Título

| Romaji | English | Filename |
|:------:|:-------:|:--------:|
| ![Romaji](assets/romaji.png) | ![English](assets/english.png) | ![Filename](assets/filename.png) |

> *"Filename" exibe o nome original do arquivo como título.*

### Exibição de Capa e Título como Atividade

| showCover | showTitleAsPresence |
|:---------:|:-------------------:|
| ![showCover](assets/filename.png) | ![showTitleAsPresence](assets/english.png) |

### Modo Privacidade

![Privacy Mode](assets/privacymode.png)

## Scripts Recomendados para o MPV

Para uma experiência ainda melhor com o MPV, confira estes scripts úteis de [Eisa01/mpv-scripts](https://github.com/Eisa01/mpv-scripts):

| Script | Descrição |
|--------|-----------|
| [SmartSkip](https://github.com/Eisa01/mpv-scripts#smartskip) | Pula automaticamente intros, outros e silêncios em vídeos |
| [SmartCopyPaste](https://github.com/Eisa01/mpv-scripts#smartcopypaste) | Copia/cola caminhos de vídeo, URLs e timestamps com Ctrl+C/V |

## Dependências

- [@xhayper/discord-rpc](https://www.npmjs.com/package/@xhayper/discord-rpc) - Cliente Discord RPC
- [axios](https://www.npmjs.com/package/axios) - Cliente HTTP
- [guessit](https://pypi.org/project/guessit/) - Parser de nomes de arquivos
- [jikan](https://jikan.moe/) - Authless MAL API
- [anilist](https://anilist.co/) - Anilist API
- [kitsu](https://kitsu.io/) - Kitsu API
- [PreMiD](https://premid.app/) - peguei alguns recursos daqui

## Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para abrir issues e pull requests.

1. Faça um fork do projeto
2. Crie sua branch de feature (`git checkout -b feature/RecursoIncrivel`)
3. Commit suas mudanças (`git commit -m 'Adiciona RecursoIncrivel'`)
4. Push para a branch (`git push origin feature/RecursoIncrivel`)
5. Abra um Pull Request

## TODO

- [x] Suporte a Linux (Unix sockets)
- [x] Configuração via arquivo `.env`
- [x] Suporte para AniList API
- [x] Suporte para Kitsu API
- [x] Sincronização com MAL (marcar como assistido)
- [ ] Metadados para filmes e séries (TMDb/OMDb)
- [ ] System Tray (rodar em background)
- [ ] Interface gráfica (GUI) para facil configuração
- [ ] Modo Mini (Exibir apenas "Assistindo [Arquivo]" sem busca de metadados)


## Licença

MIT