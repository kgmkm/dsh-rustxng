# Platform support

The plugin is plain ESM with no native dependencies and no install scripts, so the same code
runs on every OS DSH runs on. What differs per platform is **where the RustXNG binary comes
from** and how you keep it running.

Status legend: **verified** = exercised end to end on this project; **supported** = release
asset + code path exist, verification checklist below not yet executed.

| | Windows | macOS (arm64 / x64) | Linux (glibc / musl) |
| :--- | :--- | :--- | :--- |
| Release asset | `…-x86_64-pc-windows-msvc.exe` | `…-aarch64-apple-darwin`, `…-x86_64-apple-darwin` | `…-x86_64-unknown-linux-gnu`, `…-x86_64-unknown-linux-musl` |
| `scripts/install-binary.mjs` | verified | supported | supported |
| Plugin install (bundle patch) | verified | supported | supported |
| Provider replacement (`web_search`) | verified | supported | supported |
| Settings card | verified (registered & rendered in DSH 0.2.1-rc.2) | supported | supported |
| Tools (`rustxng_search` / `rustxng_status`) | verified | supported | supported |

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

## What "verification" means here

For a platform to move from *supported* to *verified*, run all of this on that OS:

1. `node scripts/install-binary.mjs --dir ./bin` → checksum verified, binary runs
   (`./bin/rustxng -v` prints `RustXNG 0.4.0`).
2. Start it: `./bin/rustxng --port 8888`; `curl http://127.0.0.1:8888/healthz` → `OK`.
3. `node tests/smoke.mjs` → all checks pass, including the live search block.
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
