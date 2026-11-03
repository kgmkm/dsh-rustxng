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
| unreleased | Default HTTP port **8888 → 29483** | managed starts already pass `--port`; a hand-started instance is the case that drifts | 0.5.3 sets `SEARXNG_PORT` alongside `--port`, so old and new builds agree with `baseUrl` |
| unreleased | **Google engines, Google front ends, YouTube, Google translate, Material Icons, autocomplete and related bangs removed** | no engine enumeration, so no code impact; an old `settings.toml` that lists those engines has to be edited by its owner | start-failure hint (planned, see below) |
| unreleased | Yahoo! JAPAN and Mojeek HTML adapters disabled by default | Japanese result mix changes | recorded in [PLATFORMS.md](PLATFORMS.md) notes |
| unreleased | Linux ARM64 release binary | `resolveTarget()` only maps x64 and Apple arm64 | evaluate if anyone asks for ARM64 Linux |
| unreleased | `--check-update` / `--update`, CA bundle support | none (we never invoke them) | none |

The "unreleased" rows are in upstream `main` as of 2026-11-03. Installing `latest` still brings
v0.26.0, which keeps the old defaults.

## Pending work

- **0.5.3 (done):** duplicate the port as `SEARXNG_PORT`; this page.
- **After the release that carries the removals:** replace the "about 170 engines" wording with
  a range and make `rustxng_status` the source of truth, and add a start-failure hint telling
  the reader to delete removed Google entries from `settings.toml`.
- **Same release:** bump `PINNED_VERSION` to the first tag verified with the new defaults
  (v0.4.1 today; its assets still exist, but it is old enough that the fallback should move).

## Running the contract smoke by hand

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
