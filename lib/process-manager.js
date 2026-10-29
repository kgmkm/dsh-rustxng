/**
 * Owns the RustXNG process the plugin may start for you.
 *
 * Why a supervisor and not "just spawn it": a detached helper survives the Harness, so a
 * crash leaves a process nobody stops. This module therefore
 *   - starts the binary only when the instance does not already answer,
 *   - tracks the process it started (and never touches one it did not),
 *   - stops it when the plugin unloads, and
 *   - stops it after `idleMinutes` without a search or a probe, which is the only thing that
 *     can clean up after a Harness that was killed outright.
 *
 * No shell is involved (arguments go straight to spawn), and stdout/stderr go to files rather
 * than pipes so a confined runtime never blocks on a full pipe.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { defaultDir, installBinary } from './install-binary.js';

/** Binary name for this platform. */
export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'rustxng.exe' : 'rustxng';
}

/**
 * Decide whether an owned process has been idle for too long.
 *
 * Kept as a pure function so the rule is testable without spawning anything.
 *
 * @param {object} input
 * @param {number} input.lastUsedAt Epoch milliseconds of the last activity.
 * @param {number} input.now Epoch milliseconds of "now".
 * @param {number} input.idleMinutes Timeout; `0` or less disables the rule.
 * @returns {boolean} True when the process should be stopped.
 */
export function shouldStopAfterIdle({ lastUsedAt, now, idleMinutes }) {
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) return false;
  if (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0) return false;
  return now - lastUsedAt >= idleMinutes * 60_000;
}

/** Candidate locations for the binary, most specific first. */
export function binaryCandidates({ explicit, env = process.env, platform = process.platform } = {}) {
  const name = binaryName(platform);
  const candidates = [];
  if (typeof explicit === 'string' && explicit.trim() !== '') candidates.push(explicit.trim());
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
  candidates.push(join(dshHome, 'bin', name));
  if (env.USERPROFILE || env.HOME) candidates.push(join(homedir(), '.local', 'bin', name));
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const entry of pathValue.split(delimiter)) {
    if (entry.trim() !== '') candidates.push(join(entry.trim(), name));
  }
  return [...new Set(candidates)];
}

