/**
 * HTTP client for a RustXNG instance.
 *
 * RustXNG (https://github.com/sahenjp/RustXNG) is a SearXNG-compatible metasearch
 * engine written in Rust. It answers the same `/search` API that SearXNG does, so
 * this module only has to build the query, normalize the payload onto the shape the
 * Harness web seam understands, and turn transport failures into actionable text.
 *
 * No dependency beyond the global `fetch` (Node >= 20 / Electron).
 */

/** Failure classes the web seam's consumers already route on. */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR';
export const WEB_ABORTED = 'WEB_ABORTED';

/**
 * Provider failure carrying a machine-routable `code`.
 *
 * `@deepseek-ai/dsh-web` exports its own `WebError`, but a third-party plugin resolves
 * bare specifiers through the host's importer; duplicating the four-line shape keeps
 * this plugin loadable when that package is not on the resolution path (consumers
 * route on `error.code`, not on the constructor).
 */
export class RustxngError extends Error {
  /**
   * @param {string} message Human- and model-readable failure description.
   * @param {string} [code] Stable failure class (`WEB_PROVIDER_ERROR` / `WEB_ABORTED`).
   * @param {{cause?: unknown}} [options] Standard `Error` options.
   */
  constructor(message, code = WEB_PROVIDER_ERROR, options) {
    super(message, options);
    this.name = 'RustxngError';
    this.code = code;
  }
}

/**
 * Read a config value that may be a live (volatile) reference.
 *
 * A schemastery field declared `.volatile()` reaches the plugin as `{ get() }` instead
 * of a plain value, because the host updates it in place without remounting the plugin.
 *
 * @param {unknown} value Plain value or volatile reference.
 * @param {unknown} fallback Used when the value is `undefined` / the reference is empty.
 * @returns {unknown} The current value.
 */
export function readLive(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get();
    return current === undefined ? fallback : current;
  }
  return value === undefined ? fallback : value;
}

/** Trim a trailing slash so `${base}/search` never becomes `//search`. */
function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/** Collapse an unknown thrown value into a one-line message. */
function messageOf(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

/** Parse a date-ish string into ISO-8601, or `undefined` when it does not parse. */
function toIsoDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined;
}

/** First non-empty string of a record. */
function pickString(record, keys) {
  if (record === null || typeof record !== 'object') return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/**
 * Combine the caller's signal with a timeout.
 *
 * @param {AbortSignal|undefined} signal Caller cancellation.
 * @param {number} ms Timeout in milliseconds; `<= 0` disables it.
 * @returns {{signal: AbortSignal|undefined, cancel: () => void, timedOut: () => boolean}}
 */
function withTimeout(signal, ms) {
  if (!(ms > 0)) return { signal, cancel: () => {}, timedOut: () => false };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`request timed out after ${ms} ms`));
  }, ms);
  // The timer is always cleared in `cancel()`, so it never outlives the request.
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    },
    timedOut: () => timedOut,
  };
}

/**
 * Normalize RustXNG's `/search?format=json` payload onto the seam vocabulary.
 *
 * @param {unknown} payload Parsed JSON body.
 * @returns {{sources: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, content?: string, meta: object}}
 */
