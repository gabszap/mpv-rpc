# MyAnimeList (MAL) Sync Setup

[English](#english) | [Português](#português)

---

## English

This feature allows you to automatically sync your anime watch progress to your MyAnimeList profile.

### Prerequisites

1.  **MAL API Client ID**: 
    - Go to [MyAnimeList API Settings](https://myanimelist.net/apiconfig).
    - Create a new ID.
    - Set the **App Redirect URL** to: `http://localhost:8888/callback`.
2.  **App Type**: Select "other".

> You can refer to this configuration: https://files.catbox.moe/82cseo.png

### Configuration

Edit your `.env` file with the following settings:

```env
MAL_SYNC=true
MAL_CLIENT_ID=your_client_id_here
MAL_SYNC_THRESHOLD=90
```

- `MAL_SYNC`: Set to `true` to enable the feature.
- `MAL_CLIENT_ID`: The Client ID you generated on MAL.
- `MAL_SYNC_THRESHOLD`: Percentage of the episode (0-100) that must be watched to trigger the sync (default is 90).

### Authentication

After configuring the `.env` file, you need to authorize the application:

1.  Run the following command in your terminal:
    ```bash
    npm start -- mal-auth
    ```
    *(If using development mode: `npm run dev -- mal-auth`)*
2.  A browser window will open. Log in to MAL and click "Allow".
3.  Once you see "Authorization Successful", you can close the browser and start the RPC normally.

---

## Português

Esta funcionalidade permite sincronizar automaticamente o seu progresso de episódios assistidos com o seu perfil no MyAnimeList.

### Pré-requisitos

1.  **MAL API Client ID**: 
    - Vá para as [Configurações de API do MyAnimeList](https://myanimelist.net/apiconfig).
    - Crie um novo ID.
    - Defina o **App Redirect URL** como: `http://localhost:8888/callback`.
2.  **App Type**: Selecione "other".

> Você pode referenciar esta configuração: https://files.catbox.moe/82cseo.png

### Configuração

Edite o seu arquivo `.env` com as seguintes definições:

```env
MAL_SYNC=true
MAL_CLIENT_ID=seu_client_id_aqui
MAL_SYNC_THRESHOLD=90
```

- `MAL_SYNC`: Defina como `true` para ativar a funcionalidade.
- `MAL_CLIENT_ID`: O Client ID que você gerou no MAL.
- `MAL_SYNC_THRESHOLD`: Porcentagem do episódio (0-100) que deve ser assistida para disparar a sincronização (padrão é 90).

### Autenticação

Após configurar o arquivo `.env`, você precisa autorizar a aplicação:

1.  Execute o seguinte comando no terminal:
    ```bash
    npm start -- mal-auth
    ```
    *(Se estiver em modo de desenvolvimento: `npm run dev -- mal-auth`)*
2.  Uma janela do navegador será aberta. Faça login no MAL e clique em "Allow" (Permitir).
3.  Quando aparecer "Authorization Successful", você pode fechar o navegador e iniciar o RPC normalmente.
