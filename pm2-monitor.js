/**
 * PM2 Monitor
 *
 * Watches PM2 processes and sends Slack alerts for restarts, abnormal status
 * and high CPU or memory usage, plus a follow-up when each problem clears.
 * It can also serve the recent status history as JSON.
 *
 * Usage:
 *   node pm2-monitor.js              run on the configured schedule
 *   node pm2-monitor.js --once       run one check and exit
 *   node pm2-monitor.js --dry-run    log alerts instead of sending them to Slack
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { loadConfig, isLoopbackHost } from './src/config.js';
import { listPm2Processes } from './src/pm2.js';
import { createWindowsUsageReader } from './src/usage.js';
import { createNotifier } from './src/notifier.js';
import { createHistory } from './src/history.js';
import { createMonitorState } from './src/state.js';
import { createMonitor } from './src/monitor.js';
import { createStatusServer } from './src/server.js';
import { createHeartbeat } from './src/heartbeat.js';
import { readLogTail } from './src/logs.js';

// Load .env next to this script, so it works whatever the working directory is.
// Relative paths in settings (STATUS_LOG_FILE) are resolved the same way.
const projectDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(projectDir, '.env'), quiet: true });

async function main() {
  const { config, errors, warnings } = loadConfig(process.env, process.argv.slice(2));
  if (errors.length > 0) {
    console.error('Invalid configuration:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  for (const warning of warnings) console.warn(`[Warn] ${warning}`);
  printSummary(config);

  // A one-off run serves no status endpoint, and writing the shared history
  // or state file would race with a monitor already running under PM2.
  const history = config.web.enabled && !config.runOnce
    ? createHistory({ file: path.resolve(projectDir, config.web.historyFile), maxEntries: config.web.maxHistory, saveIntervalMs: config.web.saveIntervalMs })
    : null;
  await history?.load();
  const monitorState = !config.runOnce
    ? createMonitorState({ file: path.resolve(projectDir, config.state.file), saveIntervalMs: config.state.saveIntervalMs })
    : null;

  const usageReader = process.platform === 'win32' && config.windowsUsageFallback ? createWindowsUsageReader() : null;

  const monitor = createMonitor({
    config,
    listProcesses: () => listPm2Processes(config, { usageReader }),
    notifier: createNotifier({
      slack: config.slack,
      discord: config.discord,
      dryRun: config.dryRun,
      timezone: config.timezone,
    }),
    history,
    state: monitorState,
    // A one-off or dry run must not tell the heartbeat service that the scheduled monitor is alive.
    heartbeat: config.heartbeat.url && !config.dryRun && !config.runOnce
      ? createHeartbeat({ url: config.heartbeat.url, timeoutMs: config.heartbeat.timeoutMs })
      : null,
    readLog: readLogTail,
  });

  if (config.runOnce) {
    const result = await monitor.runCycle();
    await monitor.stop();
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const server = config.web.enabled ? startServer(config, history, monitor) : null;

  // With no state file this only records restart counts. A saved file continues
  // open alerts and reports restarts that happened while this process was down.
  await monitor.runCycle();
  const runScheduled = () => monitor.runCycle().catch((error) => console.error(`[Error] Check failed: ${error.stack || error.message}`));
  const task = cron.schedule(config.schedule, runScheduled, { timezone: config.timezone, name: 'pm2-monitor' });
  const next = task.getNextRun();
  console.log(`[Info] Next scheduled check: ${next ? next.toISOString() : 'none'}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Info] Received ${signal}. Shutting down.`);
    await task.stop();
    // Save first. monitor.stop() waits for restart watches, and a watch blocked
    // in `pm2 jlist` can outlast PM2's kill_timeout. History is not rewritten
    // on every check, so this is the copy that has to land. Stop also force-saves
    // monitor state before that wait, then again after the watches settle.
    await history?.flush({ force: true });
    await monitor.stop();
    // Idle keep-alive connections would otherwise hold close() open until PM2 kills the process.
    await new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
      server.closeAllConnections();
    });
    await history?.flush({ force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Windows cannot deliver SIGINT to a process; with `shutdown_with_message`
  // (ecosystem.config.cjs) PM2 sends this message instead.
  process.on('message', (message) => {
    if (message === 'shutdown') shutdown('shutdown message');
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function startServer(config, history, monitor) {
  const { host, port, token } = config.web;
  const server = createStatusServer({ host, port, token, history, getState: monitor.getState });

  server.on('error', (error) => {
    console.error(`[Error] Status server failed: ${error.message}`);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const shown = host.includes(':') ? `[${host}]` : host;
    console.log(`[Info] Status server: http://${shown}:${address.port}/ (dashboard, /status, /metrics)${token ? ' (token required)' : ''}`);
    if (!token && !isLoopbackHost(host)) {
      console.warn(`[Warn] HOST=${host} is not a loopback address, so /status answers 401 until STATUS_TOKEN is set.`);
    }
  });
  return server;
}

function printSummary(config) {
  console.log('Starting PM2 monitor.');
  console.log(`- Schedule: ${config.runOnce ? 'run once' : `${config.schedule} (${config.timezone})`}`);
  console.log(`- Slack: ${config.slack.webhookUrl ? (config.dryRun ? 'dry run (alerts are only logged)' : 'enabled') : 'off'}`);
  if (config.discord.webhookUrl) {
    console.log(`- Discord: ${config.dryRun ? 'dry run (alerts are only logged)' : 'enabled'}`);
  }
  const overrides = [...config.appThresholds.keys()];
  console.log(`- Thresholds: CPU > ${config.thresholds.cpu}%, Memory > ${config.thresholds.memoryMb}MB for ${config.resourceAlertSamples} check(s)${overrides.length > 0 ? `; per app: ${overrides.join(', ')}` : ''}`);
  console.log(`- Monitor state: ${config.runOnce ? 'not saved (one-off run)' : config.state.file}`);
  console.log(`- Alert reminders: ${config.alertRepeatMs > 0 ? `every ${Math.round(config.alertRepeatMs / 60000)} min while a problem lasts` : 'off'}`);
  console.log(`- Excluded apps: ${config.excludedApps.join(', ') || 'none'}`);
  console.log(`- Ignored statuses: ${config.ignoreStatuses.join(', ') || 'none'}`);
  console.log(`- Error log in restart alerts: ${config.restartLogLines > 0 ? `last ${config.restartLogLines} line(s)` : 'off'}`);
  const heartbeatOn = config.heartbeat.url && !config.dryRun && !config.runOnce;
  console.log(`- Heartbeat: ${heartbeatOn ? new URL(config.heartbeat.url).origin : `off${config.heartbeat.url ? ' (dry or one-off run)' : ''}`}`);
  console.log(`- PM2 binary: ${config.pm2Bin}`);
  if (process.platform === 'win32') {
    console.log(`- CPU/memory fallback: ${config.windowsUsageFallback ? 'on (read from Windows when PM2 reports 0)' : 'off'}`);
  }
}

main().catch((error) => {
  console.error(`[Fatal] ${error.stack || error.message}`);
  process.exit(1);
});
