import { setTimeout as delay } from 'node:timers/promises';
import { AlertTracker } from './alerts.js';
import { formatTime } from './notifier.js';

const MONITOR_KEY = 'monitor::pm2';

/**
 * Creates the monitor. All side effects (PM2 access, notifications, history,
 * time and sleeping) are injected so the behavior can be tested without PM2 or
 * Slack.
 */
export function createMonitor({
  config,
  listProcesses,
  notifier,
  history = null,
  logger = console,
  now = () => Date.now(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  const alerts = new AlertTracker({ repeatMs: config.alertRepeatMs });
  const restartBaseline = new Map(); // instance key -> restart count at the last check
  const breaches = new Map(); // condition key -> consecutive threshold breaches
  const watches = new Map(); // app name -> running restart watch
  const incidents = new Map(); // app name -> { notifiedAt, restarts }
  const controller = new AbortController();
  let running = false;
  let lastCycleAt = null;

  const notify = ({ app, title, message, level }) => notifier.send({ app, title, message, level, now: new Date(now()) });

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

  async function runCycle() {
    if (running) {
      logger.warn('[Monitor] The previous check is still running. Skipping this run.');
      return { ok: false, skipped: true };
    }

    running = true;
    const startedAt = now();
    try {
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

      if (history) {
        history.add({ timestamp: new Date(startedAt).toISOString(), processes });
        await history.flush();
      }
      lastCycleAt = startedAt;
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

      const entry = restarted.get(proc.name) ?? { count: 0, ids: [] };
      entry.count += proc.restarts - previous;
      entry.ids.push(proc.pm_id);
      restarted.set(proc.name, entry);
    }

    for (const key of restartBaseline.keys()) {
      if (!live.has(key)) restartBaseline.delete(key);
    }

    for (const [app, { count, ids }] of restarted) {
      const reference = new Map(processes.filter((p) => p.name === app).map((p) => [p.pm_id, p.restarts]));
      await handleRestart(app, count, ids, reference, startedAt);
    }

    return new Set(restarted.keys());
  }

  async function handleRestart(app, count, ids, reference, detectedAt) {
    const incident = incidents.get(app) ?? { notifiedAt: null, restarts: 0 };
    incidents.set(app, incident);
    incident.restarts += count;

    // While an incident is open, repeat the alert only after the reminder interval.
    const reminderDue = config.alertRepeatMs > 0 && detectedAt - incident.notifiedAt >= config.alertRepeatMs;
    const quiet = incident.notifiedAt !== null && !reminderDue;

    if (quiet) {
      logger.log(`[Restart] '${app}' restarted ${count} more time(s). An alert for this incident was already sent.`);
    } else {
      const since = lastCycleAt ? ` since the last check at ${formatTime(new Date(lastCycleAt), config.timezone)}` : '';
      const total = incident.restarts > count ? `\n${incident.restarts} restart(s) since this incident started.` : '';
      const sent = await notify({
        app,
        title: 'Process Restart Detected',
        message: `Detected ${count} restart(s) of '${app}' (instance ${ids.join(', ')})${since}.${total}\nWatching for up to ${watchSeconds()} seconds.`,
        level: 'warning',
      });
      if (sent) incident.notifiedAt = detectedAt;
    }

    if (watches.has(app)) {
      logger.log(`[Restart] A restart watch for '${app}' is already running.`);
      return;
    }

    const watch = watchRestart(app, reference)
      .catch((error) => logger.error(`[Error] Restart watch for '${app}' failed: ${error.message}`))
      .finally(() => watches.delete(app));
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

      const allOnline = instances.length > 0 && instances.every((p) => p.status === 'online');
      logger.log(`[Restart] Check ${attempt}/${maxAttempts} for '${app}': ${describeInstances(instances)}`);

      if (allOnline && newRestarts === 0) {
        await handleRecovered(app, instances);
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

    const sent = await notify({
      app,
      title: 'Restart Failed',
      message: `'${app}' did not become stable after the restart.\n${details.join('\n')}`,
      level: 'danger',
    });
    // Only a delivered failure suppresses later ones, so a failed send is retried.
    if (sent && incident) {
      incident.failureNotifiedAt = incident.notifiedAt;
      incident.failureSent = true;
    }
  }

  async function handleRecovered(app, instances, title = 'Restart Successful') {
    const incident = incidents.get(app);
    logger.log(`[Restart] '${app}' is stable again.`);
    // Follow up whenever the channel heard about this incident, even if only the failure got through.
    if (!incident || (incident.notifiedAt === null && !incident.failureSent)) {
      incidents.delete(app);
      return;
    }

    const sent = await notify({
      app,
      title,
      message: `'${app}' is stable: all ${instances.length} instance(s) are online.\n(${usageSummary(instances)})`,
      level: 'good',
    });
    // An undelivered recovery keeps the incident open; closeRecoveredIncidents retries it.
    if (!sent) return;
    incidents.delete(app);
    // This message already says every instance is online, so a separate
    // "Process Back Online" for the same instances would only repeat it.
    for (const p of instances) alerts.markResolved(`${instanceKey(p)}::status`);
  }

  /** Closes incidents whose watch failed but whose app has since become healthy. */
  async function closeRecoveredIncidents(processes, restartedApps) {
    for (const app of [...incidents.keys()]) {
      if (restartedApps.has(app) || watches.has(app)) continue;
      const instances = processes.filter((p) => p.name === app);
      if (instances.length === 0) {
        incidents.delete(app);
      } else if (instances.every((p) => p.status === 'online')) {
        await handleRecovered(app, instances, 'App Recovered');
      }
    }
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

      const online = status === 'online';
      await handleCondition(`${key}::status`, !online, status, (action, since) => (action === 'resolve'
        ? { app: name, title: 'Process Back Online', message: `Instance \`${id}\` is online again after ${formatDuration(now() - since)}.`, level: 'good' }
        : { app: name, title: action === 'repeat' ? 'Process Still Down' : 'Process Status Alert', message: `Instance \`${id}\` has status \`${status}\`${ongoing(action, since)}.`, level: 'danger' }));

      if (!online) continue;
      // Null means this check could not read usage. Leave the alert and the
      // consecutive-sample count alone; 0 would look like the process went idle.
      if (cpu !== null) {
        await checkResource(proc, `${key}::cpu`, cpu > config.thresholds.cpu, {
          label: 'CPU', value: `${cpu}%`, threshold: `${config.thresholds.cpu}%`,
        });
      }
      if (memory !== null) {
        await checkResource(proc, `${key}::memory`, memory > config.thresholds.memoryMb, {
          label: 'Memory', value: `${memory}MB`, threshold: `${config.thresholds.memoryMb}MB`,
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
    async stop() {
      controller.abort();
      await Promise.allSettled([...watches.values()]);
    },
  };
}

function formatUsage(value, unit) {
  return value === null ? 'unknown' : `${value}${unit}`;
}

function instanceKey(proc) {
  return `${proc.name}#${proc.pm_id}`;
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
