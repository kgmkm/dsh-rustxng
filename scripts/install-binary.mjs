#!/usr/bin/env node
/**
 * Download a RustXNG release binary for the machine this runs on.
 *
 * RustXNG publishes one binary per platform; this script picks the matching release asset,
 * verifies its published SHA-256, and places it in `$DSH_HOME/bin` (or `--dir`). The plugin's
 * `autoStart` option calls the same module, so this CLI is only needed when you want the
 * binary without turning auto-start on.
 *
 * Usage:
 *   node scripts/install-binary.mjs [--dir <path>] [--version v0.4.1] [--musl] [--force]
 *
 * Exit codes: 0 success, 1 failure, 2 unsupported platform.
 */
import { readFileSync } from 'node:fs';
import { defaultDir, installBinary, resolveTarget } from '../lib/install-binary.js';

function parseArgs(argv) {
  const options = { dir: undefined, version: undefined, musl: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') options.dir = argv[++i];
    else if (arg === '--version') options.version = argv[++i];
    else if (arg === '--musl') options.musl = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
    return 0;
  }

  if (resolveTarget({ musl: options.musl }) === undefined) {
    console.error(
      `dsh-rustxng: no RustXNG release for ${process.platform}/${process.arch}.` +
        '\nSupported: Windows x64, macOS arm64/x64, Linux x64 (glibc or musl).' +
        '\nOn another CPU, build from source: cargo build --release',
    );
    return 2;
  }

  const result = await installBinary({
    dir: options.dir,
    version: options.version,
    musl: options.musl,
    force: options.force,
    log: (message) => console.log(`dsh-rustxng: ${message.replace(/^\[rustxng\]\s*/, '')}`),
  });

  if (result.ok !== true) {
    console.error(`dsh-rustxng: ${result.reason}`);
    return 1;
  }

  console.log(
    [
      '',
      'Next steps:',
      `  1. start it:  "${result.path}" --port 8888`,
      '  2. in DSH, open Plugins → RustXNG and switch on "Use RustXNG for web_search"',
      '     (or set baseUrl if you run it on another port/host)',
      '  3. or let the plugin do both: switch on "Start RustXNG automatically"',
      '',
    ].join('\n'),
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('install-binary.mjs')) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`dsh-rustxng: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

export { main, defaultDir };
