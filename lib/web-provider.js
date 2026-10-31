/**
 * The `rustxng` search provider for the Harness web seam (`ctx.web`), and the
 * selection hand-over that turns it into a drop-in replacement for the built-in
 * `web_search`.
 *
 * Why a seam provider instead of a proxy or a patched tool:
 *   - `ctx.web.registerSearchProvider()` is the documented plugin API of
 *     `@deepseek-ai/dsh-web`; the built-in DeepSeek backends register the same way,
 *     so nothing in DSH is patched.
 *   - Which provider wins is `web.searchProvider`, an ordinary volatile settings
 *     field that the official "Web search" page writes too.
 *
 * Default OFF: while `webSearch.enabled` is false nothing is registered and no
 * setting is touched.
 */
import { WEB_ABORTED, WEB_PROVIDER_ERROR, RustxngError } from './rustxng-client.js';

/** Stable provider id registered in the search registry (and written to `web.searchProvider`). */
export const RUSTXNG_SEARCH_PROVIDER_ID = 'rustxng';

/** Settings namespace that owns the provider selection (`@deepseek-ai/dsh-web` is mounted as `web`). */
export const WEB_SETTINGS_NS = 'web';

/**
 * Create the `rustxng` search provider.
 *
 * `available()` is a local check only (the seam forbids network calls there) and it is
 * deliberately conservative: the provider only offers itself while `web.searchProvider`
 * actually names it. That keeps the plugin additive — a registered-but-unselected provider
 * would otherwise make the seam report every search as ambiguous.
 *
 * @param {object} options
 * @param {() => boolean} options.isEnabled Whether the replacement is switched on.
 * @param {() => (string|undefined)} [options.getSelection] Current `web.searchProvider`.
 * @param {object} options.client Client from `lib/rustxng-client.js`.
 * @param {(message: string) => void} [options.log] Debug sink.
 * @returns {{id: string, available: () => boolean, search: (request: object, signal?: AbortSignal) => Promise<object>}}
 */
