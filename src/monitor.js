import { setTimeout as delay } from 'node:timers/promises';
import { AlertTracker } from './alerts.js';
import { formatTime } from './notifier.js';

const MONITOR_KEY = 'monitor::pm2';
// Slack cuts a section at 3000 characters; the log excerpt must leave room for the message.
const LOG_EXCERPT_MAX_CHARS = 1500;

/**
 * Creates the monitor. All side effects (PM2 access, notifications, history,
 * heartbeat, log reading, state persistence, time and sleeping) are injected
 * so the behavior can be tested without PM2 or Slack.
 */
export function createMonitor({
  config,
  listProcesses,
  notifier,
  history = null,
  heartbeat = null,
  readLog = null, // (file, lines) => Promise<string[]>, see src/logs.js
  state = null, // { load, save }, see src/state.js. Null skips persistence (one-off runs).
  logger = console,
  now = () => Date.now(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  const alerts = new AlertTracker({ repeatMs: config.alertRepeatMs });
  const restartBaseline = new Map(); // instance key -> restart count at the last check
  const breaches = new Map(); // condition key -> consecutive threshold breaches
  const watches = new Map(); // app name -> running restart watch
  const incidents = new Map(); // app name -> { notifiedAt, restarts }
  let knownApps = new Map(); // app name -> instance count at the last check
  const removedApps = new Map(); // app name -> instance count, while "App Removed" is undelivered
  const ignored = new Set(config.ignoreStatuses);
  // Healthy for watches and recoveries: online, or in a status the user chose to ignore.
  const isHealthy = (p) => p.status === 'online' || ignored.has(p.status);
  const controller = new AbortController();
  let running = false;
  let lastCycleAt = null;
  let stateRestored = false;

  const notify = ({ app, title, message, level }) => notifier.send({ app, title, message, level, now: new Date(now()) });

  function limitsFor(name) {
    const override = config.appThresholds.get(name);
    if (!override) return config.thresholds;
    return {
      cpu: override.cpu ?? config.thresholds.cpu,
      memoryMb: override.memoryMb ?? config.thresholds.memoryMb,
    };
  }

  function snapshot() {
    return {
      version: 1,
      lastCycleAt,
      restartBaseline: Object.fromEntries(restartBaseline),
      breaches: Object.fromEntries(breaches),
      alerts: alerts.exportState(),
      incidents: Object.fromEntries(incidents),
      knownApps: Object.fromEntries(knownApps),
      removedApps: Object.fromEntries(removedApps),
    };
  }

  // A failed save must not fail the check. The store already logs IO errors.
  async function saveState({ force = false } = {}) {
    if (!state) return;
    try {
      await state.save(snapshot(), { force });
    } catch (error) {
      logger.error(`[Error] Failed to save monitor state: ${error.message}`);
    }
  }

  // Once per process. A missing or unreadable file leaves the fresh baseline,
  // which is the same as a monitor that has never run.
  async function restoreState() {
    if (stateRestored) return;
    stateRestored = true;
    if (!state) return;
    try {
      const saved = await state.load();
      if (!saved || saved.version !== 1) return;
      applySavedState(saved);
    } catch (error) {
      logger.error(`[Error] Failed to restore monitor state: ${error.message}`);
    }
  }

  function applySavedState(saved) {
    alerts.importState(saved.alerts);
    for (const [key, count] of numberRecord(saved.restartBaseline)) restartBaseline.set(key, count);
    for (const [key, count] of numberRecord(saved.breaches)) {
      if (count > 0) breaches.set(key, count);
    }
    if (saved.incidents && typeof saved.incidents === 'object' && !Array.isArray(saved.incidents)) {
      for (const [app, raw] of Object.entries(saved.incidents)) {
        const incident = normalizeIncident(raw);
        if (app && incident) incidents.set(app, incident);
      }
    }
    knownApps = numberRecord(saved.knownApps);
    for (const [app, count] of numberRecord(saved.removedApps)) {
      if (count > 0) removedApps.set(app, count);
    }
    const cycleAt = finiteNumber(saved.lastCycleAt);
    if (cycleAt !== null) lastCycleAt = cycleAt;
    logger.log(`[Info] Restored monitor state: ${alerts.exportState().length} open alert(s), ${incidents.size} incident(s).`);
  }

  /** Evaluates one alert condition and sends the matching notification. */
  async function handleCondition(key, isActive, signature, render) {
    const since = alerts.since(key);
    const action = alerts.evaluate(key, isActive, now(), signature);
    if (!action) return;

    const sent = await notify(render(action, alerts.since(key) ?? since));
    if (!sent) return;
    if (action === 'resolve') alerts.markResolved(key);
    else alerts.markSent(key, now());
  }

  // Cycles in progress, so stop() can let a check finish its sends and history.
  const cycles = new Set();
  let stopped = false;

  function runCycle() {
    if (stopped) return Promise.resolve({ ok: false, skipped: true });
    const cycle = runOneCycle();
    cycles.add(cycle);
    cycle.finally(() => cycles.delete(cycle)).catch(() => {});
    return cycle;
  }

  async function runOneCycle() {
    if (running) {
      logger.warn('[Monitor] The previous check is still running. Skipping this run.');
      return { ok: false, skipped: true };
    }

    running = true;
    const startedAt = now();
    try {
      await restoreState();
      let processes;
      try {
        processes = await listProcesses();
      } catch (error) {
        logger.error(`[Error] ${error.message}`);
        await handleCondition(MONITOR_KEY, true, '', (action, since) => ({
          app: 'pm2-monitor',
          title: action === 'repeat' ? 'Monitoring Still Failing' : 'Monitoring Failed',
          message: `Could not read the PM2 process list${action === 'repeat' ? ` (failing for ${formatDuration(now() - since)})` : ''}.\n${error.message}`,
          level: 'danger',
        }));
        await saveState();
        return { ok: false, error };
      }

      await handleCondition(MONITOR_KEY, false, '', (_action, since) => ({
        app: 'pm2-monitor',
        title: 'Monitoring Recovered',
        message: `The PM2 process list can be read again after ${formatDuration(now() - since)}.`,
        level: 'good',
      }));

      const restartedApps = await detectRestarts(processes, startedAt);
      await closeRecoveredIncidents(processes, restartedApps);
      await checkInstances(processes);
      await detectRemovedApps(processes);

      if (history) {
        history.add({ timestamp: new Date(startedAt).toISOString(), processes });
        await history.flush();
      }
      lastCycleAt = startedAt;
      // Before the heartbeat, so a crash while pinging still keeps this check.
      await saveState();
      await heartbeat?.ping();
      return { ok: true, processes };
    } finally {
      running = false;
    }
  }

  async function detectRestarts(processes, startedAt) {
    const restarted = new Map();
    const live = new Set();

    for (const proc of processes) {
      const key = instanceKey(proc);
      live.add(key);
      const previous = restartBaseline.get(key);
      restartBaseline.set(key, proc.restarts);

      // New instances only set a baseline; a lower count means PM2 was reset.
      if (previous === undefined || proc.restarts <= previous) continue;

      const entry = restarted.get(proc.name) ?? { count: 0, ids: [], procs: [] };
      entry.count += proc.restarts - previous;
      entry.ids.push(proc.pm_id);
      entry.procs.push(proc);
      restarted.set(proc.name, entry);
    }

    for (const key of restartBaseline.keys()) {
      if (!live.has(key)) restartBaseline.delete(key);
    }

    for (const [app, restart] of restarted) {
      const reference = new Map(processes.filter((p) => p.name === app).map((p) => [p.pm_id, p.restarts]));
      await handleRestart(app, restart, reference, startedAt);
    }

    return new Set(restarted.keys());
  }

  async function handleRestart(app, { count, ids, procs }, reference, detectedAt) {
    const incident = incidents.get(app) ?? newIncident();
    incidents.set(app, incident);
    incident.restarts += count;

    // A restart after the app was reported stable means it is crash-looping
    // slower than the watch can see. Say so once, then treat it as one incident.
    if (incident.stableSince !== null) {
      if (incident.recoveryAnnounced) {
        incident.relapseAfter = detectedAt - incident.stableSince;
        incident.recoveryAnnounced = false;
        incident.flapping = true;
      }
      incident.stableSince = null;
    }
    const relapse = incident.relapseAfter !== null;

    // While an incident is open, repeat the alert only after the reminder interval.
    const reminderDue = config.alertRepeatMs > 0 && detectedAt - incident.notifiedAt >= config.alertRepeatMs;
    const quiet = incident.notifiedAt !== null && !reminderDue && !relapse;

    if (quiet) {
      logger.log(`[Restart] '${app}' restarted ${count} more time(s). An alert for this incident was already sent.`);
    } else {
      const since = lastCycleAt ? ` since the last check at ${formatTime(new Date(lastCycleAt), config.timezone)}` : '';
      const total = incident.restarts > count ? `\n${incident.restarts} restart(s) since this incident started.` : '';
      const reminder = config.alertRepeatMs > 0 ? `, with a reminder every ${formatDuration(config.alertRepeatMs)}` : '';
      const message = relapse
        ? `'${app}' restarted again ${formatDuration(incident.relapseAfter)} after it was reported stable: ${count} restart(s) (instance ${ids.join(', ')})${since}.${total}\nFurther restarts are only logged${reminder}, until it stays up for ${formatDuration(config.incidentStableMs)}.`
        : `Detected ${count} restart(s) of '${app}' (instance ${ids.join(', ')})${since}.${total}\nWatching for up to ${watchSeconds()} seconds.`;
      const sent = await notify({ app, title: 'Process Restart Detected', message: message + await logExcerpt(procs), level: 'warning' });
      if (sent) {
        incident.notifiedAt = detectedAt;
        incident.relapseAfter = null;
      }
    }

    if (watches.has(app)) {
      logger.log(`[Restart] A restart watch for '${app}' is already running.`);
      return;
    }

    const watch = watchRestart(app, reference)
      .catch((error) => logger.error(`[Error] Restart watch for '${app}' failed: ${error.message}`))
      .finally(async () => {
        watches.delete(app);
        // The watch updates the incident after the cycle that started it has
        // already saved. Persist that outcome too.
        await saveState();
      });
    watches.set(app, watch);
  }

  /**
   * Polls one app after a restart. It counts as recovered when every instance is
   * online and none restarted again during the last interval; it fails when the
   * time limit is reached or an instance enters the terminal `errored` state.
   */
  async function watchRestart(app, reference) {
    const { intervalMs, maxAttempts } = config.recheck;
    let instances = [];
    let extraRestarts = 0;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await sleep(intervalMs, controller.signal);
      } catch {
        return; // The monitor is shutting down.
      }

      try {
        instances = (await listProcesses()).filter((p) => p.name === app);
        lastError = null;
      } catch (error) {
        lastError = error;
        logger.warn(`[Restart] Check ${attempt}/${maxAttempts} for '${app}' failed: ${error.message}`);
        continue;
      }

      let newRestarts = 0;
      for (const p of instances) {
        newRestarts += Math.max(0, p.restarts - (reference.get(p.pm_id) ?? p.restarts));
        reference.set(p.pm_id, p.restarts);
      }
      extraRestarts += newRestarts;

      const allHealthy = instances.length > 0 && instances.every(isHealthy);
      logger.log(`[Restart] Check ${attempt}/${maxAttempts} for '${app}': ${describeInstances(instances)}`);

      if (allHealthy && newRestarts === 0) {
        if (online(instances).length > 0) {
          await handleRecovered(app, instances);
        } else {
          // Every instance is in an ignored status, e.g. stopped on purpose after the restart.
          logger.log(`[Restart] '${app}' is ${describeStatuses(instances)} (IGNORE_STATUSES). Ending the watch.`);
          incidents.delete(app);
        }
        return;
      }
      if (instances.some((p) => p.status === 'errored')) break;
    }

    const details = [];
    if (instances.length === 0) details.push('The app is no longer in the PM2 process list.');
    else details.push(`Current status:\n- ${instances.map((p) => `ID ${p.pm_id}: ${p.status}`).join('\n- ')}`);
    if (extraRestarts > 0) details.push(`It restarted ${extraRestarts} more time(s) while being watched.`);
    if (lastError) details.push(`Last error: ${lastError.message}`);

    logger.error(`[Restart] '${app}' did not become stable.`);
    const incident = incidents.get(app);
    if (incident && incident.notifiedAt !== null && incident.failureNotifiedAt === incident.notifiedAt) return;

    const failing = instances.filter((p) => !isHealthy(p));
    const sent = await notify({
      app,
      title: 'Restart Failed',
      message: `'${app}' did not become stable after the restart.\n${details.join('\n')}${await logExcerpt(failing.length > 0 ? failing : instances)}`,
      level: 'danger',
    });
    // Only a delivered failure suppresses later ones, so a failed send is retried.
    if (sent && incident) {
      incident.failureNotifiedAt = incident.notifiedAt;
      incident.failureSent = true;
    }
    // "Restart Failed" already lists each instance's status. Record it as the
    // status alert, so the next check does not send "Process Status Alert" for
    // the same state; reminders and a later status change still go out.
    if (sent) {
      for (const p of failing) alerts.adopt(`${instanceKey(p)}::status`, p.status, now());
      // "Restart Failed" already said the app left the process list; no "App Removed" follows.
      if (instances.length === 0) knownApps.delete(app);
    }
  }

  /**
   * Called when an app with an open incident looks healthy: by its watch, or by
   * a later check. The first time, the recovery is reported. The incident stays
   * open until the app has stayed up for `incidentStableMs`, so a restart soon
   * after is reported as a relapse instead of a new incident. An app that
   * relapsed is reported as recovered only once that period has passed.
   */
  async function handleRecovered(app, instances, title = 'Restart Successful') {
    const incident = incidents.get(app);
    if (!incident) return;
    if (incident.stableSince === null) {
      incident.stableSince = now();
      logger.log(`[Restart] '${app}' is stable again.`);
    }
    // Follow up whenever the channel heard about this incident, even if only the failure got through.
    if (incident.notifiedAt === null && !incident.failureSent) {
      incidents.delete(app);
      return;
    }

    const stableFor = now() - incident.stableSince;
    const settled = stableFor >= config.incidentStableMs;
    if (incident.flapping) {
      if (!settled) return;
      const sent = await notify({
        app,
        title: 'App Recovered',
        message: `'${app}' has stayed up for ${formatDuration(stableFor)} after ${incident.restarts} restart(s): ${describeOnline(instances)}.\n(${usageSummary(online(instances))})`,
        level: 'good',
      });
      if (sent) closeIncident(app, instances);
      return;
    }

    if (!incident.recoveryAnnounced) {
      const sent = await notify({
        app,
        title,
        message: `'${app}' is stable: ${describeOnline(instances)}.\n(${usageSummary(online(instances))})`,
        level: 'good',
      });
      // An undelivered recovery keeps the incident open; closeRecoveredIncidents retries it.
      if (!sent) return;
      incident.recoveryAnnounced = true;
      resolveStatusAlerts(instances);
    }
    if (settled) closeIncident(app, instances);
  }

  function closeIncident(app, instances) {
    incidents.delete(app);
    resolveStatusAlerts(instances);
  }

  // A recovery message already says every instance is online, so a separate
  // "Process Back Online" for the same instances would only repeat it.
  function resolveStatusAlerts(instances) {
    for (const p of instances) alerts.markResolved(`${instanceKey(p)}::status`);
  }

  /** Closes incidents whose watch failed but whose app has since become healthy. */
  async function closeRecoveredIncidents(processes, restartedApps) {
    for (const app of [...incidents.keys()]) {
      if (restartedApps.has(app) || watches.has(app)) continue;
      const instances = processes.filter((p) => p.name === app);
      if (!instances.every(isHealthy)) continue;
      // Gone, or only in ignored statuses: nothing is left to recover.
      if (online(instances).length === 0) incidents.delete(app);
      else await handleRecovered(app, instances, 'App Recovered');
    }
  }

  /**
   * Reports an app that was in the last check but is gone now: deleted, or PM2
   * came back with another process list. Instances that disappear while others
   * of the app remain (scaling down) are not reported. An app under a restart
   * watch is left to the watch, which reports it in "Restart Failed".
   */
  async function detectRemovedApps(processes) {
    const current = new Map();
    for (const p of processes) current.set(p.name, (current.get(p.name) ?? 0) + 1);

    const next = new Map(current);
    for (const [app, count] of knownApps) {
      if (current.has(app)) continue;
      if (watches.has(app)) next.set(app, count);
      else removedApps.set(app, count);
    }
    knownApps = next;
    for (const app of current.keys()) removedApps.delete(app);

    for (const [app, count] of [...removedApps]) {
      const sent = await notify({
        app,
        title: 'App Removed',
        message: `'${app}' (${count} instance(s)) is no longer in the PM2 process list. It was deleted, or PM2 restarted without it (for example \`pm2 kill\` without \`pm2 resurrect\`). Its open alerts are closed.`,
        level: 'warning',
      });
      // Kept until delivered, unless the app comes back first.
      if (sent) removedApps.delete(app);
    }
  }

  /** The end of an instance's error log as a code block for an alert; '' when off or unreadable. */
  async function logExcerpt(instances) {
    if (!readLog || config.restartLogLines === 0) return '';
    const proc = instances.find((p) => p.errLogPath);
    if (!proc) return '';

    let lines;
    try {
      lines = await readLog(proc.errLogPath, config.restartLogLines);
    } catch (error) {
      logger.warn(`[Warn] Could not read the error log of '${proc.name}' (${proc.errLogPath}): ${error.message}`);
      return '';
    }
    // Triple backticks inside the log would end the code block early.
    lines = lines.map((line) => line.replace(/```/g, "'''"));
    while (lines.length > 0 && lines.join('\n').length > LOG_EXCERPT_MAX_CHARS) lines = lines.slice(1);
    if (lines.length === 0) return '';
    return `\nLast ${lines.length} line(s) of the error log of instance ${proc.pm_id}:\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
  }

  async function checkInstances(processes) {
    const live = new Set();

    for (const proc of processes) {
      const key = instanceKey(proc);
      live.add(key);
      // Apps under a restart watch are reported by the watch instead.
      if (watches.has(proc.name)) continue;

      const { name, pm_id: id, status, cpu, memory } = proc;
      logger.log(`[Check] ${name}(${id}): ${status}, CPU ${formatUsage(cpu, '%')}, Memory ${formatUsage(memory, 'MB')}`);

      const isOnline = status === 'online';
      await handleCondition(`${key}::status`, !isHealthy(proc), status, (action, since) => {
        if (action === 'resolve' && isOnline) {
          return { app: name, title: 'Process Back Online', message: `Instance \`${id}\` is online again after ${formatDuration(now() - since)}.`, level: 'good' };
        }
        if (action === 'resolve') {
          return { app: name, title: 'Process Status Cleared', message: `Instance \`${id}\` is now \`${status}\`, which IGNORE_STATUSES excludes from alerts.`, level: 'good' };
        }
        return { app: name, title: action === 'repeat' ? 'Process Still Down' : 'Process Status Alert', message: `Instance \`${id}\` has status \`${status}\`${ongoing(action, since)}.`, level: 'danger' };
      });

      if (!isOnline) continue;
      // Null means this check could not read usage. Leave the alert and the
      // consecutive-sample count alone; 0 would look like the process went idle.
      const limits = limitsFor(name);
      if (cpu !== null) {
        await checkResource(proc, `${key}::cpu`, cpu > limits.cpu, {
          label: 'CPU', value: `${cpu}%`, threshold: `${limits.cpu}%`,
        });
      }
      if (memory !== null) {
        await checkResource(proc, `${key}::memory`, memory > limits.memoryMb, {
          label: 'Memory', value: `${memory}MB`, threshold: `${limits.memoryMb}MB`,
        });
      }
    }

    const isLive = (conditionKey) => {
      if (conditionKey === MONITOR_KEY) return true;
      return live.has(conditionKey.slice(0, conditionKey.lastIndexOf('::')));
    };
    alerts.prune(isLive);
    for (const key of breaches.keys()) {
      if (!isLive(key)) breaches.delete(key);
    }
  }

  async function checkResource(proc, key, breaching, { label, value, threshold }) {
    const count = breaching ? (breaches.get(key) ?? 0) + 1 : 0;
    if (count > 0) breaches.set(key, count);
    else breaches.delete(key);

    const samples = config.resourceAlertSamples;
    await handleCondition(key, count >= samples, '', (action, since) => (action === 'resolve'
      ? { app: proc.name, title: `${label} Usage Back to Normal`, message: `Instance \`${proc.pm_id}\` ${label} usage is \`${value}\` (threshold ${threshold}).`, level: 'good' }
      : {
        app: proc.name,
        title: `High ${label} Usage`,
        message: `Instance \`${proc.pm_id}\` ${label} usage is \`${value}\` (threshold ${threshold})${samples > 1 ? ` for ${samples} consecutive checks` : ''}${ongoing(action, since)}.`,
        level: 'warning',
      }));
  }

  function ongoing(action, since) {
    return action === 'repeat' ? `, ongoing for ${formatDuration(now() - since)}` : '';
  }

  function watchSeconds() {
    return Math.ceil((config.recheck.intervalMs * config.recheck.maxAttempts) / 1000);
  }

  return {
    runCycle,
    getState: () => ({
      lastCycleAt: lastCycleAt === null ? null : new Date(lastCycleAt).toISOString(),
      running,
      watchingRestarts: [...watches.keys()],
    }),
    /** Waits for running restart watches to settle; used by tests. */
    idle: () => Promise.allSettled([...watches.values()]),
    /**
     * Lets a running check finish, then ends restart watches. Later checks are
     * skipped. State is saved before the wait: a watch blocked in `pm2 jlist`
     * can outlast PM2's kill_timeout, and the file is what the next process reads.
     */
    async stop() {
      stopped = true;
      await saveState({ force: true });
      controller.abort();
      await Promise.allSettled([...cycles]);
      await Promise.allSettled([...watches.values()]);
      await saveState({ force: true });
    },
  };
}

function newIncident() {
  return {
    notifiedAt: null, // when the last "Process Restart Detected" was delivered
    restarts: 0,
    failureNotifiedAt: null, // notifiedAt of the incident when "Restart Failed" was delivered
    failureSent: false,
    stableSince: null, // when the app was first seen healthy since its last restart
    recoveryAnnounced: false,
    flapping: false, // restarted again after it had been reported stable
    relapseAfter: null, // set while that relapse has not been delivered
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberRecord(value) {
  const map = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return map;
  for (const [key, item] of Object.entries(value)) {
    const number = finiteNumber(item);
    if (key && number !== null) map.set(key, number);
  }
  return map;
}

/** Drops a hand-edited incident that is not the shape the watch expects. */
function normalizeIncident(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    notifiedAt: finiteNumber(value.notifiedAt),
    restarts: finiteNumber(value.restarts) ?? 0,
    failureNotifiedAt: finiteNumber(value.failureNotifiedAt),
    failureSent: value.failureSent === true,
    stableSince: finiteNumber(value.stableSince),
    recoveryAnnounced: value.recoveryAnnounced === true,
    flapping: value.flapping === true,
    relapseAfter: finiteNumber(value.relapseAfter),
  };
}

function formatUsage(value, unit) {
  return value === null ? 'unknown' : `${value}${unit}`;
}

function instanceKey(proc) {
  return `${proc.name}#${proc.pm_id}`;
}

function online(instances) {
  return instances.filter((p) => p.status === 'online');
}

function describeStatuses(instances) {
  return [...new Set(instances.map((p) => p.status))].join(', ');
}

function describeOnline(instances) {
  const up = online(instances).length;
  if (up === instances.length) return `all ${instances.length} instance(s) are online`;
  const others = instances.filter((p) => p.status !== 'online');
  return `${up} of ${instances.length} instance(s) are online, the others are ${describeStatuses(others)} (ignored)`;
}

function describeInstances(instances) {
  if (instances.length === 0) return 'not found';
  return instances.map((p) => `${p.pm_id}=${p.status}(restarts ${p.restarts})`).join(', ');
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

// Unknown (null) samples are left out instead of counted as 0, and their number
// is shown, so a partly unreadable app does not look idle or small.
function usageSummary(instances) {
  const part = (label, values, total, unit) => {
    const known = values.filter((value) => value !== null);
    if (known.length === 0) return `${label}: unknown`;
    const missing = values.length - known.length;
    return `${label}: ${total(known)}${unit}${missing ? ` (${missing} unknown)` : ''}`;
  };
  return [
    part('CPU avg', instances.map((p) => p.cpu), average, '%'),
    part('Memory total', instances.map((p) => p.memory), sum, 'MB'),
  ].join(', ');
}

function sum(values) {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(2));
}

function average(values) {
  return values.length === 0 ? 0 : Number((sum(values) / values.length).toFixed(2));
}
