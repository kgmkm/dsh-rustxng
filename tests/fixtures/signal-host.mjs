#!/usr/bin/env node
/**
 * Fixture for the signal tests: start a managed child, then wait to be killed.
 *
 *   node tests/fixtures/signal-host.mjs --port 18901 --mode plain|host-handler
 *
 * Modes:
 *   plain         no signal handler of its own — the manager must stop the child and let the
 *                 default disposition end this process with the signal
 *   host-handler  mimics a Harness that shuts itself down: it logs, then exits with code 0
 *                 after a moment. The manager must still stop the child and must NOT hijack
 *                 the exit.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessManager } from '../../lib/process-manager.js';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const port = Number(readArg('port', '18901'));
const mode = readArg('mode', 'plain');

// The managed "binary": a tiny HTTP server with the CLI flags the supervisor passes.
const dir = mkdtempSync(join(tmpdir(), 'dsh-rustxng-signal-'));
const mock = join(dir, 'mock-rustxng');
writeFileSync(
  mock,
  `#!${process.execPath}
const http = require('node:http');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] ?? 0);
http.createServer((request, response) => {
  if (request.url === '/healthz') { response.writeHead(200); response.end('OK'); return; }
  response.writeHead(404); response.end();
}).listen(port, '127.0.0.1');
`,
);
chmodSync(mock, 0o755);

if (mode === 'host-handler') {
  // Stands in for the Harness: it decides when to exit, and it must keep that decision.
  process.on('SIGTERM', () => {
    console.log('HOST-HANDLER ran');
    setTimeout(() => process.exit(0), 50);
  });
}

const manager = createProcessManager({
  getConfig: () => ({ autoStart: { enabled: true, binaryPath: mock, idleMinutes: 0, download: false } }),
  log: (message) => console.error(`[pm] ${message}`),
  probeHealth: async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      return response.ok;
    } catch {
      return false;
    }
  },
  stateDir: dir,
});

const outcome = await manager.ensureStarted({ baseUrl: `http://127.0.0.1:${port}`, port });
if (outcome.started !== true) {
  console.error(`[fixture] start failed: ${outcome.reason}`);
  process.exit(3);
}

console.log(`READY child=${outcome.pid} parent=${process.pid}`);

// Stay alive until a signal arrives (or the parent closes us).
setInterval(() => {}, 1000);
