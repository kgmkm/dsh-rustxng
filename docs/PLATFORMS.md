# Platform support

The plugin is plain ESM with no native dependencies and no install scripts, so the same code
runs on every OS DSH runs on. What differs per platform is **where the RustXNG binary comes
from** and how you keep it running.

Status legend: **verified** = exercised end to end on this project; **supported** = release
asset + code path exist, verification checklist below not yet executed.

| | Windows | macOS (arm64 / x64) | Linux (glibc / musl) |
| :--- | :--- | :--- | :--- |
| Release asset | `…-x86_64-pc-windows-msvc.exe` | `…-aarch64-apple-darwin`, `…-x86_64-apple-darwin` | `…-x86_64-unknown-linux-gnu`, `…-x86_64-unknown-linux-musl` |
| `scripts/install-binary.mjs` | verified | supported | verified (glibc + musl) |
| Plugin install (bundle patch) | verified | supported | verified (Ubuntu 26.04 server, WSL2) |
| Provider replacement (`web_search`) | verified | supported | verified (Ubuntu 26.04 server, DSH 0.2.0-rc.2) |
| Settings card | verified (registered & rendered in DSH 0.2.1-rc.2) | supported | verified (rendered on Ubuntu 26.04 server) |
| Tools (`rustxng_search` / `rustxng_status`) | verified | supported | verified |

### Linux verification run

Ubuntu 26.04.1 LTS, x86_64, glibc 2.43, Node 24.22.0, **DSH 0.2.0-rc.2** (npm global install),
RustXNG 0.4.0 running as a systemd user unit — reported from the server itself:

| | glibc build | musl build |
| :--- | :--- | :--- |
| version / startup / healthz | PASS | PASS |
| engines | 169 enabled / 169 | 169 enabled / 169 |
| metasearch | PASS (results + unresponsive list) | PASS |
| single engine | PASS | PASS |
| Japanese query round trip | PASS | PASS |
| rss / csv / html / stats | PASS | PASS |

The plugin was then installed from a linked checkout and answered `web_search` (the instance's
`/stats` counter advanced). Two defects surfaced only in that environment; both are fixed in
0.1.2:

- **Symlinked launcher.** A Linux npm-global install puts a symlink at `<prefix>/bin/dsh`, so
  resolving a host package from `process.argv[1]` looked in `<prefix>/bin/node_modules` and
  failed. `hostResolutionBases()` now tries the launcher, its real path, and the plugin's own
  file. Without it the schema is unreadable and **the settings card never appears**.
- **Live config values in the status report.** Once the schema loads, every field arrives as an
  object exposing `get()`; `lib/tools.js` compared those to primitives, so `rustxng_status`
  printed `Replace web_search: no (default)` while the replacement was actually running.

## Windows

- The release asset already ends in `.exe`; the fetcher saves it as `rustxng.exe` under
  `%DSH_HOME%\bin` (or `--dir`).
- Command-line windows that run `pwsh` may need `-ExecutionPolicy Bypass` for local scripts;
  this does not affect the plugin, which is JavaScript.
- The binary is unsigned. SmartScreen warns the first time you run it from Explorer; running
  it from a terminal or a service avoids the prompt.
- Verified environment: Windows 11 x64, Node 24, DSH 0.2.1-rc.2, RustXNG 0.4.0.

## macOS

- `install-binary.mjs` picks `aarch64-apple-darwin` on Apple Silicon and `x86_64-apple-darwin`
  on Intel.
- The downloaded binary is unsigned and unnotarized, so Gatekeeper quarantines it. Clear the
  attribute once:

  ```bash
  xattr -d com.apple.quarantine ~/.dsh/bin/rustxng
  chmod +x ~/.dsh/bin/rustxng
  ```

- **Verified 2026-10-29** on macOS 26.6.2 (Build 25G83) / Apple M1 Max, DSH 0.2.1-rc.3
  (Electron desktop app, profile `desktop`, Node v22.22.3), plugin 0.1.3 and RustXNG 0.4.1
  (`rustxng-v0.4.1-aarch64-apple-darwin`, SHA-256 verified):
  `rustxng_search` answered in ~3 s with 6-10 engines per query, including Japanese queries;
  the built-in `web_search` was unusable in that environment (HTTP 401 from the DeepSeek
  search API), so the replacement was the only working path.
  Two findings from that run, both addressed in 0.2.1:
  - Several engines (Google, Brave, DuckDuckGo, Dogpile, Baidu, …) were permanently
    `unresponsive` with Access denied / CAPTCHA / Parsing error from a residential line. That
    is the instance's egress IP, not the plugin; the remaining engines still produce results.
  - A fresh install failed with `ECONNREFUSED` until the binary was fetched and started by
    hand. `autoStart.enabled` now downloads a verified release into `$DSH_HOME/bin` and starts
    it, so the first run works without a terminal.
  - Not confirmed on macOS yet: the idle stop (the timer logic is platform independent and is
    covered by `tests/process.test.mjs` on Linux).

