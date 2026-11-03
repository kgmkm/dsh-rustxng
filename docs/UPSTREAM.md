# Following upstream RustXNG

This plugin wraps [`sahenjp/RustXNG`](https://github.com/sahenjp/RustXNG) and has to keep
working as that project moves. This page is the policy, so the next update is a decision
already made rather than a judgement call.

## What we actually depend on

Only the SearXNG-compatible surface:

| Surface | Used for |
| :--- | :--- |
| `GET /healthz` | the reachability probe and the start-up wait loop |
| `GET /search?q=…&format=json` | `results[].url/title/content`, `unresponsive_engines`, `number_of_results` |
| `GET /config` | the enabled/configured engine counts printed by `rustxng_status` |
| `--bind`, `--port`, `RUSTXNG_IDLE_TIMEOUT` | starting and stopping the instance |

Nothing else. We do not enumerate engines, read `settings.toml`, or check a version number,
which is what keeps upstream engine changes from reaching this code.

## Rules

1. **Follow release tags, not `main`.** The `[Unreleased]` section of the upstream changelog
   is read to know what is coming; code is written against tags only.
2. **Never gate on a version.** Any build that answers the four surfaces above works. There is
   no "requires RustXNG ≥ x.y" check anywhere, and adding one would be a regression.
3. **`PINNED_VERSION` means "last verified", not "required".** It is the fallback when the
   GitHub API cannot be reached, so it must be a binary that this plugin has been run against.
4. **Two verification tiers.**
   - *Contract smoke* — after every upstream tag, about five minutes: start the release binary,
     check `/healthz`, one `/search?format=json` (keys present, `sources` non-empty),
     `/config` (`engines[]` with `enabled`), and that `--bind/--port` are still accepted.
   - *Full matrix* — only when a contract breaks or before a minor release of this plugin:
     Windows, Linux and macOS, using the reports that come back through the shared folder.
5. **Five upstream changes trigger the smoke:** default port, the `format=json` shape, the
   `/config` shape, engine defaults, and a `settings.toml` migration requirement.
6. **Upstream-derived values live in one place.** A port or an engine count belongs in a
   constant with a comment naming the upstream release that changed it, never inline in a
   message or a document.
7. **Our releases are patches.** An upstream release does not bump this plugin; only a change
   in our own behaviour or docs does.

## Compatibility log

| Upstream | Change | Effect here | Action |
| :--- | :--- | :--- | :--- |
| v0.26.0 (2026-11-01) | Docker image, README restructure | none | none |
| v0.27.0 / v0.27.1 (2026-11-03) | Default HTTP port **8888 → 29483** | managed starts already pass `--port`; a hand-started instance was the case that drifts | 0.5.3 sets `SEARXNG_PORT` alongside `--port`; measured OK on 0.27.1 (see [PLATFORMS.md](PLATFORMS.md#upstream-0271-contract-smoke-2026-11-03-windows-x64)) |
| v0.27.0 / v0.27.1 | **Google engines, Google front ends, YouTube, Google translate, Material Icons, autocomplete and related bangs removed** (169 → 160 engines) | no engine enumeration, so no code impact; a legacy `settings.toml` entry only logs `WARN … skipped engine=google … unknown engine type` and the instance still starts | 0.5.4 documents the warning in the README and corrects the engine counts; nothing to fix in code |
| v0.27.0 | Yahoo! JAPAN and Mojeek HTML adapters disabled by default | Japanese result mix changes | recorded in the platform notes |
| v0.27.0 | Linux ARM64 release binary | `resolveTarget()` still maps only x64 and Apple arm64 | evaluate if anyone asks for ARM64 Linux |
| v0.27.0 | `--check-update` / `--update`, CA bundle support | none (we never invoke them) | none |
| 2026-11-03 (field finding) | `api.github.com` answered **HTTP 403** (unauthenticated rate limit) on the test machine, so the download fell through to `PINNED_VERSION` and installed a 2025-era binary | the plugin silently installed a much older instance | 0.5.4 resolves the tag through the `/releases/latest` redirect as well, which carries no API quota, and moves the pin to v0.27.1 |

## Pending work

- **0.5.3 (done):** duplicate the port as `SEARXNG_PORT`; this page.
- **0.5.4 (done):** engine counts corrected to the measured 160; the legacy-engine warning and the
  29483 default documented in the README; `PINNED_VERSION` moved to 0.27.1; the redirect fallback
  added after the API refused the lookup on a rate-limited IP.
- **Open:** decide whether Linux ARM64 belongs in `resolveTarget()`. Upstream publishes the asset;
  this plugin has no report from an ARM64 Linux machine, so the mapping stays out until one
  arrives rather than shipping an untested path.

## Running the contract smoke by hand

```bash
node scripts/contract-smoke.mjs                    # download the latest release, then check it
node scripts/contract-smoke.mjs --binary ./rustxng --port 29511
```

The script starts the instance through this plugin's own supervisor, so the managed start path
(`--bind`/`--port` plus `SEARXNG_PORT`) is covered, and it stops the child before exiting. It
exits non-zero on any failed check, which makes it usable as a release gate.

The same checks as bare commands, when you want to watch the instance yourself:

```bash
"/path/to/rustxng" --bind 127.0.0.1 --port 29483 &
curl -fsS 'http://127.0.0.1:29483/healthz'
curl -fsS 'http://127.0.0.1:29483/search?q=rust&format=json' | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const b=JSON.parse(s);
    if(!Array.isArray(b.results)||b.results.length===0) throw new Error("no results");
    if(typeof b.results[0].url!=="string") throw new Error("no url");
    console.log("search ok:",b.results.length,"rows");
  });'
curl -fsS 'http://127.0.0.1:29483/config' | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const b=JSON.parse(s);
    if(!Array.isArray(b.engines)) throw new Error("no engines[]");
    console.log("config ok:",b.engines.length,"engines");
  });'
```

Then point the plugin at that instance (`baseUrl: http://127.0.0.1:29483`) and run
`node tests/smoke.mjs` with `RUSTXNG_BASE_URL` set, which adds the live search check to the
offline ones.