export function createRustxngSearchProvider({ isEnabled, getSelection, client, log, ensureStarted, canStart, handOver } = {}) {
  /** How long a failed probe stays authoritative for `available()`. */
  const FAILURE_TTL_MS = 15000;

  return {
    id: RUSTXNG_SEARCH_PROVIDER_ID,

    available() {
      try {
        if (isEnabled() !== true) return false;
        const { baseUrl } = client.settings();
        if (typeof baseUrl !== 'string' || baseUrl.length === 0) return false;
        // Selected by the user (card, official Web search page, profile patch, or
        // DSH_WEB_SEARCH_PROVIDER)? `known: false` means the host hides the row (DSH
        // 0.2.0-rc.2 publishes only settings entries with a volatile field), in which case a
        // configured selection is unreadable and refusing to serve would silently disable the
        // replacement — so an unreadable selection is treated as "serve".
        if (typeof getSelection === 'function') {
          const state = getSelection() ?? { known: false };
          if (state.known === true && state.value !== RUSTXNG_SEARCH_PROVIDER_ID) return false;
        }
        const { reachable, checkedAt } = client.state;
        if (reachable === false && typeof checkedAt === 'number' && Date.now() - checkedAt < FAILURE_TTL_MS) {
          // A supervisable instance is down: still offer the capability, because `search()`
          // starts it on demand. Otherwise the seam would hide the provider exactly when the
          // idle timer had just stopped the process.
          return typeof canStart === 'function' && canStart() === true;
        }
        return true;
      } catch {
        return false;
      }
    },

    async search(request, signal) {
      if (signal?.aborted === true) {
        throw new RustxngError('RustXNG search was canceled', WEB_ABORTED, { cause: signal.reason });
      }
      if (typeof handOver === 'function') {
        // A real search runs on the caller's context, not inside the loader's mount
        // transaction, so this is the first place a settings write is even allowed.
        await handOver().catch(() => {});
      }
      if (typeof ensureStarted === 'function') {
        // Best effort: a failure here falls through to the normal error path below.
        await ensureStarted().catch(() => {});
      }
      let outcome;
      try {
        outcome = await client.search(
          {
            query: request?.query,
            // The seam applies `request.maxResults` itself, but slicing here keeps the
            // payload small; the provider limit is the configured default.
            limit: Number.isFinite(request?.maxResults) ? Math.max(1, Number(request.maxResults)) : undefined,
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted === true) {
          throw new RustxngError('RustXNG search was canceled', WEB_ABORTED, { cause: error });
        }
        throw error instanceof RustxngError
          ? error
          : new RustxngError(`RustXNG search failed: ${String(error)}`, WEB_PROVIDER_ERROR, { cause: error });
      }

      if (outcome.sources.length === 0 && outcome.content === undefined) {
        const engines = outcome.meta.unresponsiveEngines;
        throw new RustxngError(
          `RustXNG returned no results for ${JSON.stringify(request?.query ?? '')}.` +
            (engines.length > 0 ? `\nUnresponsive engines: ${engines.join('; ')}` : '') +
            '\nTry a more specific query, or check `rustxng_status` (suspended engines, engine count).',
          WEB_PROVIDER_ERROR,
        );
      }

      log?.(`[rustxng] web_search → ${outcome.sources.length} sources in ${outcome.elapsedMs} ms`);
      const result = { sources: outcome.sources, truncated: outcome.meta.truncated === true };
      if (outcome.content !== undefined) result.content = outcome.content;
      return result;
    },
  };
}

/**
 * Hand the provider selection over and back again.
 *
 * Turning the feature on writes `web.searchProvider = 'rustxng'` (the same field the
 * official Web search page writes). Turning it off restores the value the user had
 * chosen before, or clears the field so the seam's automatic selection applies again.
 *
 * The previous explicit choice is remembered in memory for the running process. It is
 * not persisted: a restart while the feature is enabled keeps the selection, and a
 * restart after it is disabled is a normal "automatic selection" state.
 *
 * @param {object} options
 * @param {() => object|undefined} options.getSettings The host's `settings` service, if present.
 * @param {(message: string) => void} [options.log] Warning sink.
 * @param {string} [options.providerId] Provider id to select.
 * @param {'searchProvider'|'fetchProvider'} [options.field] Selection field to write.
 * @returns {{take: () => Promise<object>, release: () => Promise<object>, pending: () => (string|undefined)}}
 */
export function createSearchSelectionGuard({
  getSettings,
  log,
  providerId = RUSTXNG_SEARCH_PROVIDER_ID,
  field = 'searchProvider',
} = {}) {
  /** Explicit user-layer value captured when the plugin took the selection over. */
  let previous = { captured: false, value: undefined };

  const reset = () => {
    previous = { captured: false, value: undefined };
  };

  /**
   * Find the descriptor that owns the web capability's settings.
   *
   * `describe()` keys entries by profile entry id, which is `include:web` in the current
   * Harness (its namespace is the patch id). Older or differently composed profiles may
   * expose a bare `web`, so both shapes are accepted instead of assuming one.
   */
  const findRow = (rows) => {
    if (!Array.isArray(rows)) return undefined;
    const matches = (ns) =>
      typeof ns === 'string' &&
      (ns === WEB_SETTINGS_NS || ns.endsWith(`:${WEB_SETTINGS_NS}`) || ns.split(':').pop() === WEB_SETTINGS_NS);
    return rows.find((entry) => matches(entry?.ns));
  };

  const readRow = () => {
    const settings = typeof getSettings === 'function' ? getSettings() : undefined;
    if (settings === undefined || settings === null || typeof settings.describe !== 'function') {
      return { settings: undefined, row: undefined, ns: undefined };
    }
    let rows;
    try {
      rows = settings.describe();
    } catch (error) {
      log?.(`[rustxng] could not read the settings document: ${String(error)}`);
      return { settings, row: undefined, ns: undefined };
    }
    const row = findRow(rows);
    return { settings, row, ns: row?.ns };
  };

  return {
    /** Point `web.searchProvider` at this plugin's provider. */
    async take() {
      const { settings, row, ns } = readRow();
      if (settings === undefined) return { applied: false, reason: 'the host exposes no settings service' };
      if (row === undefined || ns === undefined) {
        return {
          applied: false,
          reason:
            'this host does not publish the web settings entry (DSH 0.2.0-rc.2 lists only entries with a volatile ' +
            'field), so the selection cannot be written from a plugin. Set `web.searchProvider: rustxng` in the ' +
            'profile patch, or start DSH with DSH_WEB_SEARCH_PROVIDER=rustxng.',
        };
      }
      const current = row.value?.[field];
      if (current === providerId) return { applied: true, alreadySelected: true };
      if (!previous.captured) {
        const chosen = row.user?.[field];
        previous = { captured: true, value: typeof chosen === 'string' && chosen.length > 0 ? chosen : undefined };
      }
      try {
        await settings.update(ns, { [field]: providerId });
        return { applied: true };
      } catch (error) {
        return { applied: false, reason: String(error) };
      }
    },

    /** Give the selection back: the previous explicit choice, or the automatic selection. */
    async release() {
      const { settings, row, ns } = readRow();
      if (settings === undefined || row === undefined || ns === undefined) {
        reset();
        return { released: false, reason: 'the host exposes no writable "web" settings entry' };
      }
      const current = row.value?.[field];
      if (current !== providerId) {
        // The user picked something else after us; never fight over the field.
        reset();
        return { released: false, reason: 'the selection had already changed' };
      }
      try {
        if (typeof previous.value === 'string' && previous.value.length > 0) {
          await settings.update(ns, { [field]: previous.value });
        } else if (typeof settings.mutate === 'function') {
          await settings.mutate(ns, [{ op: 'unset', path: [field] }]);
        } else {
          reset();
          return { released: false, reason: 'this host cannot clear a settings field' };
        }
        reset();
        return { released: true };
      } catch (error) {
        reset();
        return { released: false, reason: String(error) };
      }
    },

    /** The value captured at take-over (for diagnostics). */
    pending() {
      return previous.captured ? previous.value : undefined;
    },
  };
}
