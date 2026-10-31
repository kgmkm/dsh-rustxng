/**
 * dsh-rustxng 窶・use a self-hosted RustXNG instance from DeepSeek Harness.
 *
 * Three contributions:
 *   1. a `rustxng` search provider on the web seam (`ctx.web.registerSearchProvider`),
 *      selectable through `web.searchProvider` 窶・i.e. a drop-in replacement for the
 *      built-in `web_search`;
 *   2. `rustxng_search` / `rustxng_status` tools for direct, engine-scoped queries;
 *   3. a settings card in the Plugins page (lib/client.js) that flips the two live
 *      switches and edits the base URL without restarting DSH.
 *
 * Nothing here patches DSH: the provider and the selection field are the documented
 * extension points, which is why the plugin survives Harness upgrades.
 *
 * RustXNG: https://github.com/sahenjp/RustXNG (AGPL-3.0-or-later). This plugin only
 * talks to a separately installed instance over HTTP; it does not embed RustXNG code.
 */
import { createRequire } from 'node:module';
import { realpathSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRustxngClient, readLive } from './lib/rustxng-client.js';
import { buildRustxngTools } from './lib/tools.js';
import { RUSTXNG_FETCH_PROVIDER_ID, createCharsetFetchProvider } from './lib/fetch-provider.js';
import { createProcessManager } from './lib/process-manager.js';
import {
  RUSTXNG_SEARCH_PROVIDER_ID,
  createRustxngSearchProvider,
  createSearchSelectionGuard,
} from './lib/web-provider.js';

/** Cordis plugin name (must match the row id in cordis.patch.yml). */
export const name = 'dsh-rustxng';

/**
 * Optional trace file for diagnosing the selection hand-over on a host whose settings
 * service is unavailable or shaped differently. Enabled with DSH_RUSTXNG_TRACE=<path>.
 */
async function debugTrace(stage, detail) {
  const target = process.env.DSH_RUSTXNG_TRACE;
  if (typeof target !== 'string' || target === '') return;
  try {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(target, `${new Date().toISOString()} ${stage} ${JSON.stringify(detail)}\n`, 'utf8');
  } catch {
    /* tracing must never break the plugin */
  }
}

/** The tool registry is required; `web` and `settings` are reached optionally. */
export const inject = ['tools'];

/**
 * Settings schema.
 *
 * `@deepseek-ai/schemastery` normally resolves because the package is installed inside the
 * profile, next to every other plugin. A checkout that the Plugin Manager *links* (instead of
 * copying) is resolved by Node to its real path, which usually lives outside the profile, so
 * the bare specifier can fail there. The fallback resolves the same module from the running
 * Harness installation, which is what a linked checkout needs.
 */
export const schemaStatus = { loaded: false, via: '(not attempted)', error: undefined };

/**
 * Bases to try when resolving a package the host provides.
 *
 * `process.argv[1]` is not enough on its own: a Linux npm-global install puts the launcher at
 * `<prefix>/bin/dsh`, a symlink into `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`,
 * so resolving from the symlink looks for `<prefix>/bin/node_modules` — which does not exist.
 * The real path of the entry point, and the plugin's own file, are tried as well.
 *
 * @param {string} [entry] Entry point to start from; defaults to `process.argv[1]`.
 * @returns {string[]} Distinct absolute paths, most specific first.
 */
export function hostResolutionBases(entry = process.argv[1]) {
  const bases = [];
  if (typeof entry === 'string' && entry !== '') {
    bases.push(entry);
    try {
      const real = realpathSync(entry);
      if (real !== entry) bases.push(real);
    } catch {
      /* an entry point that cannot be resolved simply contributes no base */
    }
  }
  try {
    bases.push(fileURLToPath(import.meta.url));
  } catch {
    /* not a file: module (a bundler) — skip this base */
  }
  return [...new Set(bases)];
}

/**
 * Import a host-provided package through the running Harness's own resolution.
 *
 * @param {string} specifier Bare specifier, e.g. `@deepseek-ai/schemastery`.
 * @returns {Promise<{module: object, resolved: string, base: string}>} The imported module.
 */
