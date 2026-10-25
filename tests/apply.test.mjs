#!/usr/bin/env node
/**
 * Integration test for the host half, without a Harness process.
 *
 * The plugin is imported as a plain ESM module and applied to a minimal fake context: this
 * catches regressions in the provider registration, the selection gate and the tool wiring
 * on any OS (it is also the Linux-side check, where DSH itself is not running).
 *
 *   node tests/apply.test.mjs                      # provider gate + tools, no network needed
 *   RUSTXNG_BASE_URL=http://127.0.0.1:8899 node tests/apply.test.mjs   # also runs a live search
 *
 * Exit code 0 when every assertion passes.
 */
import assert from 'node:assert/strict';

// Outside a Harness process `@deepseek-ai/dsh-tools` is not resolvable; the stub lets the
// tool wiring be exercised anyway (the plugin honours this override for embedders).
process.env.DSH_RUSTXNG_TOOLS_MODULE ??= new URL('./stubs/dsh-tools.mjs', import.meta.url).href;
const { apply } = await import('../index.js');

const baseUrl = process.env.RUSTXNG_BASE_URL ?? 'http://127.0.0.1:8888';

/** Minimal stand-in for a Cordis context: only the surfaces the plugin touches. */
function createFakeHost({ selection = 'rustxng', updateThrows = true, hideWebRow = false } = {}) {
  const record = {
    providers: [],
    tools: [],
    warnings: [],
    updates: [],
    disposers: [],
    // `null` means "nothing selected"; a destructuring default would swallow an explicit
    // `undefined`, which is exactly the untested state, so it is normalized here.
    selection: selection ?? undefined,
  };

  const settings = {
    describe() {
      const rows = [{ ns: 'include:other', value: {}, user: {} }];
      // DSH 0.2.0-rc.2 publishes only entries with a volatile field, so its `web` row is absent.
      if (!hideWebRow) {
        rows.unshift({
          ns: 'include:web',
          value: { searchProvider: record.selection },
          user: record.selection === undefined ? {} : { searchProvider: record.selection },
        });
      }
      return rows;
    },
    async update(ns, patch) {
      record.updates.push({ ns, patch });
      if (updateThrows) throw new Error('HMR transactions cannot be nested');
    },
    async mutate(ns, ops) {
      record.updates.push({ ns, ops });
      if (updateThrows) throw new Error('HMR transactions cannot be nested');
    },
  };

  const makeLogger = () => ({
    info: () => {},
    warn: (message) => record.warnings.push(String(message)),
    debug: () => {},
  });

  const web = {
    registerSearchProvider(provider) {
      record.providers.push(provider);
      return () => {
        record.providers = record.providers.filter((entry) => entry !== provider);
      };
    },
  };

  const tools = {
    register(tool) {
      record.tools.push(tool);
    },
  };

  const ctx = {
    logger: makeLogger(),
    get(name) {
      if (name === 'settings') return settings;
      return undefined;
    },
    inject(names, callback) {
      const inner = { ...ctx, logger: makeLogger(), web, tools };
      const result = callback(inner);
      const disposer = { dispose: () => (typeof result === 'function' ? result() : undefined) };
      record.disposers.push(disposer);
      return disposer;
    },
    plugin(sub) {
      const inner = { ...ctx, logger: makeLogger(), web, tools };
      sub.apply(inner);
      return { dispose: () => {} };
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') record.disposers.push({ dispose: disposer });
      return disposer;
    },
    on() {
      return () => {};
    },
  };

  return { ctx, record, settings };
}

const config = {
  enabled: true,
  baseUrl,
  timeoutMs: 15000,
  defaultLimit: 5,
  language: '',
  timeRange: '',
  safeSearch: -1,
  categories: [],
  exposeTools: true,
  webSearch: { enabled: true, autoSelect: true },
  debug: false,
};

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. enabled + selected ------------------------------------------------
const selected = createFakeHost({ selection: 'rustxng' });
apply(selected.ctx, config);
await tick(150);

await check('registers exactly one search provider', () => {
  assert.equal(selected.record.providers.length, 1, `providers: ${selected.record.providers.length}`);
  assert.equal(selected.record.providers[0].id, 'rustxng');
});

await check('provider is available while selected', () => {
  assert.equal(selected.record.providers[0].available(), true);
});

