#!/usr/bin/env node
/**
 * Tests for the process supervisor: the idle rule, binary discovery, and — on POSIX — a real
 * start/stop cycle against a mock binary.
 *
 *   node tests/process.test.mjs
 *
 * The spawn half is skipped where an executable script with a shebang is not runnable
 * (Windows without a shell), so the pure rules still run everywhere.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  binaryCandidates,
  binaryName,
  createProcessManager,
  resolveBinary,
  shouldStopAfterIdle,
} from '../lib/process-manager.js';

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

// --- 1. idle rule ---------------------------------------------------------
await check('idle rule: 0 disables the timeout', () => {
  assert.equal(shouldStopAfterIdle({ lastUsedAt: 1, now: 10_000_000, idleMinutes: 0 }), false);
  assert.equal(shouldStopAfterIdle({ lastUsedAt: 1, now: 10_000_000, idleMinutes: -5 }), false);
});

await check('idle rule: fires only after the configured window', () => {
  const now = 10 * 60 * 60 * 1000;
  assert.equal(shouldStopAfterIdle({ lastUsedAt: now - 59 * 60_000, now, idleMinutes: 60 }), false);
  assert.equal(shouldStopAfterIdle({ lastUsedAt: now - 60 * 60_000, now, idleMinutes: 60 }), true);
  assert.equal(shouldStopAfterIdle({ lastUsedAt: now - 61 * 60_000, now, idleMinutes: 60 }), true);
});

await check('idle rule: no recorded activity means no timeout', () => {
  assert.equal(shouldStopAfterIdle({ lastUsedAt: 0, now: 10_000_000, idleMinutes: 60 }), false);
});

// --- 2. binary discovery --------------------------------------------------
await check('binary name follows the platform', () => {
  assert.equal(binaryName('win32'), 'rustxng.exe');
  assert.equal(binaryName('linux'), 'rustxng');
  assert.equal(binaryName('darwin'), 'rustxng');
});

await check('an explicit path wins and DSH_HOME/bin is searched', () => {
  // Build the PATH with the running platform's separator: `binaryCandidates` splits exactly
  // like Node's `delimiter`, so a POSIX-shaped PATH would be one entry on Windows.
  const separator = process.platform === 'win32' ? ';' : ':';
  const explicit = join('/opt/rust/bin', binaryName(process.platform));
  const candidates = binaryCandidates({
    explicit,
    env: { DSH_HOME: '/tmp/dsh-home', PATH: `/usr/bin${separator}/usr/local/bin`, HOME: '/home/x' },
    platform: process.platform,
  });
  assert.equal(candidates[0], explicit);
  assert.ok(candidates.includes(join('/tmp/dsh-home', 'bin', binaryName(process.platform))));
  assert.ok(candidates.includes(join('/usr/local/bin', binaryName(process.platform))));
  assert.equal(new Set(candidates).size, candidates.length, 'candidates must be unique');
});

const root = mkdtempSync(join(tmpdir(), 'dsh-rustxng-proc-'));

try {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, binaryName('linux'));
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);

  await check('resolveBinary finds the first existing candidate', () => {
    const found = resolveBinary({ explicit: '', env: { DSH_HOME: root, PATH: '' }, platform: 'linux' });
    assert.equal(found, binary);
  });

  await check('resolveBinary returns undefined when nothing exists', () => {
    const found = resolveBinary({ explicit: join(root, 'nope'), env: { DSH_HOME: join(root, 'nowhere'), PATH: '' }, platform: 'linux' });
    assert.equal(found, undefined);
  });

  // --- 3. real start/stop against a mock binary (POSIX only) -------------
  if (process.platform !== 'win32') {
    const mock = join(root, 'mock-rustxng');
    writeFileSync(
      mock,
      `#!${process.execPath}
const http = require('node:http');
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = Number(args[portIndex + 1] ?? 0);
http.createServer((request, response) => {
  if (request.url === '/healthz') { response.writeHead(200); response.end('OK'); return; }
  response.writeHead(404); response.end();
}).listen(port, '127.0.0.1');
`,
    );
    chmodSync(mock, 0o755);

    const config = { autoStart: { enabled: true, binaryPath: mock, idleMinutes: 0.02 } };
    const manager = createProcessManager({
      getConfig: () => config,
      log: () => {},
      probeHealth: async (baseUrl) => {
        try {
          const response = await fetch(`${baseUrl}/healthz`);
          return response.ok;
        } catch {
          return false;
        }
      },
      stateDir: root,
    });

    const target = { baseUrl: 'http://127.0.0.1:18899', port: 18899 };
    const started = await manager.ensureStarted(target);

    await check('starts the binary and waits for a healthy instance', () => {
      assert.equal(started.started, true, JSON.stringify(started));
      assert.equal(manager.status().managed, true);
    });

    await check('records activity for the idle timer', () => {
      assert.equal(typeof manager.status().idleMs, 'number');
    });

    await check('does not start a second copy while healthy', async () => {
      const again = await manager.ensureStarted(target);
      assert.equal(again.started, false);
      assert.match(String(again.reason ?? ''), /already|managed/);
    });

    // Age the activity record rather than sleeping for the real timeout.
    manager.touch();
    const stopped = manager.tick(); // not idle yet
    await check('does not stop a recently used instance', () => {
      assert.equal(stopped, false);
      assert.equal(manager.status().managed, true);
    });

    // Force the idle window open: 0.02 min = 1.2 s.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const idleStopped = manager.tick();

    await check('stops the instance once the idle window elapses', () => {
      assert.equal(idleStopped, true, 'tick() should have stopped it');
      assert.equal(manager.status().managed, false);
    });
  } else {
    console.log('SKIP real start/stop: an executable shebang script is POSIX-only in this test');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