export async function importFromHost(specifier) {
  let lastError;
  for (const base of hostResolutionBases()) {
    try {
      const hostRequire = createRequire(pathToFileURL(base));
      const resolved = hostRequire.resolve(specifier);
      const module = await import(pathToFileURL(resolved).href);
      return { module, resolved, base };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`no resolution base for ${specifier}`);
}

/** Load the schema builder: profile-local first, then through the host installation. */
async function loadSchemaModule() {
  try {
    const module = await import('@deepseek-ai/schemastery');
    schemaStatus.loaded = true;
    schemaStatus.via = 'plugin-local';
    return module.default;
  } catch (error) {
    schemaStatus.error = String(error?.code ?? error?.message ?? error);
  }
  try {
    const { module, resolved } = await importFromHost('@deepseek-ai/schemastery');
    const candidate = module.default ?? module;
    schemaStatus.loaded = true;
    schemaStatus.via = `host (${resolved})`;
    schemaStatus.error = undefined;
    return candidate;
  } catch (error) {
    schemaStatus.error = `${schemaStatus.error ?? ''} / host fallback: ${String(error?.message ?? error)}`;
    return undefined;
  }
}

async function loadConfigSchema() {
  try {
    const z = await loadSchemaModule();
    if (z === undefined) return undefined;
    return z.object({
      /** Master switch. false unloads the tools and unregisters the provider. */
      enabled: z.boolean().default(true),
      /** Base URL of the RustXNG instance (volatile: editable from the settings card). */
      baseUrl: z
        .string()
        .default('http://127.0.0.1:8888')
        .volatile()
        .description('Address of your RustXNG instance, for example http://127.0.0.1:8888.'),
      /** Timeout for one search request (milliseconds). */
      timeoutMs: z.number().default(20000),
      /** Results returned to web_search by default (1-50). The caller's maxResults wins when smaller. */
      defaultLimit: z.number().default(12),
      /** Search language (`ja`, `en`, 窶ｦ). Empty leaves the instance default. */
      language: z.string().default(''),
      /** Time range filter: empty / day / week / month / year. */
      timeRange: z.string().default(''),
      /** Safe search: -1 leaves the instance default, 0 / 1 / 2 force a level. */
      safeSearch: z.number().default(-1),
      /** Category filters applied to every search (`general`, `it`, 窶ｦ). Empty = instance default. */
      categories: z.array(z.string()).default([]),
      /** Register the rustxng_search / rustxng_status tools for the agent. */
      exposeTools: z.boolean().default(true),
      /**
       * Replace the built-in `web_search` with RustXNG (default OFF).
       *
       * enabled    窶ｦ register a `rustxng` provider on ctx.web
       * autoSelect 窶ｦ also write web.searchProvider = 'rustxng' (the field the official
       *              "Web search" page writes)
       */
      webSearch: z.object({
        enabled: z
          .boolean()
          .default(false)
          .volatile()
          .description('Answer the built-in web_search from RustXNG instead of the DeepSeek search API.'),
        autoSelect: z
          .boolean()
          .default(true)
          .volatile()
          .description(
            'Point web.searchProvider at "rustxng" automatically. Turn this off to register the provider only ' +
              'and choose it yourself (web.searchProvider, or DSH_WEB_SEARCH_PROVIDER=rustxng).',
          ),
      }),
      /**
       * Replace the built-in `web_fetch` with a charset-aware fetcher (default OFF).
       *
       * The built-in provider reads `charset` from the HTTP header only; Japanese sites that
       * declare Shift_JIS in `<meta charset>` and send `text/html` without a parameter come
       * back as replacement characters. This provider resolves BOM → header → `<meta>` and
       * decodes with `TextDecoder`, exactly like a browser.
       */
      webFetch: z.object({
        enabled: z
          .boolean()
          .default(false)
          .volatile()
          .description('Answer web_fetch with a charset-aware fetcher (BOM → header → <meta charset>).'),
        autoSelect: z
          .boolean()
          .default(true)
          .volatile()
          .description(
            'Point web.fetchProvider at "rustxng-http" automatically. Turn this off to register the provider ' +
              'only and choose it yourself (web.fetchProvider, or DSH_WEB_FETCH_PROVIDER=rustxng-http).',
          ),
      }),
      /** Log each provider decision and request. */
      debug: z.boolean().default(false),
      /**
       * Start the RustXNG binary for the user (default OFF) and stop it again when it is idle.
       *
       * Ownership matters: only the process this plugin started is ever stopped, and the idle
       * timeout is what cleans up after a Harness that was killed without running its cleanup.
       * `idleMinutes: 0` keeps it running until the plugin unloads.
       */
      autoStart: z.object({
        enabled: z
          .boolean()
          .default(false)
          .volatile()
          .description('Start the RustXNG binary automatically when the instance does not answer.'),
        binaryPath: z
          .string()
          .default('')
          .description('Absolute path to the rustxng binary. Empty searches $DSH_HOME/bin, ~/.local/bin and PATH.'),
        idleMinutes: z
          .number()
          .default(60)
          .volatile()
          .description('Stop the started instance after this many minutes without a search (0 = never).'),
        download: z
          .boolean()
          .default(true)
          .description('Download a release binary into $DSH_HOME/bin when no binary is found.'),
        version: z
          .string()
          .default('')
          .description('Pin the download to one release (for example 0.20.1). Empty follows the latest release.'),
      }),
    });
  } catch {
    return undefined;
  }
}

/** Same resolution strategy for the tool builder (`@deepseek-ai/dsh-tools`). */
export const toolsStatus = { loaded: false, via: '(not attempted)', error: undefined };

async function loadToolsModule() {
  const override = process.env.DSH_RUSTXNG_TOOLS_MODULE;
  if (typeof override === 'string' && override !== '') {
    try {
      const specifier = override.startsWith('file:') ? override : pathToFileURL(override).href;
      const module = await import(specifier);
      toolsStatus.loaded = true;
      toolsStatus.via = `override (${specifier})`;
      return module.defineTool;
    } catch (error) {
      toolsStatus.error = `override: ${String(error?.message ?? error)}`;
      return undefined;
    }
  }
  try {
    const module = await import('@deepseek-ai/dsh-tools');
    toolsStatus.loaded = true;
    toolsStatus.via = 'plugin-local';
    return module.defineTool;
  } catch (error) {
    toolsStatus.error = String(error?.code ?? error?.message ?? error);
  }
  try {
    const { module, resolved } = await importFromHost('@deepseek-ai/dsh-tools');
    toolsStatus.loaded = true;
    toolsStatus.via = `host (${resolved})`;
    toolsStatus.error = undefined;
    return module.defineTool;
  } catch (error) {
    toolsStatus.error = `${toolsStatus.error ?? ''} / host fallback: ${String(error?.message ?? error)}`;
    return undefined;
  }
}

let cachedDefineTool;
/** Memoized `defineTool`, or `undefined` when this host has no tool registry package. */
async function loadDefineTool() {
  if (cachedDefineTool !== undefined) return cachedDefineTool;
  cachedDefineTool = await loadToolsModule();
  return cachedDefineTool;
}

export const Config = await loadConfigSchema();

/** How often the reachability probe runs while the replacement is enabled. */
const PROBE_INTERVAL_MS = 30000;

/** How often the idle watchdog checks the process this plugin started. */
const IDLE_CHECK_INTERVAL_MS = 30000;

export function apply(ctx, config) {
  const getConfig = () => {
    const value = typeof config?.get === 'function' ? config.get() : config;
    return value ?? {};
  };
  const log = (message) => {
    try {
      if (readLive(getConfig().debug, false) === true) ctx.logger?.debug?.(message);
    } catch {
      /* logging must never break a search */
    }
  };

  /**
   * Where the started instance writes its log. `$DSH_HOME/logs` keeps it next to the other
   * Harness logs, which also means it is easy to point a user at.
   */
  const stateDir = (() => {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh');
    const dir = join(home, 'logs');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* the spawner reports an unwritable path when it matters */
    }
    return dir;
  })();

  /** Health check used by the supervisor (deliberately independent of the search client). */
  const probeHealth = async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout?.(2500) });
      return response.ok;
    } catch {
      return false;
    }
  };

  const processManager = createProcessManager({ getConfig, log, probeHealth, stateDir });
  const client = createRustxngClient({ getConfig, log, onActivity: () => processManager.touch() });

  /** Where the started instance should listen, derived from `baseUrl`. */
  const startTarget = () => {
    const { baseUrl } = client.settings();
    try {
      const url = new URL(baseUrl);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      return { baseUrl, port, bindAddress: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname };
    } catch {
      return { baseUrl, port: 8888, bindAddress: '127.0.0.1' };
    }
  };

  /** Start the instance on demand (used by the provider before a search). */
  const ensureInstance = async () => {
    if (processManager.config().enabled !== true) return { started: false, reason: 'auto-start is off' };
    return processManager.ensureStarted(startTarget());
  };

  /** Live values of the volatile `webSearch` settings. */
  const webConfig = () => {
    const search = (getConfig() ?? {}).webSearch ?? {};
    return {
      enabled: readLive(search.enabled, false) === true,
      autoSelect: readLive(search.autoSelect, true) !== false,
    };
  };

  /**
   * The settings service, if this host has one.
   *
   * Non-strict `get` (second argument `false`) so an instance that exists but is not yet
   * marked active is still usable: the hand-over is a normal settings write, and refusing
   * it here would leave `web.searchProvider` untouched for ordering reasons the user
   * cannot see.
   */
  const getSettingsService = () => {
    if (typeof ctx.get !== 'function') return undefined;
    try {
      return ctx.get('settings', false) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const selection = createSearchSelectionGuard({ getSettings: getSettingsService, log });
  const fetchSelection = createSearchSelectionGuard({
    getSettings: getSettingsService,
    log,
    providerId: RUSTXNG_FETCH_PROVIDER_ID,
    field: 'fetchProvider',
  });

  /** Live values of the volatile `webFetch` settings. */
  const fetchConfig = () => {
    const fetchSettings = (getConfig() ?? {}).webFetch ?? {};
    return {
      enabled: readLive(fetchSettings.enabled, false) === true,
      autoSelect: readLive(fetchSettings.autoSelect, true) !== false,
    };
  };

  /**
   * A `web` selection field, as far as this host lets us see it.
   *
   * `known: false` means the host does not publish the row at all. DSH 0.2.0-rc.2 only lists
   * settings entries that declare a volatile field, and its `web` row (`searchProvider`,
   * `fetchProvider`) declares none — so the value is invisible there even though it is set.
   * Callers distinguish "not selected" (known, empty) from "cannot tell" (unknown).
   *
   * @param {'searchProvider'|'fetchProvider'} field Selection field to read.
   * @param {string} envName Environment variable the host honours for the same field.
   * @returns {{known: boolean, value?: string}} The current selection.
   */
  const readWebSelection = (field, envName) => {
    const settings = getSettingsService();
    if (settings === undefined || typeof settings.describe !== 'function') return { known: false };
    let rows;
    try {
      rows = settings.describe();
    } catch {
      return { known: false };
    }
    if (!Array.isArray(rows)) return { known: false };
    const row = rows.find((entry) => {
      const ns = entry?.ns;
      return typeof ns === 'string' && (ns === 'web' || ns.endsWith(':web') || ns.split(':').pop() === 'web');
    });
    if (row === undefined) {
      // The host hides the row; DSH itself still honours this environment variable for the
      // same setting, so respect an explicit choice instead of guessing.
      const env = process.env[envName];
      if (typeof env === 'string' && env.length > 0) return { known: true, value: env };
      return { known: false };
    }
    const value = row.value?.[field];
    return { known: true, value: typeof value === 'string' && value.length > 0 ? value : undefined };
  };

  /** Current `web.searchProvider`. */
  const selectionState = () => readWebSelection('searchProvider', 'DSH_WEB_SEARCH_PROVIDER');

  /** Current `web.fetchProvider`. */
  const fetchSelectionState = () => readWebSelection('fetchProvider', 'DSH_WEB_FETCH_PROVIDER');

  /**
   * Retry the `web.searchProvider` hand-over from a request context.
   *
   * The mount-time attempt is refused by the loader: `settings.update()` goes through
   * `runExclusive`, and `apply()` already runs inside that transaction, so the write is
   * rejected with "HMR transactions cannot be nested". `AsyncLocalStorage` keeps that flag for
   * every timer the plugin creates, which is why the delayed retries at mount time did not
   * help either. A search or a tool call, however, runs on the caller's context (the agent's
   * request), where the transaction is closed — so that is the first place the write works.
   *
   * @returns {Promise<void>} Resolves even when the attempt is skipped or refused.
   */
  let handOverApplied = false;
  let handOverAttempts = 0;
  const tryHandOver = async () => {
    if (handOverApplied === true) return;
    const settings = webConfig();
    if (settings.enabled !== true || settings.autoSelect !== true) return;
    const current = selectionState();
    if (current.known === true && current.value === RUSTXNG_SEARCH_PROVIDER_ID) {
      handOverApplied = true;
      return;
    }
    if (handOverAttempts >= 5) return;
    handOverAttempts += 1;
    const outcome = await selection.take().catch(() => undefined);
    if (outcome?.applied === true) {
      handOverApplied = true;
      log('[rustxng] selected the provider from the request context');
      return;
    }
    log(`[rustxng] the hand-over was refused again: ${outcome?.reason ?? 'unknown'}`);
  };

  let webFiber = null;
  let toolsFiber = null;
  let fetchFiber = null;
  let webState = 'disabled (default)';
  let fetchState = 'disabled (default)';
  let toolsState = 'not registered';
  let probeTimer = null;
  let idleTimer = null;

  /**
   * Register the provider on `ctx.web`.
   *
   * `web` is an optional dependency (a host without the web seam keeps the feature inert),
   * so it is awaited through a child fiber. The provider is unregistered by disposing that
   * fiber: `registerSearchProvider` scopes its effect to the calling fiber.
   */
  const installWebSearch = () => {
    if (webFiber !== null) return;
    if (typeof ctx.inject !== 'function') {
      webState = 'cannot register on this host (no ctx.inject)';
      return;
    }
    try {
      webFiber = ctx.inject(['web'], (inner) => {
        const provider = createRustxngSearchProvider({
          client,
          isEnabled: () => webConfig().enabled,
          getSelection: selectionState,
          ensureStarted: ensureInstance,
          canStart: () => processManager.config().enabled === true,
          handOver: tryHandOver,
          log: (message) => {
            try {
              inner.logger?.debug?.(message);
            } catch {
              /* noop */
            }
          },
        });
        inner.web.registerSearchProvider(provider);
        void debugTrace('register', { id: RUSTXNG_SEARCH_PROVIDER_ID, baseUrl: client.settings().baseUrl });
        inner.logger?.info?.(`[rustxng] registered the "${RUSTXNG_SEARCH_PROVIDER_ID}" web search provider`);
      });
    } catch (error) {
      webFiber = null;
      webState = `failed to register the provider: ${String(error)}`;
      ctx.logger?.warn?.(`[rustxng] failed to register the web search provider: ${String(error)}`);
    }
  };

  const uninstallWebSearch = () => {
    if (webFiber === null) return;
    const current = webFiber;
    webFiber = null;
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[rustxng] failed to unregister the web search provider: ${String(error)}`);
    });
  };

  /**
   * Register the charset-aware fetch provider on `ctx.web`.
   *
   * Registered while the plugin is active and gated by `available()`, for the same reason as
   * the search provider: hosts that update volatile config in place never re-mount the
   * plugin, so a registration-time decision would freeze the switch.
   */
  const installWebFetch = () => {
    if (fetchFiber !== null) return;
    if (typeof ctx.inject !== 'function') {
      fetchState = 'cannot register on this host (no ctx.inject)';
      return;
    }
    try {
      fetchFiber = ctx.inject(['web'], (inner) => {
        const provider = createCharsetFetchProvider({
          isEnabled: () => fetchConfig().enabled,
          getSelection: fetchSelectionState,
          log: (message) => {
            try {
              inner.logger?.debug?.(message);
            } catch {
              /* noop */
            }
          },
        });
        inner.web.registerFetchProvider(provider);
        void debugTrace('register-fetch', { id: RUSTXNG_FETCH_PROVIDER_ID });
        inner.logger?.info?.(`[rustxng] registered the "${RUSTXNG_FETCH_PROVIDER_ID}" web fetch provider`);
      });
    } catch (error) {
      fetchFiber = null;
      fetchState = `failed to register the fetch provider: ${String(error)}`;
      ctx.logger?.warn?.(`[rustxng] failed to register the web fetch provider: ${String(error)}`);
    }
  };

  const uninstallWebFetch = () => {
    if (fetchFiber === null) return;
    const current = fetchFiber;
    fetchFiber = null;
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[rustxng] failed to unregister the web fetch provider: ${String(error)}`);
    });
  };

  /** Keep the fetch provider registration and `web.fetchProvider` in line with the settings. */
  const syncWebFetch = () => {
    const settings = fetchConfig();
    installWebFetch();

    if (settings.enabled !== true) {
      afterLoad((retryNow) => {
        void fetchSelection
          .release()
          .then((outcome) => {
            if (outcome?.released === true) return;
            if (String(outcome?.reason ?? '').includes('HMR transactions cannot be nested')) retryNow();
          })
          .catch(() => {
            /* release() reports through its own outcome */
          });
      }, 0, 'fetch');
      fetchState = 'disabled (default)';
      return;
    }

    if (settings.autoSelect !== true) {
      fetchState = `enabled (registered as "${RUSTXNG_FETCH_PROVIDER_ID}"; autoSelect=false, so selecting it is up to you)`;
      return;
    }

    fetchState = `enabled (registered as "${RUSTXNG_FETCH_PROVIDER_ID}" and selected in web.fetchProvider)`;
    afterLoad((retryNow) => {
      void fetchSelection
        .take()
        .then((outcome) => {
          if (outcome?.applied === true) return;
          const reason = String(outcome?.reason ?? 'unknown reason');
          if (reason.includes('HMR transactions cannot be nested')) {
            retryNow();
            return;
          }
          fetchState = `enabled, but the selection was not written (${reason}).`;
          ctx.logger?.warn?.(`[rustxng] the fetch selection was not written: ${reason}`);
        })
        .catch((error) => {
          ctx.logger?.warn?.(`[rustxng] the fetch selection failed: ${String(error)}`);
        });
    }, 0, 'fetch');
  };

  /**
   * Bring the provider registration and the `web.searchProvider` hand-over in line with
   * the settings.
   *
   * Order matters: register before writing the selection, and clear the selection before
   * unregistering, so no search can observe a selection without a provider behind it.
   */
  /**
   * Run a settings write after the current load/HMR transaction finishes.
   *
   * `settings.update()` rewrites the profile patch, and the loader refuses that while a
   * transaction is open ("HMR transactions cannot be nested"). The first attempt therefore
   * runs in a macrotask, and a bounded retry covers the rest of the mount, which can hold
   * the transaction open for longer than one tick.
   */
  const afterLoad = (operation, attempt = 0, kind = 'search') => {
    const delays = [0, 2000, 8000];
    const retry = () => {
      if (attempt + 1 >= delays.length) {
        const advice =
          'this host refuses a plugin-initiated settings write ("HMR transactions cannot be nested"). Set ' +
          (kind === 'fetch' ? 'web.fetchProvider to "rustxng-http"' : 'web.searchProvider to "rustxng"') +
          ' once by hand — it is remembered and nothing else is needed.';
        if (kind === 'fetch') fetchState = `enabled (registered as "${RUSTXNG_FETCH_PROVIDER_ID}"), but ${advice}`;
        else webState = `enabled (registered as "${RUSTXNG_SEARCH_PROVIDER_ID}"), but ${advice}`;
        ctx.logger?.warn?.('[rustxng] the host refuses plugin-initiated settings writes; select the provider once by hand');
        return;
      }
      afterLoad(operation, attempt + 1, kind);
    };
    const timer = setTimeout(() => {
      try {
        operation(retry);
      } catch (error) {
        ctx.logger?.debug?.(`[rustxng] settings write attempt ${attempt + 1} threw: ${String(error)}`);
        retry();
      }
    }, delays[Math.min(attempt, delays.length - 1)]);
    timer.unref?.();
  };

  const syncWebSearch = () => {
    const search = webConfig();
    void debugTrace('sync', {
      search,
      hasSettings: getSettingsService() !== undefined,
      selection: selectionState(),
      describeCount: (() => {
        try {
          return getSettingsService()?.describe?.()?.length;
        } catch (error) {
          return `ERR ${String(error)}`;
        }
      })(),
    });

    // Register once and stay registered. `available()` is the only gate (enabled + selected +
    // reachable), so flipping the switch takes effect even on hosts that never emit
    // `loader/volatile-update` — DSH 0.2.0-rc.2 updates volatile config in place and keeps the
    // plugin mounted, so a registration-time decision would leave the toggle dead until restart.
    installWebSearch();

    if (search.enabled !== true) {
      // Also heals a value left behind by a previous session.
      afterLoad((retryNow) => {
        void selection
          .release()
          .then((outcome) => {
            if (outcome?.released === true) {
              ctx.logger?.info?.('[rustxng] gave the web search provider selection back');
              return;
            }
            if (String(outcome?.reason ?? '').includes('HMR transactions cannot be nested')) retryNow(outcome.reason);
          })
          .catch(() => {
            /* release() reports through its own outcome */
          });
      });
      webState = 'disabled (default)';
      return;
    }

    if (search.autoSelect !== true) {
      webState = `enabled (registered as "${RUSTXNG_SEARCH_PROVIDER_ID}"; autoSelect=false, so selecting it is up to you)`;
      return;
    }

    webState = `enabled (registered as "${RUSTXNG_SEARCH_PROVIDER_ID}" and selected in web.searchProvider)`;
    afterLoad((retryNow) => {
      void selection
        .take()
        .then((outcome) => {
          debugTrace('take', outcome);
          if (outcome?.applied === true) return;
          const reason = String(outcome?.reason ?? 'unknown reason');
          // The mount transaction was still open; try again on the next backoff step.
          if (reason.includes('HMR transactions cannot be nested')) {
            retryNow(reason);
            return;
          }
          webState = `enabled, but the selection was not written (${reason}). ` + `Set web.searchProvider to "${RUSTXNG_SEARCH_PROVIDER_ID}" yourself.`;
          ctx.logger?.warn?.(`[rustxng] the web search selection was not written: ${reason}`);
        })
        .catch((error) => {
          ctx.logger?.warn?.(`[rustxng] the web search selection failed: ${String(error)}`);
        });
    });
  };

  const installTools = () => {
    if (toolsFiber !== null) return;
    if (getConfig().exposeTools === false) {
      toolsState = 'disabled because the setting exposeTools=false';
      return;
    }
    // `@deepseek-ai/dsh-tools` is loaded lazily so the plugin (and its tests) can be
    // imported outside a Harness process — the web provider needs no host package.
    void loadDefineTool()
      .then((defineTool) => {
        if (defineTool === undefined) {
          toolsState = `unavailable (${toolsStatus.error ?? 'unknown'})`;
          return;
        }
        if (toolsFiber !== null) return;
        try {
          toolsFiber = ctx.plugin({
            name: 'dsh-rustxng:tools',
            apply(inner) {
              const tools = buildRustxngTools({
                defineTool,
                client,
                getConfig,
                ensureSelected: tryHandOver,
                ensureStarted: ensureInstance,
                statusLines: () => [
                  `Provider: ${webState}`,
                  `Fetch provider: ${fetchState}`,
                  (() => {
                    // Report the actual selection, not only what this session changed: an
                    // instance selected before start-up used to print "(none)" next to a
                    // "selected in web.searchProvider" line, which read like a contradiction.
                    const describe = (label, state, id) => {
                      if (state.known !== true) return `${label}: unknown (the host does not publish this row)`;
                      if (state.value === undefined) return `${label}: (not selected)`;
                      return `${label}: ${state.value}${state.value === id ? ' (this plugin)' : ''}`;
                    };
                    const taken = [selection.pending(), fetchSelection.pending()].filter(
                      (value) => typeof value === 'string' && value !== '',
                    );
                    return (
                      `Selection: ${describe('web.searchProvider', selectionState(), RUSTXNG_SEARCH_PROVIDER_ID)}, ` +
                      `${describe('web.fetchProvider', fetchSelectionState(), RUSTXNG_FETCH_PROVIDER_ID)}` +
                      (taken.length === 0 ? '' : ` — handed over this session: ${taken.join(', ')}`)
                    );
                  })(),
                  (() => {
                    const info = processManager.status();
                    const managed = info.managed ? `managed (pid ${info.pid})` : 'not managed by this plugin';
                    // Which file is running matters when several builds exist on the machine.
                    const binary = info.binary === undefined ? '' : ` [${basename(info.binary)}]`;
                    const idle = info.idleMs === undefined ? 'no activity yet' : `${Math.round(info.idleMs / 60000)} min idle`;
                    return (
                      `Auto-start: ${info.autoStart ? 'on' : 'off'} — ${managed}${binary}, ` +
                      `idle timeout ${info.idleMinutes === 0 ? 'off' : `${info.idleMinutes} min`} (${idle})` +
                      (info.lastError === undefined ? '' : `, last error: ${info.lastError}`)
                    );
                  })(),
                  `Tools: ${toolsState}`,
                  `Config schema: ${
                    schemaStatus.loaded
                      ? `loaded via ${schemaStatus.via}`
                      : `unavailable (${schemaStatus.error ?? 'unknown'})`
                  }`,
                  `Tools module: ${toolsStatus.loaded ? `loaded via ${toolsStatus.via}` : `unavailable (${toolsStatus.error})`}`,
                ],
              });
              for (const tool of tools) inner.tools.register(tool);
              toolsState = `registered ${tools.map((tool) => tool.name).join(', ')}`;
              inner.logger?.info?.(`[rustxng] ${toolsState}`);
            },
          });
        } catch (error) {
          toolsFiber = null;
          toolsState = `failed to register the tools: ${String(error)}`;
          ctx.logger?.warn?.(`[rustxng] failed to register the tools: ${String(error)}`);
        }
      })
      .catch((error) => {
        toolsFiber = null;
        toolsState = `failed to load the tools module: ${String(error)}`;
        ctx.logger?.warn?.(`[rustxng] failed to load the tools module: ${String(error)}`);
      });
  };

  const uninstallTools = () => {
    if (toolsFiber === null) return;
    const current = toolsFiber;
    toolsFiber = null;
    toolsState = 'unregistered';
    Promise.resolve(current.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[rustxng] failed to unregister the tools: ${String(error)}`);
    });
  };

  /** Keep `available()` honest without doing network I/O inside it. */
  const startProbeLoop = () => {
    if (probeTimer !== null) return;
    const tick = () => {
      if (webConfig().enabled !== true) return;
      void client.probe({ timeoutMs: 4000 }).then((outcome) => {
        if (outcome.ok !== true) log(`[rustxng] probe failed: ${outcome.error ?? 'unknown error'}`);
      });
    };
    tick();
    probeTimer = setInterval(tick, PROBE_INTERVAL_MS);
    probeTimer.unref?.();
  };

  const stopProbeLoop = () => {
    if (probeTimer === null) return;
    clearInterval(probeTimer);
    probeTimer = null;
  };

  /**
   * Stop the instance this plugin started once it has been idle for `autoStart.idleMinutes`.
   *
   * This is the only cleanup that survives a Harness killed without running its effects, which
   * is the whole point of the timeout. It never touches a process the plugin did not start.
   */
  const startIdleWatchdog = () => {
    if (idleTimer !== null) return;
    idleTimer = setInterval(() => {
      try {
        if (processManager.tick()) log('[rustxng] stopped the instance after the idle timeout');
      } catch (error) {
        ctx.logger?.warn?.(`[rustxng] idle watchdog failed: ${String(error)}`);
      }
    }, IDLE_CHECK_INTERVAL_MS);
    idleTimer.unref?.();
  };

  const stopIdleWatchdog = () => {
    if (idleTimer === null) return;
    clearInterval(idleTimer);
    idleTimer = null;
  };

  const sync = () => {
    if (getConfig().enabled === false) {
      uninstallTools();
      uninstallWebSearch();
      uninstallWebFetch();
      stopProbeLoop();
      webState = 'disabled (master switch enabled=false)';
      fetchState = 'disabled (master switch enabled=false)';
      return;
    }
    installTools();
    syncWebSearch();
    syncWebFetch();
    // The probe loop runs whenever the plugin is active and only reports while the feature is
    // on, so a host without `loader/volatile-update` still reflects reachability after a toggle.
    startProbeLoop();
    startIdleWatchdog();
    // Auto-start is deliberately lazy: it runs from the first search (see the provider's
    // ensureStarted), so mounting the plugin never downloads anything on its own.
  };

  /**
   * Live settings edits do not remount the plugin: the volatile fields are committed into
   * the running config and announced with this event, so re-running `sync()` applies the
   * change without a restart.
   */
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        sync();
      } catch (error) {
        ctx.logger?.warn?.(`[rustxng] failed to apply the new settings: ${String(error)}`);
      }
      // This event is emitted by whoever mutated the settings (the card, over the host's
      // request context), so the selection write is allowed here even though the mount-time
      // one is not.
      void tryHandOver();
    });
  }

  // Bundle order is not a contract: if the settings service shows up after this plugin,
  // redo the hand-over so a feature already enabled at start-up still gets its selection.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], () => {
        try {
          syncWebSearch();
          syncWebFetch();
        } catch (error) {
          ctx.logger?.warn?.(`[rustxng] failed to finish the web search hand-over: ${String(error)}`);
        }
      });
    } catch {
      /* optional dependency: without it the provider still registers, only selection is manual */
    }
  }

  sync();

  ctx.effect(() => () => {
    stopProbeLoop();
    stopIdleWatchdog();
    uninstallTools();
    uninstallWebSearch();
    uninstallWebFetch();
    // Graceful Harness shutdown: stop the instance we started. A killed Harness never runs
    // this, which is why `autoStart.idleMinutes` exists.
    processManager.stop('plugin unloaded');
    processManager.dispose();
  });
}

export { Config as config };