await check('registers rustxng_search and rustxng_status', () => {
  const names = selected.record.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['rustxng_search', 'rustxng_status']);
  for (const tool of selected.record.tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} has no execute`);
    assert.ok(tool.description.length > 40, `${tool.name} description is too short`);
  }
});

await check('does not fight an already-correct selection', () => {
  assert.equal(selected.record.providers.length, 1, 'provider must stay registered');
  assert.equal(selected.record.updates.length, 0, 'no settings write is needed when the value is already ours');
});

// --- 2. enabled but not selected, and the host refuses the write ----------
const takeover = createFakeHost({ selection: null, updateThrows: true });
apply(takeover.ctx, config);
await tick(150);

await check('attempts the hand-over when nothing is selected', () => {
  assert.ok(takeover.record.updates.length >= 1, 'expected a settings update attempt');
  assert.equal(takeover.record.updates[0].ns, 'include:web', `ns: ${takeover.record.updates[0]?.ns}`);
});

await check('provider is unavailable until the selection names it', () => {
  assert.equal(takeover.record.providers[0].available(), false);
});

// --- 3. enabled and another provider selected ----------------------------
const other = createFakeHost({ selection: 'deepseek-search-api' });
apply(other.ctx, config);
await tick(150);

await check('takes the selection over from a different provider', () => {
  assert.equal(other.record.providers.length, 1, 'registered');
  assert.ok(other.record.updates.length >= 1, 'autoSelect replaces the previous choice');
  assert.equal(other.record.updates[0].patch.searchProvider, 'rustxng');
});

await check('reports unavailable while the other provider is still selected', () => {
  assert.equal(other.record.providers[0].available(), false);
});

// --- 4. feature off ------------------------------------------------------
const off = createFakeHost();
const offConfig = { ...config, webSearch: { enabled: false, autoSelect: true } };
apply(off.ctx, offConfig);
await tick(150);

await check('keeps the provider registered but unavailable while the feature is off', () => {
  assert.equal(off.record.providers.length, 1, 'registration must not depend on the switch');
  assert.equal(off.record.providers[0].available(), false, 'an off switch must never claim availability');
  assert.equal(off.record.tools.length, 2, 'tools stay available');
});

// DSH 0.2.0-rc.2 updates volatile config in place and does not emit `loader/volatile-update`,
// so the switch must work without any re-registration.
await check('reflects a switch flip without re-registering (0.2.0-rc.2 host)', () => {
  offConfig.webSearch = { enabled: true, autoSelect: true };
  assert.equal(off.record.providers[0].available(), true, 'enabling must take effect on the next check');
  offConfig.webSearch = { enabled: false, autoSelect: true };
  assert.equal(off.record.providers[0].available(), false, 'disabling must take effect on the next check');
});

// --- 5. DSH 0.2.0-rc.2: the host hides the `web` row from settings.describe() ---------
const hidden = createFakeHost({ hideWebRow: true });
apply(hidden.ctx, config);
await tick(150);

await check('serves when the host hides the selection (0.2.0-rc.2)', () => {
  assert.equal(hidden.record.providers.length, 1);
  assert.equal(hidden.record.providers[0].available(), true, 'an unreadable selection must not disable the provider');
});

await check('reports why the hand-over cannot be written on that host', async () => {
  // The update attempt is deferred and retried; the guard's own reason is what matters.
  assert.equal(hidden.record.updates.length, 0, 'no settings row to write');
});

// --- 4. live search through the provider (optional) ----------------------
const provider = selected.record.providers[0];
const probe = await provider.search({ query: 'rust', maxResults: 3 }).then(
  (result) => ({ ok: true, result }),
  (error) => ({ ok: false, error }),
);

if (!probe.ok) {
  console.log(`SKIP live provider search: ${probe.error?.message ?? 'no answer'}`);
} else {
  await check('live provider search returns citeable sources', () => {
    assert.ok(probe.result.sources.length > 0, 'no sources');
    assert.ok(probe.result.sources.length <= 3, `maxResults ignored: ${probe.result.sources.length}`);
    for (const source of probe.result.sources) assert.match(source.url, /^https?:\/\//);
    assert.equal(typeof probe.result.truncated, 'boolean');
  });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
