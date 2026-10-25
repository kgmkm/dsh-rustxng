#!/usr/bin/env node
/**
 * Download a RustXNG release binary for the machine this runs on.
 *
 * RustXNG publishes one binary per platform; this script picks the matching release
 * asset, verifies its published SHA-256, and places it somewhere the plugin can reach
 * through its `baseUrl`… which means you still start it yourself (or wire it into your
 * service manager). Windows, macOS (Intel and Apple Silicon) and Linux (glibc or musl)
 * are covered.
 *
 * Usage:
 *   node scripts/install-binary.mjs [--dir <path>] [--version v0.4.0] [--musl] [--force]
 *
 * Exit codes: 0 success, 1 failure, 2 unsupported platform.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO = 'sahenjp/RustXNG';

/** Map `process.platform` + `process.arch` onto a RustXNG release target triple. */
export function resolveTarget({ platform = process.platform, arch = process.arch, musl = false } = {}) {
  if (platform === 'win32') {
    if (arch !== 'x64') return undefined;
    return { triple: 'x86_64-pc-windows-msvc', binary: 'rustxng.exe' };
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return { triple: 'aarch64-apple-darwin', binary: 'rustxng' };
    if (arch === 'x64') return { triple: 'x86_64-apple-darwin', binary: 'rustxng' };
    return undefined;
  }
  if (platform === 'linux') {
    if (arch !== 'x64') return undefined;
    return { triple: musl ? 'x86_64-unknown-linux-musl' : 'x86_64-unknown-linux-gnu', binary: 'rustxng' };
  }
  return undefined;
}

/** Default destination: a stable folder under the DSH home, so upgrades keep working. */
export function defaultDir(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'bin');
}

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

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-rustxng' } });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

async function download(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-rustxng' } });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
    return 0;
  }

  const target = resolveTarget({ musl: options.musl });
  if (target === undefined) {
    console.error(
      `dsh-rustxng: no RustXNG release for ${process.platform}/${process.arch}.` +
        '\nSupported: Windows x64, macOS arm64/x64, Linux x64 (glibc or musl).' +
        '\nOn another CPU, build from source: cargo build --release',
    );
    return 2;
  }

  const release = options.version
    ? await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/${options.version}`)
    : await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const tag = release.tag_name;
  const version = tag.replace(/^v/, '');

  const assetName = `rustxng-v${version}-${target.triple}${target.binary === 'rustxng.exe' ? '.exe' : ''}`;
  const asset = (release.assets ?? []).find((entry) => entry.name === assetName);
  if (asset === undefined) {
    console.error(
      `dsh-rustxng: release ${tag} has no asset ${assetName}.` +
        `\nAssets: ${(release.assets ?? []).map((entry) => entry.name).join(', ')}`,
    );
    return 1;
  }

  const dir = resolve(options.dir ?? defaultDir());
  mkdirSync(dir, { recursive: true });
  const destination = join(dir, target.binary);
  if (existsSync(destination) && !options.force) {
    console.log(`dsh-rustxng: ${destination} already exists (use --force to replace it).`);
  } else {
    console.log(`dsh-rustxng: downloading ${assetName} (${(asset.size / 1024 / 1024).toFixed(1)} MiB)…`);
    const body = await download(asset.browser_download_url);

    // The published .sha256 asset is authoritative; the API digest is the fallback.
    let expected = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : undefined;
    const sumAsset = (release.assets ?? []).find((entry) => entry.name === `${assetName}.sha256`);
    if (sumAsset !== undefined) {
      const text = (await download(sumAsset.browser_download_url)).toString('utf8').trim();
      const match = /([0-9a-f]{64})/i.exec(text);
      if (match !== null) expected = match[1].toLowerCase();
    }
    if (expected !== undefined) {
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== expected.toLowerCase()) {
        console.error(`dsh-rustxng: checksum mismatch\n  expected ${expected}\n  actual   ${actual}`);
        return 1;
      }
      console.log('dsh-rustxng: checksum verified');
    } else {
      console.warn('dsh-rustxng: no published checksum for this asset; continuing without verification');
    }

    const temporary = join(tmpdir(), `rustxng-${process.pid}-${Date.now()}`);
    writeFileSync(temporary, body);
    renameSync(temporary, destination);
    if (process.platform !== 'win32') chmodSync(destination, 0o755);
    console.log(`dsh-rustxng: installed ${destination}`);
  }

  console.log(
    [
      '',
      'Next steps:',
      `  1. start it:  "${destination}" --port 8888`,
      '  2. in DSH, open Plugins → RustXNG and switch on "Use RustXNG for web_search"',
      '     (or set baseUrl if you run it on another port/host)',
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

export { main };
