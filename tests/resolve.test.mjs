#!/usr/bin/env node
/**
 * Regression test for host-package resolution.
 *
 * A Linux npm-global install puts the launcher at `<prefix>/bin/dsh`, a symlink into
 * `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`. Resolving a host package from the
 * symlink's own directory looks for `<prefix>/bin/node_modules` and fails, which is exactly
 * the bug that kept the settings card from appearing on a linked checkout (reported from an
 * Ubuntu 26.04 server). This test builds that layout and asserts the fallback still resolves.
 *
 *   node tests/resolve.test.mjs
 *
 * Exit code 0 when the layout resolves (or when the platform refuses to create symlinks, in
 * which case the scenario is skipped).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginIndex = fileURLToPath(new URL('../index.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'dsh-rustxng-resolve-'));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

try {
  // <root>/host/node_modules/@deepseek-ai/stub-host-pkg  — only reachable from the real path
  const pkgDir = join(root, 'host', 'node_modules', '@deepseek-ai', 'stub-host-pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/stub-host-pkg', version: '0.0.0', type: 'module', exports: './index.js' }),
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export default { marker: "stub-host-pkg" };\n');

  // <root>/host/lib/entry.mjs  — the real launcher
  const entry = join(root, 'host', 'lib', 'entry.mjs');
  mkdirSync(join(root, 'host', 'lib'), { recursive: true });
  writeFileSync(
    entry,
    `import { hostResolutionBases, importFromHost } from ${JSON.stringify(pathToFileURL(pluginIndex).href)};
const bases = hostResolutionBases();
const resolved = await importFromHost('@deepseek-ai/stub-host-pkg');
console.log(JSON.stringify({ bases, resolved: resolved.resolved, marker: resolved.module.default?.marker }));
`,
  );

  // <root>/prefix/bin/dsh -> ../../host/lib/entry.mjs   (the Linux npm-global layout)
  const binDir = join(root, 'prefix', 'bin');
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, 'dsh');
  let symlinked = true;
  try {
    symlinkSync(entry, launcher, 'file');
  } catch (error) {
    symlinked = false;
    console.log(`SKIP symlink scenario: this platform refused to create a symlink (${error.code ?? error.message})`);
  }

  if (symlinked) {
    const child = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
    const output = (child.stdout ?? '').trim();
    check('resolves a host package through a symlinked launcher', () => {
      assert.equal(child.status, 0, `exit ${child.status}: ${child.stderr}`);
      const parsed = JSON.parse(output.split('\n').pop());
      assert.equal(parsed.marker, 'stub-host-pkg');
      assert.match(parsed.resolved, /host[\\/]node_modules/);
    });

    check('tries the real path as well as the symlink', () => {
      const parsed = JSON.parse(output.split('\n').pop());
      assert.ok(parsed.bases.length >= 2, `bases: ${JSON.stringify(parsed.bases)}`);
      assert.ok(
        parsed.bases.some((base) => base.endsWith('entry.mjs')),
        'the real entry point must be one of the bases',
      );
      assert.ok(
        parsed.bases.some((base) => base.endsWith('dsh')),
        'the launcher path as invoked must be one of the bases',
      );
    });
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
