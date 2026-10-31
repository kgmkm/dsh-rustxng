#!/usr/bin/env node
/**
 * Tests for the two tools: auto-start must be attempted by `rustxng_search` (a tool-only setup
 * used to get ECONNREFUSED forever), while `rustxng_status` stays read-only.
 *
 *   node tests/tools.test.mjs
 *
 * No instance and no network: the client is a stub whose calls are recorded.
 */
import assert from 'node:assert/strict';
import { buildRustxngTools } from '../lib/tools.js';

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

/** Minimal `defineTool` stand-in: keep the definition as-is. */
const defineTool = (definition) => definition;

const baseConfig = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8888',
  defaultLimit: 12,
  timeoutMs: 20000,
  language: '',
  timeRange: '',
  safeSearch: -1,
  categories: [],
  webSearch: { enabled: true, autoSelect: true },
};

/** Client stub: records the order of calls and returns a fixed payload. */
function createStubClient({ reachable = false } = {}) {
  const calls = [];
  return {
    calls,
    async search() {
      calls.push('search');
      return {
        content: 'ok',
        sources: [{ url: 'https://example.com', title: 'Example', snippet: 'example' }],
        truncated: false,
        elapsedMs: 1234,
        meta: { engines: [{ name: 'stub' }], unresponsiveEngines: [], suggestions: [], query: 'rust' },
      };
    },
    async probe() {
      calls.push('probe');
      return { ok: reachable, baseUrl: 'http://127.0.0.1:8888', version: undefined, error: reachable ? undefined : 'connect ECONNREFUSED' };
    },
  };
}

// --- rustxng_search starts the instance first ------------------------------
{
  const client = createStubClient();
  const order = [];
  const tools = buildRustxngTools({
    defineTool,
    client,
    getConfig: () => baseConfig,
    ensureStarted: async () => {
      order.push('ensureStarted');
    },
  });
  const search = tools.find((tool) => tool.name === 'rustxng_search');
  const result = await search.execute({ query: 'rust' }, { signal: undefined });

  await check('rustxng_search awaits auto-start before searching', () => {
    assert.deepEqual(order, ['ensureStarted']);
    assert.deepEqual(client.calls, ['search']);
  });

  await check('rustxng_search returns the sources', () => {
    assert.match(String(result), /example\.com|Example/);
  });
}

await check('rustxng_search survives an auto-start failure', async () => {
  const client = createStubClient();
  const tools = buildRustxngTools({
    defineTool,
    client,
    getConfig: () => baseConfig,
    ensureStarted: async () => {
      throw new Error('no binary');
    },
  });
  const search = tools.find((tool) => tool.name === 'rustxng_search');
  const outcome = await search.execute({ query: 'rust' }, { signal: undefined }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  // The tool reports the connection problem, it does not crash on the start attempt.
  assert.equal(outcome.ok, true, String(outcome.error ?? ''));
});

// --- rustxng_status stays read-only --------------------------------------
{
  const client = createStubClient({ reachable: false });
  const started = [];
  const tools = buildRustxngTools({
    defineTool,
    client,
    getConfig: () => baseConfig,
    ensureStarted: async () => {
      started.push('started');
    },
  });
  const status = tools.find((tool) => tool.name === 'rustxng_status');
  const text = await status.execute({}, { signal: undefined });

  await check('rustxng_status does not start the instance', () => {
    assert.deepEqual(started, [], 'status must not spawn a process');
    assert.deepEqual(client.calls, ['probe']);
  });

  await check('rustxng_status explains how to fix an unreachable instance', () => {
    assert.match(String(text), /not answering|ECONNREFUSED/);
  });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
