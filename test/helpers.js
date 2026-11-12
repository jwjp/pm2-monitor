import { loadConfig } from '../src/config.js';
import { createMonitor } from '../src/monitor.js';

export const silentLogger = { log() {}, warn() {}, error() {} };

export function proc(name, pmId, overrides = {}) {
  return { pm_id: pmId, name, pid: 1000 + pmId, status: 'online', restarts: 0, cpu: 1, memory: 50, uptimeStartedAt: null, ...overrides };
}

/**
 * In-memory stand-in for src/state.js. Snapshots are cloned the way the file
 * store clones them (JSON), so later mutations do not change what was saved.
 */
export function memoryState(initial = null) {
  const box = { saved: initial, saves: 0 };
  return {
    box,
    async load() {
      return box.saved;
    },
    async save(snapshot) {
      box.saved = JSON.parse(JSON.stringify(snapshot));
      box.saves += 1;
    },
  };
}

/** Builds a monitor wired to an in-memory PM2 state, clock and notifier. */
export function setup({ env = {}, processes = [], deliver = true, monitorState = null } = {}) {
  const { config, errors } = loadConfig({ DRY_RUN: 'true', ...env });
  if (errors.length) throw new Error(errors.join('\n'));

  // `logs` maps an error log path to its lines; `pings` counts heartbeats.
  const state = { processes, fail: null, deliver, clock: Date.UTC(2026, 0, 5, 14, 0, 0), logs: {}, pings: 0 };
  const sent = [];
  // Records every attempted alert; `state.deliver` decides whether delivery succeeds.
  const notifier = {
    async send(alert) {
      sent.push(alert);
      return state.deliver;
    },
  };

  const monitor = createMonitor({
    config,
    logger: silentLogger,
    notifier,
    heartbeat: {
      async ping() {
        state.pings += 1;
        return true;
      },
    },
    async readLog(file, lines) {
      if (!state.logs[file]) throw new Error(`ENOENT: no such file '${file}'`);
      return state.logs[file].slice(-lines);
    },
    state: monitorState,
    now: () => state.clock,
    sleep: async (ms) => {
      state.clock += ms;
      await state.beforePoll?.();
    },
    listProcesses: async () => {
      if (state.fail) throw state.fail;
      return state.processes.map((p) => ({ ...p }));
    },
  });

  return {
    monitor,
    config,
    state,
    sent,
    titles: () => sent.map((alert) => alert.title),
    advance(ms) {
      state.clock += ms;
    },
  };
}
