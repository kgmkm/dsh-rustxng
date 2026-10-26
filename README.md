# dsh-rustxng

Use a self-hosted [RustXNG](https://github.com/sahenjp/RustXNG) instance from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — and answer the
built-in **`web_search`** with it.

RustXNG is a SearXNG-compatible metasearch engine written in Rust: one query fans out to
about 170 search engines, deduplicates the results and returns them without ads or
tracking. This plugin connects DSH to a RustXNG you run yourself (Windows, macOS or Linux)
and adds:

| Contribution | What it gives you |
| :--- | :--- |
| **Search provider** | A `rustxng` provider on the web seam. Point `web.searchProvider` at it and the built-in `web_search` is answered by your instance — no DeepSeek search API key involved. |
| **Settings card** | A card in **Plugins** with two live switches and the instance URL. No restart, no hand-edited YAML. |
| **Tools** | `rustxng_search` (engine, category, language and time-range scoped) and `rustxng_status` (reachability, version, engine count, provider state). |
| **Fetch provider** (optional) | A charset-aware `web_fetch`: resolves BOM → HTTP header → `<meta charset>` before decoding, so Shift_JIS pages that declare their encoding only in `<meta>` stop coming back as `�`. Does not use RustXNG. |
| **Binary fetcher** | `node scripts/install-binary.mjs` downloads and verifies the right release binary for your OS and CPU. |

Nothing in DSH is patched: the plugin uses the documented `ctx.web.registerSearchProvider()`
API and the ordinary `web.searchProvider` settings field, so it survives Harness upgrades.

---

## Requirements

- DeepSeek Harness `>= 0.2.0-rc.2 < 0.3.0` (host `tools`, `web` and `settings` services).
  Verified on **0.2.0-rc.2** and **0.2.1-rc.2**; see [docs/PLATFORMS.md](docs/PLATFORMS.md#dsh-versions).
- Node.js 20+ (the plugin uses the global `fetch`)
- A running RustXNG instance — see below

## 1. Get RustXNG

**Easiest:** let the plugin fetch a release binary.

```bash
node scripts/install-binary.mjs          # into $DSH_HOME/bin (or ~/.dsh/bin)
node scripts/install-binary.mjs --dir ./bin --musl   # Linux without glibc
```

The script picks the asset for your platform, verifies the published SHA-256, and prints
the start command.

**Or** download it yourself from the
[releases page](https://github.com/sahenjp/RustXNG/releases/latest):

| Platform | Asset |
| :--- | :--- |
| Windows x64 | `rustxng-v<ver>-x86_64-pc-windows-msvc.exe` |
| macOS arm64 | `rustxng-v<ver>-aarch64-apple-darwin` |
| macOS x64 | `rustxng-v<ver>-x86_64-apple-darwin` |
| Linux x64 (glibc) | `rustxng-v<ver>-x86_64-unknown-linux-gnu` |
| Linux x64 (musl) | `rustxng-v<ver>-x86_64-unknown-linux-musl` |

Start it:

```bash
rustxng --port 8888                       # listens on 127.0.0.1:8888 by default
curl 'http://127.0.0.1:8888/healthz'      # → OK
```

RustXNG serves its own search UI at <http://127.0.0.1:8888/>; this plugin does not replace
that page, it just consumes the same JSON API.

## 2. Install the plugin

```bash
# registry install (recommended)
dsh plugin --profile web add dsh-rustxng

# or from a checkout of this repository
git clone https://github.com/<owner>/dsh-rustxng.git
# then: Plugin Manager → install bundle → the checkout directory
```

Installing from a checkout **links** the directory, so Node resolves the plugin's real path
(`.../dsh-rustxng`). The plugin copes with that: if `@deepseek-ai/schemastery` is not
resolvable from there, it loads the schema builder through the running Harness's own entry
point instead of silently dropping the schema.

## 3. Turn it on

Open **Plugins → RustXNG** and switch on *Use RustXNG for web_search*. Or set it in your
profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: dsh-rustxng
  config:
    baseUrl: http://127.0.0.1:8888
    webSearch:
      enabled: true
      autoSelect: true
```

From then on `web_search` is answered by RustXNG. The `enabled` and `autoSelect` switches
and the instance URL are *volatile*: the settings card changes them live, and turning the
feature off hands `web.searchProvider` back to whatever it was before.

## Configuration

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `enabled` | `true` | Master switch; `false` unloads the tools and unregisters the provider. |
| `baseUrl` | `http://127.0.0.1:8888` | Where RustXNG listens. Volatile (editable in the card). |
| `timeoutMs` | `20000` | Timeout for one search. |
| `defaultLimit` | `12` | Sources handed to `web_search` (1–50). |
| `language` | `''` | Search language (`ja`, `en`, …); empty = instance default. |
| `timeRange` | `''` | `day` / `week` / `month` / `year`; empty = no filter. |
| `safeSearch` | `-1` | `-1` = instance default, else `0` / `1` / `2`. |
| `categories` | `[]` | Category filters applied to every search (`general`, `it`, …). |
| `exposeTools` | `true` | Register `rustxng_search` / `rustxng_status`. |
| `webSearch.enabled` | `false` | Replace the built-in `web_search`. Volatile. |
| `webSearch.autoSelect` | `true` | Write `web.searchProvider = 'rustxng'` for you. Volatile. |
| `webFetch.enabled` | `false` | Replace `web_fetch` with the charset-aware fetcher. Volatile. |
| `webFetch.autoSelect` | `true` | Write `web.fetchProvider = 'rustxng-http'` for you. Volatile. |
| `debug` | `false` | Log each provider decision. |

## Optional: charset-aware fetch

The built-in HTTP fetcher reads `charset` from the `Content-Type` header only. Many Japanese
sites (JRA, municipal sites, older corporate sites) send `text/html` with the encoding
declared *only* in `<meta charset="Shift_JIS">`, so the page arrives as replacement
characters. Turning on `webFetch.enabled` registers a small provider that resolves
**BOM → HTTP header → `<meta>`** and decodes with `TextDecoder` (Node ships the legacy
encodings), with a size cap and the same html/text classification.

```yaml
- id: dsh-rustxng
  config:
    webFetch:
      enabled: true
      autoSelect: true
- id: web
  config:
    searchProvider: rustxng
    fetchProvider: rustxng-http   # replaces the whole row, so list both fields
```

It does not touch RustXNG: it is plain HTTP plus decoding. Leave it off if you prefer the
built-in fetcher.

## Tools

```jsonc
// rustxng_search
{ "query": "rust async runtime", "limit": 8, "engine": "arxiv", "time_range": "year" }
{ "query": "東京 天気", "category": "news", "language": "ja" }
```

`rustxng_status` reports whether the instance answers, its version, how many engines are
enabled, whether the provider is registered, and whether `web.searchProvider` points at it —
run it first when a search fails.

## Platform support

| Platform | Status |
| :--- | :--- |
| Windows 10/11 x64 | Verified: release binary + this plugin (search, provider replacement, settings card) on DSH 0.2.1-rc.2 |
| Linux x64 (glibc / musl) | Verified on a standalone Ubuntu 26.04 server (DSH 0.2.0-rc.2: replacement + card) and on WSL2 (both release builds 12/12) |
| macOS arm64 / x64 | Supported by design (release assets exist); verification pending |

See [docs/PLATFORMS.md](docs/PLATFORMS.md) for how each platform is expected to be
verified, binary placement, and the platform-specific notes (PATH, service managers, WSL,
musl).

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| `RustXNG is not answering at …` | Start the instance, or fix `baseUrl` in the card. `rustxng_status` shows the probe error. |
| `web_search` still fails with a DeepSeek 401 | The provider is not selected: check the card's first switch, or `web.searchProvider` on the official *Web search* page. On DSH 0.2.0-rc.2 that field is not writable from a plugin — set it in the profile patch (see above) or with `DSH_WEB_SEARCH_PROVIDER=rustxng`. |
| Card missing from Plugins | The plugin row is not active — check Plugin Manager, and that the DSH version matches `dsh.compatibility`. On a linked checkout the schema comes through the Harness installation: `rustxng_status` prints `Config schema: loaded via …` or the resolution error. 0.1.2 resolves symlinked launchers such as `<prefix>/bin/dsh`. |
| `rustxng_status` says `Replace web_search: no (default)` although it is on | Fixed in 0.1.2 (live config values were compared as primitives). |
| `Wanted to register a provider but web is missing` | The profile has no `@deepseek-ai/dsh-web`; this plugin needs it for the replacement (the tools still work). |
| Results look thin | A few engines rate-limit per IP; `rustxng_status` / RustXNG's `/stats` show which are suspended. `!engine query` still works. |
| A Japanese page comes back as `����` / `�N` | The site declares its encoding only in `<meta>`. Turn on `webFetch.enabled` (see [Optional: charset-aware fetch](#optional-charset-aware-fetch)), or read it with `curl … \| iconv -f SHIFT_JIS -t UTF-8`. |

## Development

```bash
node tests/smoke.mjs            # payload normalisation + platform mapping (+ live search if an instance answers)
node tests/apply.test.mjs       # host half against a stub instance: provider gate, selection, tools, live values
node tests/resolve.test.mjs     # host-package resolution through a symlinked launcher (Linux npm-global layout)
```

`apply.test.mjs` and `resolve.test.mjs` need no running instance and no network.

Layout:

```
index.js                 host plugin: Config, provider + tools wiring, selection hand-over,
                         symlink-aware host-package resolution
lib/rustxng-client.js    HTTP client: query building, payload normalisation, timeouts
lib/web-provider.js      the `rustxng` seam provider and the web.searchProvider hand-over
lib/fetch-provider.js    optional charset-aware fetch provider (BOM → header → <meta>)
lib/tools.js             rustxng_search / rustxng_status
lib/client.js            settings card (Plugins → RustXNG)
scripts/install-binary.mjs  cross-platform release downloader with SHA-256 check
scripts/verify-linux.sh     12-item instance verification for POSIX hosts
```

## License and attribution

MIT — see [LICENSE](LICENSE).

RustXNG itself is **AGPL-3.0-or-later** and is *not* bundled here: the plugin talks to a
separate process over HTTP, and `scripts/install-binary.mjs` downloads it from its own
release page. If you redistribute a modified RustXNG, AGPL §13 applies to that work, not to
this plugin.
