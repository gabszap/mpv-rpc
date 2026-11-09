# Simkl sync

Simkl sync supports anime, TV series and movies independently of MAL, Trakt and Stremio sync.
It is disabled by default.

## Setup

1. Register an **OAuth V2 public application** through the [Simkl authentication documentation](https://api.simkl.org/authentication). Use a client suitable for the Device authorization flow; no client secret is distributed by mpv-rpc.
2. Set these values in `.env`:

   ```dotenv
   SIMKL_SYNC=true
   SIMKL_CLIENT_ID=your_oauth_v2_client_id
   SIMKL_SYNC_THRESHOLD=80
   ```

3. Build and authorize:

   ```bash
   npm run build
   npm start -- simkl-auth
   ```

4. Open the printed verification link, enter the displayed code if requested, and allow `media:read media:write`. Restart mpv-rpc after authorization.

The CLI respects the polling interval and device-code expiration. An old OAuth V1 client ID does not work with this flow. Tokens are stored in the git-ignored `.config/.simkl_tokens.json` and refreshed automatically. Never share this file.

## When playback is saved

| Playback event | Simkl action |
| --- | --- |
| Start or resume | Start watching |
| Pause | Save partial progress |
| Continue playing, including crossing 80% | No additional API call |
| Stop, switch files, close MPV or exit mpv-rpc | Save the last observed progress |

Only the final stop at or above `SIMKL_SYNC_THRESHOLD` marks the item watched. The threshold is an integer from 50 to 100, defaults to 80 and stays fixed for the current item. Pausing at 90% does not mark it watched; stopping afterward does. Seeking backward uses the final observed position, not the highest percentage reached. A significant settled seek can update the active watching position without completing it.

Movies and series use verified IMDb/TMDb/TVDB IDs. Anime uses native MAL/AniList/Kitsu IDs and the resolved cour's episode number when available; western IDs retain their original season and episode coordinates. Missing or ambiguous identity is skipped with a console diagnostic. TMDb metadata needs `TMDB_API_KEY` for local movie/series files without another trusted identity.

## Diagnostics and failures

- API calls are recorded in `.anime_cache/api_log.txt`, even with `DEBUG=false`; credentials and authorization codes are excluded.
- `SYNC_DRY_RUN=true` logs simulated events without authenticating or writing to Simkl. Returning to normal mode starts a real session from the current observation.
- `.reload` applies Simkl configuration changes; disabling sync finalizes the active session once. Changing accounts requires authorization again. Pending events remain bound to their original login.
- Rate limits and temporary failures use bounded retries in a background queue, leaving the main playback loop responsive.
- A revoked login or missing write permission requires `npm start -- simkl-auth` again.
- Shutdown waits at most eight seconds for pending writes. The queue is in memory: offline shutdown or a forced process kill can lose pending events. There is no durable offline replay in this version.

## Manual verification

Try one movie, one series episode and one anime episode. Confirm that start appears in Simkl, pausing above 80% remains partial, and stopping above 80% marks watched. Also stop below 80% and seek backward before stopping to verify partial progress. Automated tests mock HTTP; they do not use your account.
