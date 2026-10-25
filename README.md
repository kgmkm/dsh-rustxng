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
| `debug` | `false` | Log each provider decision. |

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
| Linux x64 (glibc / musl) | Verified on WSL2 Ubuntu 26.04: both release builds 12/12 in `scripts/verify-linux.sh`, plugin tests 15/15; standalone-server run is the final confirmation |
| macOS arm64 / x64 | Supported by design (release assets exist); verification pending |

See [docs/PLATFORMS.md](docs/PLATFORMS.md) for how each platform is expected to be
verified, binary placement, and the platform-specific notes (PATH, service managers, WSL,
musl).

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| `RustXNG is not answering at …` | Start the instance, or fix `baseUrl` in the card. `rustxng_status` shows the probe error. |
| `web_search` still fails with a DeepSeek 401 | The provider is not selected: check the card's first switch, or `web.searchProvider` on the official *Web search* page. |
| Card missing from Plugins | The plugin row is not active — check Plugin Manager, and that the DSH version matches `dsh.compatibility`. |
| `Wanted to register a provider but web is missing` | The profile has no `@deepseek-ai/dsh-web`; this plugin needs it for the replacement (the tools still work). |
| Results look thin | A few engines rate-limit per IP; `rustxng_status` / RustXNG's `/stats` show which are suspended. `!engine query` still works. |

## Development

```bash
node tests/smoke.mjs                               # offline units + live search if an instance answers
RUSTXNG_BASE_URL=http://127.0.0.1:8899 node tests/smoke.mjs
```

Layout:

```
index.js                 host plugin: Config, provider + tools wiring, selection hand-over
lib/rustxng-client.js    HTTP client: query building, payload normalisation, timeouts
lib/web-provider.js      the `rustxng` seam provider and the web.searchProvider hand-over
lib/tools.js             rustxng_search / rustxng_status
lib/client.js            settings card (Plugins → RustXNG)
scripts/install-binary.mjs  cross-platform release downloader with SHA-256 check
```

## License and attribution

MIT — see [LICENSE](LICENSE).

RustXNG itself is **AGPL-3.0-or-later** and is *not* bundled here: the plugin talks to a
separate process over HTTP, and `scripts/install-binary.mjs` downloads it from its own
release page. If you redistribute a modified RustXNG, AGPL §13 applies to that work, not to
this plugin.
