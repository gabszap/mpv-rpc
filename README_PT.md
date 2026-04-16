# MPV Discord RPC

Discord Rich Presence para o MPV Media Player com suporte automático a metadados de anime.

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge" alt="License">

  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white&style=for-the-badge" alt="TypeScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white&style=for-the-badge" alt="Windows">
  <img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black&style=for-the-badge" alt="Linux">
  <img src="https://img.shields.io/badge/Built%20with-Claude-D97757?logo=claude&logoColor=white&style=for-the-badge" alt="Built with Claude">
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Demo" width="600">
  <br>
  <em>RPC em ação</em>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_PT.md">Português</a>
</p>

---

## Sumário

- [Visão Geral](#visão-geral)
- [Recursos](#recursos)
- [Requisitos](#requisitos)
- [Início Rápido](#início-rápido)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Configuração do MPV](#configuração-do-mpv)
- [Sincronização MyAnimeList](#sincronização-myanimelist)
- [Stremio MPV Bridge](#stremio-mpv-bridge)
- [Capturas de Tela](#capturas-de-tela)
- [Releases](#releases)
- [Contribuindo](#contribuindo)

---

## Visão Geral

O **MPV Discord RPC** é uma ferramenta que integra o seu MPV Media Player ao Discord, exibindo o que você está assistindo em tempo real. O grande diferencial é a detecção automática de animes através dos nomes dos arquivos, buscando metadados detalhados (capas, títulos oficiais) usando a API do MyAnimeList.

---

## Recursos

**Recursos Principais**
- Detecção automática de anime a partir do nome do arquivo
- Busca de metadados via API Jikan (MyAnimeList)
- Exibição de capas de anime no Discord Rich Presence
- Cache local para evitar requisições repetidas à API
- Modo de privacidade para ocultar detalhes da mídia

**Recursos de Integração**
- **Sincronização MyAnimeList:** Atualização automática do seu progresso
- **Stremio MPV Bridge:** Abra streams do Stremio Web diretamente no MPV
  - Suporte inteligente a playlists automáticas
  - Compatibilidade de player para Anime (Kitsu)

> **Nota:** A exibição de capas funciona apenas para animes no momento. Configure isso no arquivo `.env`.

---

## Requisitos

- Node.js 22 ou superior
- MPV Media Player
- Aplicativo Discord Desktop

### Opcional: Python (para GuessIt CLI local)

O Python **não é mais necessário** se você usar a API GuessIt em nuvem! O parser agora suporta três modos:

1. **☁️ API em Nuvem** (recomendado) - Não precisa de Python, funciona em todas as plataformas
2. **💻 CLI Local** - Requer `pip install guessit` (Python 3.12+)
3. **🔤 Regex Fallback** - Sempre disponível, parsing básico apenas

> **Novos usuários:** Use a API em nuvem configurando `GUESSIT_API_URL` no arquivo `.env`. Veja [Configuração da API GuessIt](#configuração-da-api-guessit) abaixo.

> **Usuários existentes:** Sua instalação local do `guessit` ainda funciona como fallback.

---

## Início Rápido

### Opção 1: API em Nuvem (Sem Python Necessário) ⭐ Recomendado

```bash
# Clone e instale apenas as dependências Node
git clone https://github.com/gabszap/mpv-rpc.git && cd mpv-rpc
npm install

# Configure o ambiente
cp .env.example .env
# Edite .env e configure: GUESSIT_API_URL=https://sua-api.vercel.app/api/parse

# Adicione o servidor IPC à configuração do MPV
echo 'input-ipc-server=\\.\pipe\mpv' >> "%APPDATA%/mpv/mpv.conf"  # Windows
echo 'input-ipc-server=/tmp/mpv-socket' >> ~/.config/mpv/mpv.conf  # Linux

# Compile e execute
npm run dev
```

### Opção 2: GuessIt Local (Python Necessário)

```bash
# Clone e instale as dependências (incluindo Python guessit)
git clone https://github.com/gabszap/mpv-rpc.git && cd mpv-rpc
pip install guessit && npm install

# Configure o ambiente
cp .env.example .env

# Adicione o servidor IPC à configuração do MPV
echo 'input-ipc-server=\\.\pipe\mpv' >> "%APPDATA%/mpv/mpv.conf"  # Windows
echo 'input-ipc-server=/tmp/mpv-socket' >> ~/.config/mpv/mpv.conf  # Linux

# Compile e execute
npm run dev
```

---

## Instalação

### 1. Clonar o Repositório

```bash
git clone https://github.com/gabszap/mpv-rpc.git
cd mpv-rpc
```

### 2. Instalar Dependências do Node

```bash
npm install
```

### 3. (Opcional) Instalar GuessIt Localmente

Apenas necessário se quiser usar CLI local em vez da API em nuvem:

```bash
pip install guessit
```

### 4. Compilar o Projeto

```bash
npm run build
```

---

## Configuração da API GuessIt

**Sem Python? Sem problema!** Agora você pode usar uma API GuessIt em nuvem em vez de instalar Python localmente.

### Usando a API Pronta

Você tem duas opções para usar a API em nuvem:

#### Opção A: Usar Nossa API Pública (Mais Rápida) 🚀

Use nossa API já deployada - nenhuma configuração necessária!

1. **Simplesmente adicione ao seu arquivo `.env`**:
   ```env
   USE_GUESSIT_API=true
   GUESSIT_API_URL=https://guessit-api.vercel.app/api/parse
   ```

2. **Pronto!** Inicie o mpv-rpc e ele usará nossa API em nuvem.

> **Aviso de Privacidade:** 
> - O código da API é open source e não coleta ou armazena nenhum dado do usuário
> - A API apenas recebe nomes de arquivos e retorna metadados parseados - nada é salvo pelo nosso código
> - Não temos motivo para coletar seus dados, e não queremos fazê-lo
> 
> Esta é uma API pública gratuita hospedada na Vercel. Embora nos esforcemos para mantê-la funcionando, para máxima privacidade ou uso intenso você pode querer fazer o deploy da sua própria (Opção B).

#### Opção B: Fazer Deploy da Sua Própria API (Recomendado para Privacidade)

O projeto inclui uma API Vercel pronta para deploy na pasta `guessit-api/`:

1. **Fazer deploy da API** (configuração única):
   ```bash
   cd guessit-api
   npm i -g vercel  # Instale o Vercel CLI se ainda não tiver
   vercel
   # Siga as instruções para fazer o deploy
   ```

2. **Copie a URL do deploy** (ex: `https://seu-projeto.vercel.app/api/parse`)

3. **Configure o mpv-rpc** para usá-la:
   ```bash
   cd ..
   cp .env.example .env
   # Edite .env e adicione:
   # USE_GUESSIT_API=true
   # GUESSIT_API_URL=https://seu-projeto.vercel.app/api/parse
   ```

### Prioridade do Parser

O parser automaticamente tenta estes métodos em ordem:

1. **API em Nuvem** - Se `GUESSIT_API_URL` estiver configurado
2. **CLI Local** - Se `guessit` estiver instalado localmente
3. **Regex Fallback** - Matching de padrões básico (sempre funciona)

### Benefícios da API em Nuvem

- ✅ Não requer instalação do Python
- ✅ Funciona identicamente no Windows, Linux e macOS
- ✅ Sempre usa a versão mais recente do guessit
- ✅ Cache inteligente (sem chamadas repetidas para o mesmo arquivo)
- ✅ Zero dependências locais além do Node.js

---

## Configuração

Copie o arquivo de ambiente de exemplo e ajuste as configurações:

```bash
cp .env.example .env
```

Os valores de ambiente são carregados automaticamente via `dotenv` a partir do arquivo `.env` na inicialização.

### Opções Disponíveis

| Opção | Descrição | Padrão |
|-------|-----------|--------|
| `SHOW_COVER` | Exibir imagem da capa do anime | `true` |
| `PRIVACY_MODE` | Ocultar todos os detalhes da mídia | `false` |
| `HIDE_IDLING` | Ocultar status quando o MPV estiver ocioso | `false` |
| `SHOW_TITLE` | Usar título do anime como nome da atividade | `true` |
| `TITLE_LANG` | Idioma preferido do título (`english`, `romaji`, `none`) | `none` |
| `METADATA_PROVIDER` | Fonte de metadados (`jikan`, `anilist`, `kitsu`, `tvdb`) | `jikan` |
| `TVDB_API_KEY` | Chave de API do TheTVDB (obrigatória ao usar `tvdb`, opcional para fallbacks) | (vazio) |
| `TVDB_LANG` | Código de idioma preferido do TheTVDB para metadados de episódios | `eng` |
| `USE_GUESSIT_API` | Usar API em nuvem para parsing de nomes de arquivo | `true` |
| `GUESSIT_API_URL` | URL do endpoint da sua API GuessIt | (vazio) |
| `MAL_SYNC` | Ativar sincronização com MyAnimeList | `false` |
| `MAL_CLIENT_ID` | MyAnimeList API Client ID | (vazio) |
| `MAL_SYNC_THRESHOLD` | Porcentagem assistida para disparar sync (0-100) | `90` |
| `DISCORD_RPC` | Ativar Discord Rich Presence | `true` |

---

## Configuração do MPV

O MPV deve ser iniciado com o servidor IPC habilitado.

### Opção 1: Arquivo de Configuração

Adicione ao seu `mpv.conf`:

```ini
# Windows
input-ipc-server=\\.\pipe\mpv

# Linux
input-ipc-server=/tmp/mpv-socket
```

### Opção 2: Linha de Comando

```bash
# Windows
mpv --input-ipc-server=\\.\pipe\mpv <arquivo>

# Linux
mpv --input-ipc-server=/tmp/mpv-socket <arquivo>
```

---

## Uso

Inicie a aplicação:

```bash
npm start
```

Ou compile e execute em um comando:

```bash
npm run dev
```

> **Nota:** Após fazer alterações no código, execute `npm run build` ou `npm run dev` para recompilar.

**A aplicação irá:**
1. Conectar ao Discord
2. Monitorar instâncias do MPV (com reconexão automática)
3. Atualizar seu status no Discord em tempo real
4. Sincronizar progresso com o MyAnimeList (se ativado e autenticado)

---

## Sincronização MyAnimeList

Sincronize automaticamente seu progresso de visualização com o MyAnimeList. Requer autenticação única.

Para instruções detalhadas de configuração, consulte o [Guia de Configuração do MAL](docs/mal-sync-setup.md).

---

## Stremio MPV Bridge

Integre o Stremio Web com o MPV para abrir streams diretamente no player com suporte inteligente a playlists.

**Recursos:**
- Suporte completo de reprodução para conteúdo do Kitsu
- Identificação aprimorada de títulos de séries e episódios do Stremio

Para instruções de configuração, consulte o [Guia do Stremio MPV Bridge](docs/stremio-mpv-bridge.md).

---

## Como Funciona

1. **Conexão IPC:** Conecta ao MPV via named pipe/Unix socket para obter dados de reprodução em tempo real (título, posição, duração, estado de pausa)

2. **Análise do Nome do Arquivo:** Analisa o nome do arquivo para extrair título da série, temporada e informações do episódio

3. **Busca de Metadados:** Se detectado como anime, consulta a API Jikan para obter imagens de capa, títulos traduzidos e dados de episódios

4. **Rich Presence:** Formata e envia os dados para o Discord com barras de progresso e ícones de estado

---

## Capturas de Tela

### Opções de Idioma do Título

| Romaji | English | Filename |
|:------:|:-------:|:--------:|
| ![Romaji](assets/romaji.png) | ![English](assets/english.png) | ![Filename](assets/filename.png) |

### Opções de Configuração

| showCover | showTitleAsPresence |
|:---------:|:-------------------:|
| ![showCover](assets/filename.png) | ![showTitleAsPresence](assets/english.png) |

### Modo de Privacidade

![Privacy Mode](assets/privacymode.png)

---

## Scripts Recomendados

Melhore sua experiência com o MPV usando estes scripts úteis do [Eisa01/mpv-scripts](https://github.com/Eisa01/mpv-scripts):

| Script | Descrição |
|--------|-----------|
| [SmartSkip](https://github.com/Eisa01/mpv-scripts#smartskip) | Pula automaticamente intros, outros e silêncios |
| [SmartCopyPaste](https://github.com/Eisa01/mpv-scripts#smartcopypaste) | Copia/cola caminhos de vídeo, URLs e timestamps |

---

## Dependências

- [@xhayper/discord-rpc](https://www.npmjs.com/package/@xhayper/discord-rpc) - Cliente Discord RPC
- [axios](https://www.npmjs.com/package/axios) - Cliente HTTP
- [dotenv](https://www.npmjs.com/package/dotenv) - Loader de `.env`
- [guessit](https://pypi.org/project/guessit/) - Parser de nomes de arquivos
- [Jikan](https://jikan.moe/) - API não oficial do MyAnimeList
- [AniList](https://anilist.co/) - API AniList
- [Kitsu](https://kitsu.io/) - API Kitsu
- [PreMiD](https://premid.app/) - Referência de assets

---

## Releases

As releases do projeto são automatizadas com **semantic-release** em pushes para `main`.

- O versionamento e as notas de release são gerados a partir de **Conventional Commits**.
- O `CHANGELOG.md` é gerado/atualizado automaticamente pelo workflow de release.
- Não execute `npm version` manualmente para releases do projeto.

---

## Contribuindo

Contribuições são bem-vindas. Sinta-se à vontade para abrir issues e pull requests.

1. Faça um fork do projeto
2. Crie sua branch de feature (`git checkout -b feature/RecursoIncrivel`)
3. Commit suas mudanças (`git commit -m 'Adiciona RecursoIncrivel'`)
4. Push para a branch (`git push origin feature/RecursoIncrivel`)
5. Abra um Pull Request

---

## TODO

**Concluído:**
- [x] Suporte a Linux (Unix sockets)
- [x] Configuração via arquivo `.env`
- [x] Suporte a API AniList
- [x] Suporte a API Kitsu
- [x] Sincronização com MAL (marcar como assistido)
- [x] **API GuessIt em Nuvem** - Sem Python necessário!

**Planejado:**
- [ ] Metadados para filmes e séries de TV (TMDb/OMDb)
- [ ] Bandeja do sistema (rodar em background)
- [ ] Interface gráfica (GUI) para configuração
- [ ] Modo Mini (exibir apenas nome do arquivo sem busca de metadados)

---

## Licença

Licença MIT - veja os arquivos do projeto para mais detalhes.
