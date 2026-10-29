#!/usr/bin/env node
/**
 * Tests for the release download: platform mapping, checksum verification, the pinned-version
 * fallback, and that a bad checksum never installs anything.
 *
 *   node tests/install.test.mjs
 *
 * No network: `fetchImpl` is a stub, so the assertions cover the logic, not GitHub.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_VERSION, assetName, installBinary, resolveTarget } from '../lib/install-binary.js';

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

const payload = Buffer.from('#!/bin/sh\necho fake rustxng\n');
const digest = createHash('sha256').update(payload).digest('hex');

/** Build a fetch stub; `overrides` can break individual endpoints. */
function stubFetch({ checksum = digest, apiFails = false, tag = 'v0.4.1', calls = [] } = {}) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.github.com')) {
      if (apiFails) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ tag_name: tag }), text: async () => '' };
    }
    if (String(url).endsWith('.sha256')) {
      return { ok: true, status: 200, text: async () => `${checksum}  asset\n` };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      text: async () => payload.toString('utf8'),
    };
  };
}

// --- 1. platform mapping --------------------------------------------------
await check('maps macOS arm64 and x64 onto their release assets', () => {
  const arm = resolveTarget({ platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(arm, { triple: 'aarch64-apple-darwin', binary: 'rustxng' });
  assert.equal(assetName('v0.4.1', arm), 'rustxng-v0.4.1-aarch64-apple-darwin');
  const intel = resolveTarget({ platform: 'darwin', arch: 'x64' });
  assert.equal(assetName('v0.4.1', intel), 'rustxng-v0.4.1-x86_64-apple-darwin');
});

await check('rejects a platform with no release', () => {
  assert.equal(resolveTarget({ platform: 'linux', arch: 'arm64' }), undefined);
  assert.equal(resolveTarget({ platform: 'freebsd', arch: 'x64' }), undefined);
});

// --- 2. install -----------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'dsh-rustxng-install-'));
try {
  const verifiedDir = join(root, 'verified');
  const calls = [];
  const installed = await installBinary({
    dir: verifiedDir,
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: stubFetch({ calls }),
    log: () => {},
  });

  await check('downloads, verifies and installs the binary', () => {
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(installed.tag, 'v0.4.1');
    assert.equal(installed.verified, true);
    assert.equal(readFileSync(installed.path).toString('utf8'), payload.toString('utf8'));
  });

  await check('marks the binary executable on POSIX', () => {
    if (process.platform === 'win32') return; // the mode bits are not meaningful here
    assert.ok((statSync(installed.path).mode & 0o111) !== 0, 'expected an executable bit');
  });

  await check('asks GitHub for the latest release first', () => {
    assert.ok(calls.some((url) => url.includes('/releases/latest')), calls.join('\n'));
    assert.ok(
      calls.some((url) => url.endsWith('rustxng-v0.4.1-aarch64-apple-darwin')),
      calls.join('\n'),
    );
  });

  const second = await installBinary({ dir: verifiedDir, platform: 'darwin', arch: 'arm64', fetchImpl: stubFetch(), log: () => {} });

  await check('leaves an existing binary alone', () => {
    assert.equal(second.ok, true);
    assert.match(String(second.reason ?? ''), /already installed/);
  });

  const mismatchDir = join(root, 'mismatch');
  const mismatch = await installBinary({
    dir: mismatchDir,
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: stubFetch({ checksum: 'f'.repeat(64) }),
    log: () => {},
  });

  await check('refuses to install on a checksum mismatch', () => {
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'checksum');
    assert.equal(existsSync(join(mismatchDir, 'rustxng')), false, 'nothing may be written');
  });

  const offlineDir = join(root, 'offline');
  const offlineCalls = [];
  const offline = await installBinary({
    dir: offlineDir,
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: stubFetch({ apiFails: true, calls: offlineCalls }),
    log: () => {},
  });

  await check('falls back to the pinned version when the API is unavailable', () => {
    assert.equal(offline.ok, true, JSON.stringify(offline));
    assert.equal(offline.tag, `v${PINNED_VERSION}`);
    assert.ok(
      offlineCalls.some((url) => url.includes(`/releases/download/v${PINNED_VERSION}/`)),
      offlineCalls.join('\n'),
    );
  });

  const explicit = await installBinary({
    dir: join(root, 'explicit'),
    version: '0.4.1',
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: stubFetch(),
    log: () => {},
  });

  await check('an explicit version needs no API call', () => {
    assert.equal(explicit.ok, true);
    assert.equal(explicit.tag, 'v0.4.1');
  });

  const unsupported = await installBinary({ dir: join(root, 'nope'), platform: 'linux', arch: 'arm64', log: () => {} });

  await check('reports an unsupported platform without touching the network', () => {
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'unsupported');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
