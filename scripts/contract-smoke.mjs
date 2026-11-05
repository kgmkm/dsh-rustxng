#!/usr/bin/env node
/**
 * Contract smoke for an upstream RustXNG release (policy: docs/UPSTREAM.md).
 *
 *   node scripts/contract-smoke.mjs                      # download the latest release first
 *   node scripts/contract-smoke.mjs --version 0.28.0     # a specific release
 *   node scripts/contract-smoke.mjs --binary ./rustxng   # use an existing binary
 *   node scripts/contract-smoke.mjs --port 29511 --json
 *   node scripts/contract-smoke.mjs --force              # re-download over a cached copy
 *
 * The instance is started through the plugin's own supervisor, so the managed start path
 * (`--bind`/`--port` plus `SEARXNG_PORT`) is part of what is being checked, and the child is
 * always stopped before this exits. Only the four surfaces the plugin depends on are asserted:
 * `/healthz`, `/search?format=json`, `/config`, and the launch flags.
 *
 * Exit codes: 0 every check passed, 1 at least one failed, 2 the binary could not be obtained.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBinary } from '../lib/install-binary.js';
import { createProcessManager } from '../lib/process-manager.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const port = Number(flag('port', '29511'));
const asJson = argv.includes('--json');
const base = `http://127.0.0.1:${port}`;
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!asJson) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`);
}

let binary = flag('binary', undefined);
if (binary === undefined) {
  const dir = join(tmpdir(), 'dsh-rustxng-contract-smoke');
  const installed = await installBinary({
    dir,
    version: flag('version', undefined),
    force: argv.includes('--force'),
    log: (line) => console.log(line),
  });
  if (installed.ok !== true) {
    console.log(`could not obtain a binary: ${installed.reason ?? 'unknown'}`);
    process.exit(2);
  }
  binary = installed.path;
  const label = installed.tag === undefined
    ? `${installed.reason ?? 'existing file'} (pass --force to re-download)`
    : `${installed.tag} (${installed.source ?? 'unknown'})`;
  record('binary ready', true, label);
}

const manager = createProcessManager({
  getConfig: () => ({ autoStart: { enabled: true, binaryPath: binary, idleMinutes: 1, download: false } }),
  log: asJson ? () => {} : (line) => console.log(`  ${line}`),
  probeHealth: async (url) => {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  },
  stateDir: tmpdir(),
});

try {
  const started = await manager.ensureStarted({ baseUrl: base, port, bindAddress: '127.0.0.1' });
  record('managed start', started.started === true || manager.status().managed === true, JSON.stringify(started));

  const health = await (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) })).text();
  record('/healthz answers', health.trim().length > 0, JSON.stringify(health.trim()));

  const config = await (await fetch(`${base}/config`, { signal: AbortSignal.timeout(10000) })).json();
  const engines = Array.isArray(config?.engines) ? config.engines : [];
  const names = engines.map((engine) => engine?.name).filter((name) => typeof name === 'string');
  record('/config publishes engines[]', engines.length > 0, `${engines.length} configured / ${engines.filter((engine) => engine?.enabled !== false).length} enabled`);
  const googleFamily = names.filter((name) => /google|youtube|startpage/i.test(name));
  if (!asJson) console.log(`  google-family engines: ${googleFamily.length === 0 ? '(none)' : googleFamily.join(', ')}`);

  const response = await fetch(`${base}/search?q=rust+async+runtime&format=json`, {
    signal: AbortSignal.timeout(40000),
  });
  const body = await response.json().catch(() => undefined);
  const rows = Array.isArray(body?.results) ? body.results : [];
  record('/search?format=json answers', response.ok && rows.length > 0, `HTTP ${response.status}, ${rows.length} rows`);
  const first = rows[0] ?? {};
  record(
    'result rows carry url/title',
    typeof first.url === 'string' && first.url.length > 0 && typeof first.title === 'string',
    `${(first.title ?? '').slice(0, 48)} | ${(first.url ?? '').slice(0, 48)}`,
  );
  if (!asJson) {
    console.log(`  unresponsive_engines: ${JSON.stringify((body?.unresponsive_engines ?? []).slice(0, 4))}`);
    const status = manager.status();
    console.log(`  managed: ${status.managed} pid=${status.pid}`);
  }
} catch (error) {
  record('contract smoke ran', false, error instanceof Error ? error.message : String(error));
} finally {
  manager.stop('contract smoke finished');
  manager.dispose();
}

const failed = checks.filter((check) => check.ok !== true).length;
if (asJson) console.log(JSON.stringify({ binary, port, checks, failed }, null, 2));
else console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
// Set the code instead of calling process.exit(): on Windows, exiting while the child's handle
// is still closing trips a libuv assertion even though every check passed.
process.exitCode = failed === 0 ? 0 : 1;
