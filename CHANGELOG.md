# Changelog

This file is managed by semantic-release.

## [2.8.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.7.2...mpv-rpc-v2.8.0) (2026-11-09)

### Features

* **bridge:** show episode names in the auto-fetch queue ([6e97292](https://github.com/gabszap/mpv-rpc/commit/6e972923214350dde7648618ea4b064a34797ff5))
* **config:** add TMDB_API_KEY and TMDB_LANG ([9cc1262](https://github.com/gabszap/mpv-rpc/commit/9cc12628bd38abcada78b170c9effa38869634ea))
* **core:** add the media metadata resolver ([4426759](https://github.com/gabszap/mpv-rpc/commit/442675988674c729b31a57e81827c5db056a3a6a))
* **core:** add the metadata router ([776d694](https://github.com/gabszap/mpv-rpc/commit/776d694d17064ba2aea01ecac2f584b558007286))
* **discord:** show movies with poster, title and year ([0774d42](https://github.com/gabszap/mpv-rpc/commit/0774d42e6ff76255e7f0ba28ea1de2054f786e1b))
* **mpv:** route metadata between the anime and media pipelines ([bfc0274](https://github.com/gabszap/mpv-rpc/commit/bfc02748451d4fbc7b3dd5b618bcc1149d8759cb))
* **parser:** expose the release year ([bf70b16](https://github.com/gabszap/mpv-rpc/commit/bf70b1657a0665eee6b37f8075aea76536eec87a))
* **providers:** add the TMDb media provider ([bee9f44](https://github.com/gabszap/mpv-rpc/commit/bee9f44969c2b5c8c0a1e6126f814afec1261019))

### Bug Fixes

* **media:** keep anime on the anime pipeline and survive a TMDb outage ([41839f6](https://github.com/gabszap/mpv-rpc/commit/41839f6251b8e740fc1e9379e12d5ebe26f938a7))
* **metadata:** persist media cache and log TMDb requests ([88df1ae](https://github.com/gabszap/mpv-rpc/commit/88df1ae3488734c149a8bed7dbd3f290070223f6))
* **playback:** isolate bridge playlists and skip MAL for TMDb media ([b68ba8d](https://github.com/gabszap/mpv-rpc/commit/b68ba8d1204179db562e751b55df422edb344b24))
* **tmdb:** keep episode cache in memory and always log API calls ([2fa1e05](https://github.com/gabszap/mpv-rpc/commit/2fa1e05d9c84f966bf18dec9fcfa4a3dd6b22922))

## [2.7.2](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.7.1...mpv-rpc-v2.7.2) (2026-11-05)

### Bug Fixes

* **bridge:** stop aborting slow stream providers and fetch episodes in parallel ([96f17f8](https://github.com/gabszap/mpv-rpc/commit/96f17f844e371826477ba0997c7910bb703d68df))

## [2.7.1](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.7.0...mpv-rpc-v2.7.1) (2026-11-05)

### Bug Fixes

* **parser:** tighten the episode marker and the parser tests ([e6cc551](https://github.com/gabszap/mpv-rpc/commit/e6cc551d9c4d5d81164fa840dcf0e2301fbb78fd))

## [2.7.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.6.0...mpv-rpc-v2.7.0) (2026-11-05)

### Features

* **parser:** add PTT adapter ([4b4d1fe](https://github.com/gabszap/mpv-rpc/commit/4b4d1fe71ed5412cef0fe81aeb97c1e87a32c925))
* **parser:** use PTT before GuessIt ([8fa65f5](https://github.com/gabszap/mpv-rpc/commit/8fa65f522fea958d0615d9b98d7f54aefcb42a42))

### Bug Fixes

* **parser:** do not cache fallback results while PTT is unavailable ([82634ee](https://github.com/gabszap/mpv-rpc/commit/82634eee51602b2d9ed5b7b5b72e400b8de9c92b))

## [2.6.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.5.0...mpv-rpc-v2.6.0) (2026-11-04)

### Features

* add parse CLI diagnostic and SYNC_DRY_RUN mode ([0af0828](https://github.com/gabszap/mpv-rpc/commit/0af08286771f8af7222ca0b883b47cd9e0df7cbe))
* **bridge:** add config schema versioning and strict validation ([6e29bda](https://github.com/gabszap/mpv-rpc/commit/6e29bda33831b156b2528c205b94b03c53af5f71))
* **bridge:** map equivalent quality aliases for stream selection ([6185cf3](https://github.com/gabszap/mpv-rpc/commit/6185cf344c5631d14e153a70f2742836d1b14c9d))
* **bridge:** skip unreleased targets and optimize auto-fetch cooldowns ([69d4a36](https://github.com/gabszap/mpv-rpc/commit/69d4a36179bc363886e79c3087f7ebefa29219fe))
* **console:** anchor episode title overrides to parsed filename context ([d7fd5c5](https://github.com/gabszap/mpv-rpc/commit/d7fd5c583c8b6d1dcee0b421e442e8934128d29e))
* **core:** add .reload REPL command for live config changes ([8572133](https://github.com/gabszap/mpv-rpc/commit/8572133101289695a1d0cfecec17f3699259b5f2))
* **providers:** harden Jikan requests and improve season matching ([ac5b0ca](https://github.com/gabszap/mpv-rpc/commit/ac5b0caf636f1b5918973b23e31f02e50bb21b0d))
* **providers:** improve Jikan search scoring ([97b70a9](https://github.com/gabszap/mpv-rpc/commit/97b70a981de416be73a52e92c91c54cdf348f30c))
* **providers:** improve season validation and mapping for fallback searches ([d45fbd0](https://github.com/gabszap/mpv-rpc/commit/d45fbd07a078fed13e891101800e422a228d97b3))
* **stremio-sync:** align playback context matching using secure imdb identifiers ([e04e319](https://github.com/gabszap/mpv-rpc/commit/e04e31952ab0404f4f7c8da9ac11521c2becabc9))
* **tvdb:** add localized episode titles and season artwork ([eceb363](https://github.com/gabszap/mpv-rpc/commit/eceb363f4390d1a1b24f45ccc4241700b17895ee))

### Bug Fixes

* add icon mode enum and Discord URL filtering ([ef5243e](https://github.com/gabszap/mpv-rpc/commit/ef5243e817663940adfdcf4544502b7eccdaf290))
* **app:** clean up shutdown and dry-run logging ([7c3171b](https://github.com/gabszap/mpv-rpc/commit/7c3171b46fc5d016aeb0907625596206e688cd21))
* **auto-fetch:** preserve context across playlist handoff ([8f09538](https://github.com/gabszap/mpv-rpc/commit/8f09538d75d2f39ce4bd909929130038e3821f6c))
* **bridge:** make auto-fetch idempotent ([cd8deca](https://github.com/gabszap/mpv-rpc/commit/cd8decade59cf5c15efa7ffd3caaaff185fe787e))
* **bridge:** track the userscript build script ignored by .gitignore ([f3fdb2a](https://github.com/gabszap/mpv-rpc/commit/f3fdb2a8d54fcfcc3e634711baf137b2f5487673))
* **ci:** run semantic-release with the project config in release workflows ([5e0dd42](https://github.com/gabszap/mpv-rpc/commit/5e0dd42f5a5fed416c530efc3d4a56be8507408f))
* clean up Stremio and Trakt log messages ([b8ed0ec](https://github.com/gabszap/mpv-rpc/commit/b8ed0ecead6bc2ea9dee98a6a232e75b25058751))
* **core:** ignore years and conjunctions when matching titles ([7e33709](https://github.com/gabszap/mpv-rpc/commit/7e33709b377121b9ef44d0ea996e39b17b14f540))
* cover MAL dry-run and polish bridge settings ([5362745](https://github.com/gabszap/mpv-rpc/commit/5362745c1599a0dc1eb986b37e5bd9b2edc6ab2f))
* harden parser, bridge config, and dry-run sync ([0d8db52](https://github.com/gabszap/mpv-rpc/commit/0d8db5279af4ee07e77e55cd719956034c8c31f7))
* harden parser, bridge config, and dry-run sync ([475d7fc](https://github.com/gabszap/mpv-rpc/commit/475d7fc24e6ec2d2de4a977857fc219faca604ff))
* improve bridge icon modes and config sync ([84cb269](https://github.com/gabszap/mpv-rpc/commit/84cb2699faba9a76a074d6cb4dca93f0e4bf8c60))
* **jikan:** fall back to episode lists ([9b4a32d](https://github.com/gabszap/mpv-rpc/commit/9b4a32d3a12a9af4604bce0e3ceb549003191eea))
* **providers:** improve TVDB localized episode titles and fallback log ([d0a165a](https://github.com/gabszap/mpv-rpc/commit/d0a165a9aaa7e08245553d190ee91c49d9d9be5d))
* refine bridge controls and auto-fetch toggles ([4847084](https://github.com/gabszap/mpv-rpc/commit/4847084f5d86fb92e100657920fc2a86ac5380b6))
* **stremio:** harden playback context matching ([11c78ba](https://github.com/gabszap/mpv-rpc/commit/11c78ba9c588ae59fb7373fbfa4763fb49ad338c))
* **stremio:** sync watched state outside progress throttle ([fa01b5f](https://github.com/gabszap/mpv-rpc/commit/fa01b5fc6d7c66d68a4b6081bcdfae7e11d1d979))
* **sync:** accept secure bridge episode context ([991dec3](https://github.com/gabszap/mpv-rpc/commit/991dec3bb0e676ccda3c2277e6490833495524f1))
* **sync:** resolve canonical episode identity ([b2283d1](https://github.com/gabszap/mpv-rpc/commit/b2283d10e55fa25a952ec3912f833841760b7b35))
* **trakt:** fix syntax error in stopCurrentScrobbleOnce ([9bb3f3b](https://github.com/gabszap/mpv-rpc/commit/9bb3f3b4528869e41e01c6460f2e25d96e8fe625))
* **trakt:** map canonical anime episodes safely ([2652228](https://github.com/gabszap/mpv-rpc/commit/2652228dd30a4e7b3da1a711a123cae5b0f5ef8e))
* **trakt:** map canonical anime episodes via tvdb ([580f5e0](https://github.com/gabszap/mpv-rpc/commit/580f5e01d44c4fea8e4ee622aa1cd97dcc765326))
* **trakt:** write diagnostics to api log ([9af1326](https://github.com/gabszap/mpv-rpc/commit/9af13267750b85700304c954da7844807212d9a9))

### Performance Improvements

* **tooling:** optimize start:all script execution to bypass npm spawn overhead ([474e4e9](https://github.com/gabszap/mpv-rpc/commit/474e4e93a6e11c4ac511916080228d99caba96f5))

## [2.5.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.4.0...mpv-rpc-v2.5.0) (2026-11-04)

### Features

* **auto-fetch:** validate Stremio config matches current anime ([40ec132](https://github.com/gabszap/mpv-rpc/commit/40ec1321511d3a6dcc49d35864bb326df8359ac2))
* **stremio-sync:** add Continue Watching sync with Stremio API ([2d1804a](https://github.com/gabszap/mpv-rpc/commit/2d1804a23b582c05eb5bcfd31964152a4e3752a7))
* **stremio-sync:** add watched bitset marking with Cinemeta video IDs ([28c140d](https://github.com/gabszap/mpv-rpc/commit/28c140d5de21128c8ea172ea1fe554e8c7ae238a))

### Bug Fixes

* add auto-fetch deduplication and unify config defaults ([a2affbd](https://github.com/gabszap/mpv-rpc/commit/a2affbdb25d37a0d381a25d5f2a0720b29a30c7c))
* harden parser fallbacks and trakt absolute mapping ([5d7c470](https://github.com/gabszap/mpv-rpc/commit/5d7c4709fca8af436a64a3df0af6f102025b4947))

## [2.4.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.3.0...mpv-rpc-v2.4.0) (2026-11-04)

### Features

* **trakt:** add Trakt.tv scrobble integration with OAuth2 device auth ([1573394](https://github.com/gabszap/mpv-rpc/commit/157339486dcb284d118b08e2d974a4b9d18b4657))

### Bug Fixes

* **trakt:** guard filename-change stop with 1% progress minimum ([7fe0931](https://github.com/gabszap/mpv-rpc/commit/7fe09314effd505d86a9d64687dd6b35235d6eb6))
* **trakt:** improve resilience and edge case handling ([6218067](https://github.com/gabszap/mpv-rpc/commit/62180674fd5a160cf3a2f67d584505e1128e959f))
* **trakt:** improve scrobble reliability and API logging ([bb242f7](https://github.com/gabszap/mpv-rpc/commit/bb242f7ec5e9542d2d9f340271c9eb3b3790dfbf))
* **trakt:** threshold-first scrobble logic + debug API logging ([b88b28e](https://github.com/gabszap/mpv-rpc/commit/b88b28e4fc97f752de6ba5725701e232a82cbfe3))

## [2.3.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.2.0...mpv-rpc-v2.3.0) (2026-11-04)

### Features

* **auto-fetch:** add auto-detection and fetching of next episodes ([34b76ed](https://github.com/gabszap/mpv-rpc/commit/34b76edeed06a7775130b056b5bf38a7c18f0a4d))

## [2.2.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.1.1...mpv-rpc-v2.2.0) (2026-04-28)

### Features

* **anime:** add sequel-aware episode overflow resolution ([c467753](https://github.com/gabszap/mpv-rpc/commit/c4677538157716f38f994c4d579b6922fb00af67))
* **jikan:** use synonym titles as 2FA for season validation ([0d3330e](https://github.com/gabszap/mpv-rpc/commit/0d3330eca71edef39f6c98d07043b780eaedb0e7))

### Bug Fixes

* **anime:** search with season number before traversing sequel chain ([9c17ba8](https://github.com/gabszap/mpv-rpc/commit/9c17ba81b22e7c6bac319cefa25fe59674e1a42a))
* **jikan:** remove part/cour patterns from season extraction ([adb17aa](https://github.com/gabszap/mpv-rpc/commit/adb17aa770c3a1f77b16154965672c2e2e6da4d9))
* **kitsu:** map episodeCount to total_episodes for overflow support ([3f0c1aa](https://github.com/gabszap/mpv-rpc/commit/3f0c1aa0215e4aebb6213e2b560da9414cf0e88e))
* **parser:** deduplicate torrent_name extraction log and improve cache key ([ebe969b](https://github.com/gabszap/mpv-rpc/commit/ebe969b2c8d00ca11177be7a5afba901f172ead3))
* **parser:** extract torrent_name from URL query parameters ([cf0aef9](https://github.com/gabszap/mpv-rpc/commit/cf0aef9257e6fc739ce0c808d1af4ee94bef406a))
* **release:** force LF line endings for changelogs via .gitattributes [skip ci] ([6b15fb1](https://github.com/gabszap/mpv-rpc/commit/6b15fb1d5b462df5de13a8a5b9f5dc7419296464))

## [2.1.1](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.1.0...mpv-rpc-v2.1.1) (2026-04-25)

### Bug Fixes

* **ci:** serialize root and bridge releases with concurrency group ([b497151](https://github.com/gabszap/mpv-rpc/commit/b4971511afed62c9ae2436986e93cba1329cafc7))

## [2.1.0](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.0.2...mpv-rpc-v2.1.0) (2026-04-25)

### Features

* **bridge-userscript:** implement stacked toast notifications ([e3c1e91](https://github.com/gabszap/mpv-rpc/commit/e3c1e91c807d396f8611c59005cf46bb3e7bd99a))

### Bug Fixes

* **scripts:** route stdin to RPC REPL in concurrent start:all ([0d2e238](https://github.com/gabszap/mpv-rpc/commit/0d2e238a422e8e295fd45492d1ee179a332697e3))

## [2.0.2](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.0.1...mpv-rpc-v2.0.2) (2026-04-19)

### Bug Fixes

* **release:** normalize root changelog header and dedupe 2.0.1 notes ([8338cb9](https://github.com/gabszap/mpv-rpc/commit/8338cb9a42af6c0c3ca5201225a06f0d4acc5b2b))

## [2.0.1](https://github.com/gabszap/mpv-rpc/compare/mpv-rpc-v2.0.0...mpv-rpc-v2.0.1) (2026-04-19)

### Bug Fixes

* **deps:** update discord-api-types to latest working version ([bb71aaa](https://github.com/gabszap/mpv-rpc/commit/bb71aaa696f9cfe3a04aec2e6b92ff54e6eb0d81))
* **release:** narrow bridge workflow triggers to bridge scope ([dfdc6e3](https://github.com/gabszap/mpv-rpc/commit/dfdc6e324ae783b7695b8fe06d77ee917e8070a8))
* **release:** revert mistaken root 1.0.0 release and fetch full tag history ([48b4b2c](https://github.com/gabszap/mpv-rpc/commit/48b4b2cc0fe1134ec6ae7263bf2c5366c38b88c7))
* **release:** run root workflow for shared path-scoping plugin updates ([c4803bf](https://github.com/gabszap/mpv-rpc/commit/c4803bf1b37d4b57960cc1ba3c94a1da2fd3b778))
* **release:** sync bridge userscript [@version](https://github.com/version) with bridge package ([b0fe483](https://github.com/gabszap/mpv-rpc/commit/b0fe483abd72400cff214c10cd42355bab352c06))

## 2.0.0 - 2026-04-16

### Breaking/major highlights
- MAL sync runtime flow was reworked to diagnostic-first outcomes (`updated`, `already_synced`, `skipped`, `failed`) and the legacy bridge retry path was removed.
- Metadata resolution now uses stricter ordered/deduped fallback behavior with stronger provider diagnostics, affecting how fallback selection is evaluated.

### Features
- Hardened metadata provider fallback resolution with improved cross-provider episode lookup context.
- Standardized provider error detail formatting and expanded resilience diagnostics.
- Improved TVDB episode resolution using official/default order preference with bounded pagination.
- Migrated environment loading to `dotenv` as the official runtime loader while preserving fallback behavior.

### Fixes
- Improved parser episode-marker recovery beyond strict `SxxExx` patterns.
- Refined filename/media-title target selection to avoid parse loops and recover ambiguous hyphenated episode numbers.
- Improved GuessIt split-title reconciliation for arc/subtitle naming edge cases.

### Docs
- Rewrote the bilingual Stremio bridge guide with mirrored EN/PT structure, clearer architecture/setup, troubleshooting, and FAQ.
- Updated configuration/runtime docs in `AGENTS.md`, `README.md`, and `README_PT.md` to reflect dotenv-based loading.

### Migration note (dotenv)
- `.env` loading now uses `dotenv` as the official parser/loader. Existing `.env` files remain compatible, and partial/missing `.env` fallback behavior is preserved.
