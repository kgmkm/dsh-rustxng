/**
 * Fetch a RustXNG release binary for this machine.
 *
 * Shared by `scripts/install-binary.mjs` (a CLI users run) and the process supervisor (which
 * downloads on demand before starting), so the platform table, the checksum rule and the
 * cross-device staging only exist once.
 *
 * GitHub's API is rate-limited per IP, so a download never depends on it: the pinned version
 * below is used when the API cannot be reached, and a requested version needs no API at all.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Upstream repository that publishes the release assets. */
export const RELEASE_REPO = 'sahenjp/RustXNG';

/** Version used when the "latest release" lookup is unavailable (rate limits, offline API). */
export const PINNED_VERSION = '0.4.1';

/**
 * Map a platform/arch pair onto a RustXNG release target triple.
 *
 * @param {{platform?: string, arch?: string, musl?: boolean}} [options]
 * @returns {{triple: string, binary: string}|undefined} The release target, if one exists.
 */
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

/** Release asset name for a tag and target. */
export function assetName(tag, target) {
  const version = tag.replace(/^v/, '');
  return `rustxng-v${version}-${target.triple}${target.binary.endsWith('.exe') ? '.exe' : ''}`;
}

/** Asset download URL for a repository, tag and asset. */
export function assetUrl(tag, name, repo = RELEASE_REPO) {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

/** Small helper so every request carries the same identity. */
async function request(fetchImpl, url, accept) {
  const response = await fetchImpl(url, { headers: { accept, 'user-agent': 'dsh-rustxng' } });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response;
}

/**
 * Resolve the tag to install.
 *
 * @param {object} options
 * @param {string} [options.version] Explicit version (no API call).
 * @param {typeof fetch} [options.fetchImpl] Transport override (tests).
 * @param {(message: string) => void} [options.log] Progress sink.
 * @returns {Promise<{tag: string, source: 'explicit'|'latest'|'pinned'}>} The chosen release.
 */
export async function resolveTag({ version, fetchImpl = fetch, log } = {}) {
  if (typeof version === 'string' && version.trim() !== '') {
    return { tag: version.trim().startsWith('v') ? version.trim() : `v${version.trim()}`, source: 'explicit' };
  }
  try {
    const response = await request(
      fetchImpl,
      `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
      'application/vnd.github+json',
    );
    const release = await response.json();
    if (typeof release?.tag_name === 'string') return { tag: release.tag_name, source: 'latest' };
    throw new Error('no tag_name in the response');
  } catch (error) {
    log?.(`[rustxng] could not ask GitHub for the latest release (${String(error)}); using v${PINNED_VERSION}`);
    return { tag: `v${PINNED_VERSION}`, source: 'pinned' };
  }
}

/**
 * Download, verify and install the binary.
 *
 * @param {object} [options]
 * @param {string} [options.dir] Destination directory (default `$DSH_HOME/bin`).
 * @param {string} [options.version] Explicit version.
 * @param {boolean} [options.musl] Prefer the musl build on Linux.
 * @param {boolean} [options.force] Replace an existing binary.
 * @param {string} [options.platform] Platform override.
 * @param {string} [options.arch] Architecture override.
 * @param {typeof fetch} [options.fetchImpl] Transport override (tests).
 * @param {(message: string) => void} [options.log] Progress sink.
 * @returns {Promise<{ok: boolean, path?: string, tag?: string, verified?: boolean, reason?: string, code?: string}>}
 */
export async function installBinary(options = {}) {
  const {
    dir = defaultDir(),
    version,
    musl = false,
    force = false,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = fetch,
    log,
  } = options;

  const target = resolveTarget({ platform, arch, musl });
  if (target === undefined) {
    return {
      ok: false,
      code: 'unsupported',
      reason:
        `no RustXNG release for ${platform}/${arch}. Supported: Windows x64, macOS arm64/x64, ` +
        'Linux x64 (glibc or musl). On another CPU, build from source: cargo build --release',
    };
  }

  const destination = join(dir, target.binary);
  if (existsSync(destination) && !force) {
    return { ok: true, path: destination, reason: 'already installed', verified: false };
  }

  const { tag, source } = await resolveTag({ version, fetchImpl, log });
  const name = assetName(tag, target);

  let body;
  try {
    log?.(`[rustxng] downloading ${name} (${source})…`);
    body = Buffer.from(await (await request(fetchImpl, assetUrl(tag, name), 'application/octet-stream')).arrayBuffer());
  } catch (error) {
    return { ok: false, code: 'network', tag, reason: `could not download ${name}: ${String(error)}` };
  }

  // The published .sha256 asset is authoritative when present.
  let expected;
  try {
    const text = (await (await request(fetchImpl, assetUrl(tag, `${name}.sha256`), 'text/plain')).text()).trim();
    const match = /([0-9a-f]{64})/i.exec(text);
    if (match !== null) expected = match[1].toLowerCase();
  } catch {
    /* older releases may not publish it; the download still proceeds */
  }
  if (expected !== undefined) {
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== expected) {
      return { ok: false, code: 'checksum', tag, reason: `checksum mismatch (expected ${expected}, got ${actual})` };
    }
  } else {
    log?.(`[rustxng] no published checksum for ${name}; installing without verification`);
  }

  mkdirSync(dir, { recursive: true });
  // Stage next to the destination: /tmp is often a different filesystem, and a rename across
  // devices fails with EXDEV.
  const temporary = join(dir, `.rustxng-download-${process.pid}-${Date.now()}`);
  writeFileSync(temporary, body);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      try {
        unlinkSync(temporary);
      } catch {
        /* best effort */
      }
      return { ok: false, code: 'write', tag, reason: `could not install ${destination}: ${String(error)}` };
    }
    copyFileSync(temporary, destination);
    unlinkSync(temporary);
  }
  if (platform !== 'win32') chmodSync(destination, 0o755);

  log?.(`[rustxng] installed ${destination}`);
  return { ok: true, path: destination, tag, verified: expected !== undefined };
}
