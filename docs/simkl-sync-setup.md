# Simkl Sync Setup

[English](#english) | [Português](#português)

---

## English

Automatically track anime, TV series and movies in your Simkl account. Simkl sync works independently of MAL, Trakt and Stremio sync and is disabled by default.

### 1. Create your API application and get the Client ID

You need a **Client ID** from your own Simkl application. This is the value used as `SIMKL_CLIENT_ID`; authorizing your account comes afterward.

1. Sign in to [Simkl](https://simkl.com/) or [create an account](https://passport.simkl.com/register/).
2. Open **Settings → Developer** through [Developer settings](https://simkl.com/settings/developer/).
3. Create a new application. You can also open the [new application page](https://simkl.com/settings/developer/new/) directly.
4. Use **AUTH V2** for the registration.
5. Select **TV, devices & command line** as the client type. Although mpv-rpc runs on a desktop, it signs in through a terminal code, so this is the suitable registration type.
6. Fill in the requested application details. Suggested values:

   | Detail | Suggested value |
   | --- | --- |
   | Application name | `mpv-rpc` |
   | Description, if requested | `Track MPV playback in my Simkl account` |
   | Website, if requested | `https://github.com/gabszap/mpv-rpc` |

7. Save the application, open its details in the developer dashboard and copy the **Client ID** into your `.env` file as shown below.

For this client type, no **Client Secret** or **Redirect URI** is needed. If the registration requires a secret or callback URL, check that you selected **TV, devices & command line**. The client type cannot be changed after registration; create another app if the wrong type was chosen. See the [official client-type reference](https://api.simkl.org/api-reference/auth).

Use a new AUTH V2 registration if you already have an old V1 app. The [authentication overview](https://api.simkl.org/authentication) explains why its Client ID cannot be reused for V2.

### 2. Configure mpv-rpc

Edit `.env` in the repository root, next to `package.json`:

```dotenv
SIMKL_SYNC=true
SIMKL_CLIENT_ID=paste_your_v2_client_id_here
SIMKL_SYNC_THRESHOLD=80
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIMKL_SYNC` | `false` | Enable Simkl sync |
| `SIMKL_CLIENT_ID` | empty | Client ID copied from your AUTH V2 application |
| `SIMKL_SYNC_THRESHOLD` | `80` | Minimum watched percentage when playback stops; integer from 50 to 100 |

The Client ID identifies the app. An **access token** authorizes your account; mpv-rpc obtains and stores that token during the next step. Do not paste an access token, refresh token or Client Secret into `SIMKL_CLIENT_ID`.

For local movies and series, configure `TMDB_API_KEY` too if you need TMDb to resolve their identity. Existing trusted Stremio IDs can also identify playback. Anime uses the configured anime metadata providers. None of this requires enabling MAL or Trakt sync.

### 3. Authorize your Simkl account

Run these commands from the repository root:

```bash
npm run build
npm start -- simkl-auth
```

1. The terminal prints a verification link and a code. **Open that link yourself**; the command does not automatically launch a browser.
2. Sign in to the Simkl account where you want to save playback.
3. Enter the printed code if the page asks for it; the full link may already include it.
4. Approve the requested read/write access (`media:read media:write`).
5. Keep the terminal running until it displays:

   ```text
   [Simkl] Authorized.
   ```

6. Start mpv-rpc normally:

   ```bash
   npm start
   ```

   Or start both mpv-rpc and the Stremio bridge:

   ```bash
   npm run start:all
   ```

The startup message should report **Simkl sync: enabled**. Tokens are stored in the git-ignored `.config/.simkl_tokens.json` and renewed automatically. You do not need to copy tokens or authorize on every startup. Do not share the token file.

### 4. Understand when an item becomes watched

| Playback event | Result |
| --- | --- |
| Start or resume | Send a start event |
| Pause | Save partial progress without marking watched |
| Continue playing past 80% | Keep watching; no completion event |
| Stop, switch files, close MPV or exit mpv-rpc | Send a stop with the last observed percentage |
| Stop below the threshold | Save partial progress |
| Stop at or above the threshold | Mark watched after Simkl confirms completion |

**Example:** with the default threshold, pausing at 85% keeps the item partial. Stopping afterward at 85% marks it watched. Seeking back to 40% before stopping saves 40%, not the highest percentage reached.

Movies use movie IDs. Series use their season and episode. Anime can use MAL/AniList/Kitsu IDs with the episode number of the resolved cour. Missing or ambiguous identity is skipped rather than matched by title alone.

Changing the threshold with `.reload` applies it to the next session; the current item keeps its original threshold. Disabling sync finalizes the active session once. To switch accounts, stop mpv-rpc, run `npm start -- simkl-auth` again and restart.

### 5. Verify your setup and troubleshoot

Try one movie, one series episode and one anime episode. Pause above 80%, confirm it stays partial, then stop and check the watched status in Simkl. Also test a stop below 80%.

| Symptom | What to check |
| --- | --- |
| `SIMKL_CLIENT_ID not set` | Put the copied Client ID in the root `.env` and restart or run `.reload` |
| `invalid_client` or login fails immediately | Verify AUTH V2, the copied Client ID and the **TV, devices & command line** registration type |
| Authorization expires | Run `npm start -- simkl-auth` again and approve the new code before it expires |
| Missing write permission / `403` | Authorize again and approve read/write access |
| No reliable identity | Check the parsed episode and resolved metadata IDs; for local movies/series, check TMDb configuration |
| Paused at 90% but not watched | Expected: completion waits for stop, file change or closing playback |
| Temporary API failure / rate limit | Leave the app running for the bounded background retry; avoid repeatedly restarting it |

Actual API calls are logged to `.anime_cache/api_log.txt`, including when `DEBUG=false`. Tokens and authorization codes are excluded.

To simulate events without writing to your account, set `SYNC_DRY_RUN=true` and restart or run `.reload`. This option also affects the other sync integrations. Set it back to `false` before testing actual sync.

The retry queue is kept in memory. Shutdown waits at most eight seconds for pending writes; offline shutdown or forced termination can lose unsent events. There is no persistent offline replay.

---

## Português

Sincronize automaticamente animes, séries e filmes com sua conta do Simkl. O sync funciona independentemente do MAL, Trakt e Stremio e vem desativado por padrão.

### 1. Crie a aplicação da API e obtenha o Client ID

Você precisa do **Client ID** de uma aplicação criada na sua conta Simkl. Esse é o valor de `SIMKL_CLIENT_ID`; a autorização da conta acontece depois.

1. Entre no [Simkl](https://simkl.com/) ou [crie uma conta](https://passport.simkl.com/register/).
2. Acesse **Settings → Developer** pelo [painel de desenvolvedor](https://simkl.com/settings/developer/).
3. Crie uma aplicação. Você também pode abrir diretamente a [página de nova aplicação](https://simkl.com/settings/developer/new/).
4. Use **AUTH V2** no cadastro.
5. Escolha **TV, devices & command line** como tipo de cliente. Apesar de rodar no desktop, o mpv-rpc faz login por um código no terminal, então esse é o tipo adequado.
6. Preencha os dados de apresentação solicitados. Sugestões:

   | Dado | Valor sugerido |
   | --- | --- |
   | Nome da aplicação | `mpv-rpc` |
   | Descrição, se solicitada | `Sincronizar a reprodução do MPV com minha conta Simkl` |
   | Site, se solicitado | `https://github.com/gabszap/mpv-rpc` |

7. Salve a aplicação, abra seus detalhes no painel e copie o **Client ID** para o `.env`, como mostrado abaixo.

Esse tipo de cliente dispensa **Client Secret** e **Redirect URI**. Se o cadastro exigir segredo ou URL de callback, confira se escolheu **TV, devices & command line**. O tipo não pode ser alterado depois do cadastro; crie outra aplicação se tiver escolhido o tipo errado. Consulte a [referência oficial dos tipos de cliente](https://api.simkl.org/api-reference/auth).

Se você já tem uma aplicação V1 antiga, crie um cadastro AUTH V2 separado. A [visão geral de autenticação](https://api.simkl.org/authentication) explica por que o Client ID antigo não serve para V2.

### 2. Configure o mpv-rpc

Edite o `.env` na raiz do repositório, ao lado do `package.json`:

```dotenv
SIMKL_SYNC=true
SIMKL_CLIENT_ID=cole_seu_client_id_v2_aqui
SIMKL_SYNC_THRESHOLD=80
```

| Variável | Padrão | Função |
| --- | --- | --- |
| `SIMKL_SYNC` | `false` | Ativa o sync do Simkl |
| `SIMKL_CLIENT_ID` | vazio | Client ID copiado da sua aplicação AUTH V2 |
| `SIMKL_SYNC_THRESHOLD` | `80` | Percentual mínimo ao parar a reprodução; inteiro de 50 a 100 |

O Client ID identifica o aplicativo. O **access token** autoriza sua conta; o mpv-rpc obtém e salva esse token na próxima etapa. Não coloque access token, refresh token ou Client Secret no campo `SIMKL_CLIENT_ID`.

Para filmes e séries locais, configure também `TMDB_API_KEY` se precisar que o TMDb resolva a identidade do conteúdo. IDs confiáveis já capturados pelo Stremio também podem identificar a reprodução. Para animes, são usados os provedores de metadados configurados. Não é necessário ativar o sync do MAL ou do Trakt.

### 3. Autorize sua conta Simkl

Execute na raiz do repositório:

```bash
npm run build
npm start -- simkl-auth
```

1. O terminal vai mostrar um link de verificação e um código. **Abra esse link manualmente**; o comando não inicia o navegador automaticamente.
2. Entre na conta Simkl em que deseja salvar o progresso.
3. Digite o código do terminal se a página pedir; o link completo pode já incluir o código.
4. Autorize o acesso de leitura e escrita solicitado (`media:read media:write`).
5. Mantenha o terminal aberto até aparecer:

   ```text
   [Simkl] Authorized.
   ```

6. Inicie o mpv-rpc normalmente:

   ```bash
   npm start
   ```

   Ou inicie o mpv-rpc junto com a bridge do Stremio:

   ```bash
   npm run start:all
   ```

Na inicialização deve aparecer **Simkl sync: enabled**. Os tokens ficam em `.config/.simkl_tokens.json`, ignorado pelo Git, e são renovados automaticamente. Não precisa copiar tokens nem autorizar a cada inicialização. Não compartilhe esse arquivo.

### 4. Entenda quando um conteúdo vira assistido

| Evento de reprodução | Resultado |
| --- | --- |
| Iniciar ou retomar | Envia um evento de início |
| Pausar | Salva progresso parcial sem marcar como assistido |
| Continuar tocando depois de 80% | Continua em reprodução; não envia conclusão |
| Parar, trocar de arquivo, fechar o MPV ou encerrar o mpv-rpc | Envia o último percentual observado |
| Parar abaixo do limiar | Salva progresso parcial |
| Parar no limiar ou acima dele | Marca como assistido após a confirmação do Simkl |

**Exemplo:** com o padrão de 80%, pausar em 85% mantém o conteúdo parcial. Parar depois em 85% marca como assistido. Se você voltar para 40% antes de parar, são salvos 40%, e não o maior percentual alcançado.

Filmes usam IDs de filme. Séries usam sua temporada e episódio. Animes podem usar IDs MAL/AniList/Kitsu com o episódio do cour resolvido. Identidades ausentes ou ambíguas são puladas, sem adivinhar apenas pelo título.

Alterar o limiar com `.reload` vale para a próxima sessão; o item atual mantém o limiar original. Desativar o sync finaliza a sessão ativa uma vez. Para trocar de conta, pare o mpv-rpc, rode `npm start -- simkl-auth` novamente e reinicie.

### 5. Teste a configuração e resolva problemas

Experimente um filme, um episódio de série e um de anime. Pause acima de 80%, confira que continua parcial e depois pare para verificar a marcação de assistido no Simkl. Teste também parar abaixo de 80%.

| Sintoma | O que conferir |
| --- | --- |
| `SIMKL_CLIENT_ID not set` | Copie o Client ID para o `.env` da raiz e reinicie ou use `.reload` |
| `invalid_client` ou login falha imediatamente | Confira AUTH V2, o Client ID copiado e o tipo **TV, devices & command line** |
| A autorização expirou | Rode `npm start -- simkl-auth` outra vez e aprove o novo código antes de expirar |
| Falta de permissão de escrita / `403` | Autorize novamente com acesso de leitura e escrita |
| Sem identidade confiável | Confira o episódio extraído e os IDs dos metadados; para filmes/séries locais, confira a configuração do TMDb |
| Pausou em 90%, mas não marcou como assistido | É esperado: a conclusão aguarda parar, trocar o arquivo ou fechar a reprodução |
| Falha temporária da API / rate limit | Deixe o app aberto para a tentativa automática; evite reiniciá-lo repetidamente |

As chamadas reais de API ficam em `.anime_cache/api_log.txt`, mesmo com `DEBUG=false`. Tokens e códigos de autorização não são registrados.

Para simular eventos sem escrever na conta, defina `SYNC_DRY_RUN=true` e reinicie ou use `.reload`. Essa opção também afeta os outros syncs. Volte para `false` antes de testar a sincronização real.

A fila de tentativas fica na memória. O encerramento aguarda até oito segundos por envios pendentes; fechar sem rede ou forçar o fim do processo pode perder eventos não enviados. Não há reenvio persistente offline.
