#!/usr/bin/env node
/**
 * Smoke tests: offline unit checks plus one optional live search against a running
 * RustXNG instance.
 *
 *   node tests/smoke.mjs                     # uses http://127.0.0.1:8888
 *   RUSTXNG_BASE_URL=http://host:8888 node tests/smoke.mjs
 *
 * Exit code 0 when every check passes (a missing instance is reported, not failed).
 */
import assert from 'node:assert/strict';
import { normalizeSearchPayload, createRustxngClient } from '../lib/rustxng-client.js';
import { resolveTarget } from '../lib/install-binary.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check('normalizes results, answers and engine names', () => {
  const payload = {
    query: 'rust',
    results: [
      {
        url: 'https://www.rust-lang.org/',
        title: 'Rust Programming Language',
        content: 'A language empowering everyone.',
        engine: 'duckduckgo',
        engines: ['duckduckgo', 'bing'],
        publishedDate: '2024-03-01T00:00:00Z',
      },
      { url: 'https://www.rust-lang.org/', title: 'duplicate' },
      { url: 'ftp://example.invalid/x', title: 'not http' },
      { title: 'no url' },
    ],
    answers: [{ answer: 'Rust is a systems language.' }],
    infoboxes: [],
    suggestions: ['rustlang'],
    corrections: [],
    unresponsive_engines: [['google', 'Access denied']],
  };
  const normalized = normalizeSearchPayload(payload);
  assert.equal(normalized.sources.length, 1, 'deduplicates and drops non-http URLs');
  assert.equal(normalized.sources[0].title, 'Rust Programming Language');
  assert.equal(normalized.sources[0].snippet, 'A language empowering everyone.');
  assert.equal(normalized.sources[0].publishedAt, '2024-03-01T00:00:00.000Z');
  assert.equal(normalized.content, 'Rust is a systems language.');
  assert.deepEqual(normalized.meta.engines, ['bing', 'duckduckgo']);
  assert.deepEqual(normalized.meta.unresponsiveEngines, ['google: Access denied']);
});

check('drops an unparseable date instead of guessing', () => {
  const normalized = normalizeSearchPayload({ results: [{ url: 'https://a.example', publishedDate: '2 days ago' }] });
  assert.equal(normalized.sources[0].publishedAt, undefined);
});

check('maps every supported platform to a release target', () => {
  assert.equal(resolveTarget({ platform: 'win32', arch: 'x64' }).triple, 'x86_64-pc-windows-msvc');
  assert.equal(resolveTarget({ platform: 'darwin', arch: 'arm64' }).triple, 'aarch64-apple-darwin');
  assert.equal(resolveTarget({ platform: 'darwin', arch: 'x64' }).triple, 'x86_64-apple-darwin');
  assert.equal(resolveTarget({ platform: 'linux', arch: 'x64' }).triple, 'x86_64-unknown-linux-gnu');
  assert.equal(resolveTarget({ platform: 'linux', arch: 'x64', musl: true }).triple, 'x86_64-unknown-linux-musl');
  assert.equal(resolveTarget({ platform: 'linux', arch: 'arm64' }), undefined, 'unsupported arch reports undefined');
});

const baseUrl = process.env.RUSTXNG_BASE_URL ?? 'http://127.0.0.1:8888';
const client = createRustxngClient({
  getConfig: () => ({ baseUrl, timeoutMs: 20000, defaultLimit: 5 }),
  log: () => {},
});

const probe = await client.probe({ timeoutMs: 4000 });
if (probe.ok !== true) {
  console.log(`SKIP live search: no RustXNG at ${baseUrl} (${probe.error ?? 'unreachable'})`);
} else {
  console.log(`INFO live instance ${baseUrl} version ${probe.version ?? '(unknown)'}`);
  const outcome = await client.search({ query: 'rust programming language', limit: 5 });
  check('live search returns citeable sources', () => {
    assert.ok(outcome.sources.length > 0, 'expected at least one source');
    assert.ok(outcome.sources.length <= 5, 'limit is applied');
    for (const source of outcome.sources) assert.match(source.url, /^https?:\/\//);
  });
  check('live search reports engines and timing', () => {
    assert.ok(outcome.meta.engines.length > 0, 'expected engine names');
    assert.ok(outcome.elapsedMs >= 0);
  });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