- To keep it running without a terminal, a LaunchAgent works well:

  ```xml
  <!-- ~/Library/LaunchAgents/dev.rustxng.plist -->
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.dsh/bin/rustxng</string>
    <string>--port</string><string>8888</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  ```

  then `launchctl load ~/Library/LaunchAgents/dev.rustxng.plist`.

## Linux

- glibc builds need glibc 2.34 or newer (Ubuntu 22.04+, Debian 12+, Fedora 35+).
  On Alpine, distroless, or an older glibc, use `--musl`:

  ```bash
  node scripts/install-binary.mjs --musl
  ```

- A systemd **user** unit keeps the instance alive:

  ```ini
  # ~/.config/systemd/user/rustxng.service
  [Service]
  ExecStart=%h/.dsh/bin/rustxng --port 8888
  Restart=on-failure
  [Install]
  WantedBy=default.target
  ```

  `systemctl --user enable --now rustxng`

- In WSL2 the instance listens on the WSL side. Either run DSH inside the same distro (so
  `127.0.0.1:8888` is directly reachable) or bind to `0.0.0.0` and use the host IP. Binding
  to loopback inside WSL and calling it from a Windows-side DSH does **not** work by default.
- Containers: `docker run --rm -p 8888:8888 rustxng` (the upstream repository ships a
  Dockerfile) and point `baseUrl` at the published port.

## DSH versions

Both supported releases mount the plugin and register its provider; the difference is only in
how the *selection* can be written.

| | DSH 0.2.0-rc.2 | DSH 0.2.1-rc.2 |
| :--- | :--- | :--- |
| Bundle mount + provider registration | verified (`registerSearchProvider` called, no errors) | verified (end-to-end, `web_search` answered by RustXNG) |
| Client half (settings card) served | verified (`dsh-rustxng/client.js` in the boot payload) | verified (slot occupant, card registered) |
| `web.searchProvider` readable via `settings.describe()` | **no** — 0.2.0-rc.2 lists only entries that declare a volatile field, and its `web` row declares none | yes |
| `loader/volatile-update` | not emitted | emitted |
| Selection, recommended way | profile patch (`- id: web` → `searchProvider: rustxng`) or `DSH_WEB_SEARCH_PROVIDER=rustxng` | the settings card, the official Web search page, or the profile patch |

Because 0.2.0-rc.2 updates volatile config in place without remounting the plugin, the plugin
computes availability per call (`enabled` + `selected` + `reachable`) instead of deciding at
registration time — so flipping the card's switch takes effect on both releases without a
restart. When the host hides the `web` row, the plugin honours `DSH_WEB_SEARCH_PROVIDER` if it
is set and otherwise serves, which is what makes the replacement work there at all.

## What "verification" means here

For a platform to move from *supported* to *verified*, run all of this on that OS:

1. `node scripts/install-binary.mjs --dir ./bin` → checksum verified, binary runs
   (`./bin/rustxng -v` prints `RustXNG 0.4.0`).
2. `bash scripts/verify-linux.sh --binary ./bin/rustxng --port 8888` → 12/12 checks pass
   (or start the instance yourself and pass `--skip-start`).
3. `node tests/smoke.mjs` and `node tests/apply.test.mjs` → all checks pass, including the
   live search blocks.
4. Install the plugin into a profile, open **Plugins → RustXNG**, switch the replacement on
   (or set `web.searchProvider: rustxng` in the profile patch).
5. Ask the agent to run `web_search` → results come from many engines; stop RustXNG and
   repeat → the error names `baseUrl` and how to start it.
6. `rustxng_status` reports version, engine count, and that the selection points at
   `rustxng`.

## Known platform-independent caveats

- **Rate limiting is per IP.** Some engines (Google, Brave, Wikipedia) answer 429 or deny
  access from datacenter or heavily shared addresses. RustXNG suspends those engines for a
  while and reports them in `unresponsive_engines`; the rest still answer.
- **`web_fetch` is untouched.** Only search goes through RustXNG.
- **The plugin never selects itself.** `available()` returns false unless `web.searchProvider`
  is `rustxng`, so an unselected install cannot make every search ambiguous — it simply
  stays out of the way.
- **Plugin-initiated settings writes are refused by the current loader** ("HMR transactions
  cannot be nested"). The card and the profile patch both work; an automatic selection at
  startup falls back with an explanatory message in `rustxng_status`.
