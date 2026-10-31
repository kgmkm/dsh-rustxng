#!/usr/bin/env node
/**
 * Signal tests: a SIGTERM must take the managed child with it.
 *
 *   node tests/signal.test.mjs
 *
 * `process.on('exit')` does not run when Node dies from a signal, so this is the case the
 * Linux report broke: without a signal handler the child survived as an orphan. The fixture
 * starts a real child and then either has no handler (`plain`) or its own (`host-handler`),
 * and the assertions check both the child and the exit status.
 *
 * POSIX only: the signal semantics differ on Windows, so the whole file skips there.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

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

/** True when the pid still exists (EPERM counts as alive). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Start the fixture and resolve once it prints READY. */
function startFixture({ port, mode }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'fixtures', 'signal-host.mjs'), '--port', String(port), '--mode', mode], {
      cwd: here,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`fixture did not become ready:\n${stdout}\n${stderr}`)), 20000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = /READY child=(\d+) parent=(\d+)/.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ child, grandchild: Number(match[1]), stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited early (code ${code}, signal ${signal}):\n${stdout}\n${stderr}`));
    });
  });
}

/** Wait for the fixture to exit and report how. */
function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

if (process.platform === 'win32') {
  console.log('SKIP signal tests: signal semantics differ on Windows');
} else {
  // --- 1. no handler in the host: the default disposition must apply ------
  {
    const port = 18911;
    const fixture = await startFixture({ port, mode: 'plain' });
    const exited = waitForExit(fixture.child);
    process.kill(fixture.child.pid, 'SIGTERM');
    const result = await exited;

    await check('a SIGTERMed host ends with the signal, not by hanging', () => {
      assert.equal(result.signal, 'SIGTERM', `code=${result.code} signal=${result.signal}`);
    });

    await check('the managed child is not left behind', async () => {
      // Give the kernel a moment to reap it.
      for (let attempt = 0; attempt < 20 && isAlive(fixture.grandchild); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(isAlive(fixture.grandchild), false, `pid ${fixture.grandchild} is still alive`);
    });
  }

  // --- 2. the host has its own handler: it must keep control -------------
  {
    const port = 18912;
    const fixture = await startFixture({ port, mode: 'host-handler' });
    const exited = waitForExit(fixture.child);
    process.kill(fixture.child.pid, 'SIGTERM');
    const result = await exited;

    await check("the host's own SIGTERM handler decides the exit", () => {
      assert.equal(result.code, 0, `code=${result.code} signal=${result.signal}`);
      assert.match(fixture.stdout(), /HOST-HANDLER ran/);
    });

    await check('the managed child is stopped even when the host handles the signal', async () => {
      for (let attempt = 0; attempt < 20 && isAlive(fixture.grandchild); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(isAlive(fixture.grandchild), false, `pid ${fixture.grandchild} is still alive`);
    });
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