export function normalizeSearchPayload(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {};
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const sources = [];
  const seen = new Set();

  for (const record of rawResults) {
    const url = pickString(record, ['url', 'link']);
    if (url === undefined || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const source = { url };
    const title = pickString(record, ['title', 'name']);
    if (title !== undefined) source.title = title;
    const snippet = pickString(record, ['content', 'snippet', 'description']);
    if (snippet !== undefined) source.snippet = snippet;
    const published = toIsoDate(record?.publishedDate ?? record?.published_at);
    if (published !== undefined) source.publishedAt = published;
    sources.push(source);
  }

  // `answers` / `infoboxes` are RustXNG's (SearXNG's) immediate answers; surface them as
  // the seam's optional `content` so the model can use them without opening a source.
  const answerLines = [];
  for (const answer of Array.isArray(body.answers) ? body.answers : []) {
    const text = pickString(answer, ['answer', 'content', 'text']);
    if (text !== undefined) answerLines.push(text);
  }
  for (const box of Array.isArray(body.infoboxes) ? body.infoboxes : []) {
    const text = pickString(box, ['content', 'infobox']);
    if (text !== undefined && !answerLines.includes(text)) answerLines.push(text);
  }

  const engines = new Set();
  for (const record of rawResults) {
    if (typeof record?.engine === 'string') engines.add(record.engine);
    if (Array.isArray(record?.engines)) for (const name of record.engines) engines.add(String(name));
  }

  const meta = {
    query: typeof body.query === 'string' ? body.query : undefined,
    results: rawResults.length,
    engines: [...engines].sort(),
    unresponsiveEngines: Array.isArray(body.unresponsive_engines)
      ? body.unresponsive_engines.map((entry) => (Array.isArray(entry) ? entry.join(': ') : String(entry)))
      : [],
    suggestions: Array.isArray(body.suggestions) ? body.suggestions.slice(0, 8) : [],
    corrections: Array.isArray(body.corrections) ? body.corrections.slice(0, 8) : [],
  };

  const normalized = { sources, meta };
  if (answerLines.length > 0) normalized.content = answerLines.join('\n');
  return normalized;
}

/**
 * Create the client used by both the search provider and the tools.
 *
 * @param {object} options
 * @param {() => object} options.getConfig Live plugin config.
 * @param {(message: string) => void} [options.log] Debug sink.
 * @returns {object} Client with `search`, `probe`, `state` and the resolved settings.
 */
export function createRustxngClient({ getConfig, log } = {}) {
  const configOf = () => (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};

  /** Last known reachability, refreshed by `probe()` and by every search. */
  const state = { reachable: undefined, version: undefined, checkedAt: undefined, error: undefined };

  const settings = () => {
    const cfg = configOf();
    return {
      baseUrl: normalizeBaseUrl(readLive(cfg.baseUrl, 'http://127.0.0.1:8888')),
      timeoutMs: Number(readLive(cfg.timeoutMs, 20000)) || 20000,
      defaultLimit: Math.max(1, Math.min(50, Number(readLive(cfg.defaultLimit, 12)) || 12)),
      language: String(readLive(cfg.language, '') ?? '').trim(),
      timeRange: String(readLive(cfg.timeRange, '') ?? '').trim(),
      safeSearch: Number(readLive(cfg.safeSearch, -1)),
      categories: Array.isArray(readLive(cfg.categories, [])) ? readLive(cfg.categories, []) : [],
    };
  };

  /** Actionable hint shared by every transport failure. */
  const unreachableHint = (baseUrl) =>
    `RustXNG is not answering at ${baseUrl}.\n` +
    'Start it (for example `rustxng --port 8888`), or point the dsh-rustxng setting `baseUrl` at the ' +
    'instance you run. `npx dsh-rustxng-fetch` downloads a release binary for Windows, macOS and Linux; ' +
    'see the plugin README.';

  /**
   * Probe `/healthz` and remember the outcome.
   *
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<{ok: boolean, baseUrl: string, version?: string, error?: string}>}
   */
  async function probe(options = {}) {
    const { baseUrl, timeoutMs } = settings();
    if (baseUrl === '') {
      state.reachable = false;
      state.error = 'baseUrl is empty';
      return { ok: false, baseUrl, error: state.error };
    }
    const budget = Math.min(options.timeoutMs ?? 5000, timeoutMs);
    const guard = withTimeout(options.signal, budget);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: guard.signal, headers: { accept: 'text/plain' } });
      const text = (await response.text()).trim();
      const ok = response.ok && /^ok/i.test(text);
      state.reachable = ok;
      state.checkedAt = Date.now();
      state.error = ok ? undefined : `HTTP ${response.status}: ${text.slice(0, 120)}`;
      if (ok) state.version = await readVersion(baseUrl, guard.signal);
      return { ok, baseUrl, version: state.version, error: state.error };
    } catch (error) {
      const message = guard.timedOut() ? `no answer within ${budget} ms` : messageOf(error);
      state.reachable = false;
      state.checkedAt = Date.now();
      state.error = message;
      return { ok: false, baseUrl, error: message };
    } finally {
      guard.cancel();
    }
  }

  /** Read the instance version from `/config` (best effort; never throws). */
  async function readVersion(baseUrl, signal) {
    try {
      const response = await fetch(`${baseUrl}/config`, { signal });
      if (!response.ok) return undefined;
      const body = await response.json();
      return typeof body?.version === 'string' ? body.version : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Run one metasearch.
   *
   * @param {object} request
   * @param {string} request.query Search terms.
   * @param {number} [request.limit] Maximum sources to return.
   * @param {string} [request.engine] Engine shortcut (`wikipedia`) or a comma-separated list.
   * @param {string[]} [request.categories] Category filters (`general`, `it`, `news`, …).
   * @param {string} [request.language] Language code for the search.
   * @param {string} [request.timeRange] `day` / `week` / `month` / `year`.
   * @param {number} [request.safeSearch] `0` / `1` / `2`; `-1` leaves the server default.
   * @param {AbortSignal} [signal] Caller cancellation.
   * @returns {Promise<{sources: Array<object>, content?: string, meta: object, elapsedMs: number, url: string}>}
   */
  async function search(request, signal) {
    const cfg = settings();
    const query = String(request?.query ?? '').trim();
    if (query === '') {
      throw new RustxngError('dsh-rustxng was asked to search without a query.', WEB_PROVIDER_ERROR);
    }
    if (signal?.aborted === true) {
      throw new RustxngError('RustXNG search was canceled', WEB_ABORTED, { cause: signal.reason });
    }
    if (cfg.baseUrl === '') {
      throw new RustxngError(
        'dsh-rustxng has no `baseUrl`. Set it to the address of your RustXNG instance (for example ' +
          'http://127.0.0.1:8888) in the DSH plugin settings.',
        WEB_PROVIDER_ERROR,
      );
    }

    const params = new URLSearchParams({ q: query, format: 'json' });
    const language = request?.language ?? cfg.language;
    if (typeof language === 'string' && language !== '') params.set('language', language);
    const timeRange = request?.timeRange ?? cfg.timeRange;
    if (typeof timeRange === 'string' && timeRange !== '') params.set('time_range', timeRange);
    const categories = Array.isArray(request?.categories) && request.categories.length > 0 ? request.categories : cfg.categories;
    if (categories.length > 0) params.set('categories', categories.join(','));
    const safeSearch = Number.isFinite(request?.safeSearch) ? Number(request.safeSearch) : cfg.safeSearch;
    if (Number.isFinite(safeSearch) && safeSearch >= 0) params.set('safesearch', String(safeSearch));
    if (typeof request?.pageno === 'number' && request.pageno > 1) params.set('pageno', String(request.pageno));

    // `!shortcut query` is RustXNG's (SearXNG's) documented single-engine syntax.
    const engine = typeof request?.engine === 'string' ? request.engine.trim().replace(/^!+/, '') : '';
    const effectiveQuery = engine === '' ? query : `!${engine} ${query}`;
    if (engine !== '') params.set('q', effectiveQuery);

    const url = `${cfg.baseUrl}/search?${params.toString()}`;
    const started = Date.now();
    const guard = withTimeout(signal, cfg.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        signal: guard.signal,
        headers: { accept: 'application/json', 'user-agent': 'dsh-rustxng' },
      });
    } catch (error) {
      const timedOut = guard.timedOut();
      const aborted = signal?.aborted === true;
      state.reachable = false;
      state.checkedAt = Date.now();
      state.error = timedOut ? `no answer within ${cfg.timeoutMs} ms` : messageOf(error);
      throw new RustxngError(
        aborted
          ? 'RustXNG search was canceled'
          : timedOut
            ? `RustXNG did not answer within ${cfg.timeoutMs} ms (${cfg.baseUrl}).`
            : `RustXNG could not be reached: ${messageOf(error)}\n\n${unreachableHint(cfg.baseUrl)}`,
        aborted ? WEB_ABORTED : WEB_PROVIDER_ERROR,
        { cause: error },
      );
    } finally {
      guard.cancel();
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new RustxngError(
        `RustXNG answered HTTP ${response.status} for ${JSON.stringify(effectiveQuery)}: ${body.slice(0, 300)}`,
        WEB_PROVIDER_ERROR,
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new RustxngError(`RustXNG returned a body that is not JSON: ${messageOf(error)}`, WEB_PROVIDER_ERROR, {
        cause: error,
      });
    }

    const normalized = normalizeSearchPayload(payload);
    const limit = Math.max(1, Math.min(50, Number(request?.limit ?? cfg.defaultLimit) || cfg.defaultLimit));
    const sources = normalized.sources.slice(0, limit);
    const truncated = normalized.sources.length > sources.length;

    state.reachable = true;
    state.checkedAt = Date.now();
    state.error = undefined;

    const elapsedMs = Date.now() - started;
    log?.(
      `[rustxng] ${sources.length}/${normalized.sources.length} sources, ` +
        `${normalized.meta.engines.length} engines, ${elapsedMs} ms`,
    );

    const result = {
      sources,
      meta: { ...normalized.meta, truncated, elapsedMs, engine: engine === '' ? undefined : engine, url },
      elapsedMs,
      url,
    };
    if (normalized.content !== undefined) result.content = normalized.content;
    return result;
  }

  return { search, probe, state, settings };
}