/** First existing candidate, or `undefined`. */
export function resolveBinary(options = {}) {
  return binaryCandidates(options).find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/** Start one process and return a small handle around it. */
function spawnServer({ binary, port, bindAddress, logFile }) {
  let out;
  try {
    mkdirSync(join(logFile, '..'), { recursive: true });
  } catch {
    /* the directory usually exists */
  }
  try {
    out = openSync(logFile, 'a');
  } catch {
    out = 'ignore';
  }
  const child = spawn(binary, ['--bind', bindAddress, '--port', String(port)], {
    stdio: ['ignore', out, out],
    windowsHide: true,
    detached: false,
  });
  if (typeof out === 'number') {
    try {
      closeSync(out);
    } catch {
      /* the child holds its own duplicate */
    }
  }
  return child;
}

/**
 * Create the supervisor.
 *
 * @param {object} options
 * @param {() => object} options.getConfig Live plugin config.
 * @param {(message: string) => void} [options.log] Debug sink.
 * @param {(url: string, options?: object) => Promise<boolean>} options.probeHealth Reachability check.
 * @param {string} [options.stateDir] Where the child's log file goes.
 * @param {object} [options.installOptions] Extra options for the binary download (tests).
 * @returns {object} Supervisor API.
 */
export function createProcessManager({ getConfig, log, probeHealth, stateDir, installOptions = {} }) {
  const state = {
    child: null,
    pid: undefined,
    startedAt: undefined,
    lastUsedAt: 0,
    lastError: undefined,
    stopping: false,
  };

  const autoStartConfig = () => {
    const cfg = (getConfig() ?? {}).autoStart ?? {};
    const read = (value, fallback) => {
      if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        const current = value.get();
        return current === undefined ? fallback : current;
      }
      return value === undefined ? fallback : value;
    };
    return {
      enabled: read(cfg.enabled, false) === true,
      binaryPath: String(read(cfg.binaryPath, '') ?? '').trim(),
      idleMinutes: Number(read(cfg.idleMinutes, 60)) || 0,
      download: read(cfg.download, true) !== false,
    };
  };

  /** Record activity so the idle timer starts from now. */
  const touch = () => {
    state.lastUsedAt = Date.now();
  };

  const isRunning = () => state.child !== null && state.pid !== undefined;

  /** Stop the process we started (never one we did not). */
  const stop = (reason = 'requested') => {
    if (state.child === null) return false;
    state.stopping = true;
    const child = state.child;
    log?.(`[rustxng] stopping the instance started by this plugin (${reason})`);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    state.child = null;
    state.pid = undefined;
    state.startedAt = undefined;
    state.stopping = false;
    return true;
  };

  /**
   * Start the binary if it is not already answering.
   *
   * Concurrent callers share one attempt: `sync()`, the probe loop and the first search can all
   * ask at the same moment, and two spawns race for the port (one then dies with EADDRINUSE).
   *
   * @param {{baseUrl: string, port: number, bindAddress?: string}} target Health target.
   * @returns {Promise<{started: boolean, reason?: string, pid?: number}>} Outcome.
   */
  let starting;
  const ensureStarted = (target) => {
    if (starting !== undefined) return starting;
    starting = startOnce(target).finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const startOnce = async (target) => {
    const cfg = autoStartConfig();
    if (cfg.enabled !== true) return { started: false, reason: 'auto-start is off' };
    if (isRunning()) return { started: false, reason: 'already managed', pid: state.pid };

    const healthy = await probeHealth(target.baseUrl).catch(() => false);
    if (healthy) {
      touch();
      return { started: false, reason: 'the instance already answers' };
    }

    let binary = resolveBinary({ explicit: cfg.binaryPath });
    if (binary === undefined && cfg.download === true) {
      // First run for most users: there is no binary anywhere, so fetch one rather than
      // failing with "start it yourself" (that is what the macOS report asked for).
      const installed = await installBinary({ dir: defaultDir(), log, ...installOptions });
      if (installed.ok === true && installed.path !== undefined) {
        binary = installed.path;
      } else {
        state.lastError = `could not download the binary: ${installed.reason}`;
        return { started: false, reason: state.lastError };
      }
    }
    if (binary === undefined) {
      state.lastError = 'no rustxng binary found (set autoStart.binaryPath, or allow the download)';
      return { started: false, reason: state.lastError };
    }

    const logFile = join(stateDir, 'rustxng-instance.log');
    let child;
    try {
      child = spawnServer({
        binary,
        port: target.port,
        bindAddress: target.bindAddress ?? '127.0.0.1',
        logFile,
      });
    } catch (error) {
      state.lastError = `spawn failed: ${String(error)}`;
      return { started: false, reason: state.lastError };
    }

    child.on('error', (error) => {
      state.lastError = `runtime error: ${String(error)}`;
      state.child = null;
      state.pid = undefined;
    });
    child.on('exit', (code, signal) => {
      log?.(`[rustxng] instance exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
      if (state.child === child) {
        state.child = null;
        state.pid = undefined;
        state.startedAt = undefined;
      }
    });

    state.child = child;
    state.pid = child.pid;
    state.startedAt = Date.now();
    state.lastError = undefined;
    touch();
    log?.(`[rustxng] started ${binary} on port ${target.port} (pid ${child.pid})`);

    // Wait for it to answer; a binary that dies immediately must not look healthy.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (state.pid === undefined) break;
      const ok = await probeHealth(target.baseUrl).catch(() => false);
      if (ok) {
        touch();
        return { started: true, pid: state.pid };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    state.lastError = 'the instance did not answer after starting';
    stop('did not become healthy');
    return { started: false, reason: state.lastError };
  };

  /** One watchdog tick: stop an owned process that has been idle too long. */
  const tick = () => {
    if (!isRunning()) return false;
    const cfg = autoStartConfig();
    if (shouldStopAfterIdle({ lastUsedAt: state.lastUsedAt, now: Date.now(), idleMinutes: cfg.idleMinutes })) {
      stop(`idle for ${cfg.idleMinutes} min`);
      return true;
    }
    return false;
  };

  /** Read-only snapshot for the status tool and the card hint. */
  const status = () => {
    const cfg = autoStartConfig();
    return {
      autoStart: cfg.enabled,
      binaryPath: cfg.binaryPath || '(auto)',
      idleMinutes: cfg.idleMinutes,
      managed: isRunning(),
      pid: state.pid,
      uptimeMs: state.startedAt === undefined ? undefined : Date.now() - state.startedAt,
      idleMs: state.lastUsedAt === 0 ? undefined : Date.now() - state.lastUsedAt,
      lastError: state.lastError,
    };
  };

  return { ensureStarted, stop, touch, tick, status, isRunning, config: autoStartConfig };
}
