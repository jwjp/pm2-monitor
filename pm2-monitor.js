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

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { loadConfig, isLoopbackHost } from './src/config.js';
import { listPm2Processes } from './src/pm2.js';
import { createNotifier } from './src/notifier.js';
import { createHistory } from './src/history.js';
import { createMonitor } from './src/monitor.js';
import { createStatusServer } from './src/server.js';

// Load .env next to this script, so it works whatever the working directory is.
dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)), quiet: true });

async function main() {
  const { config, errors } = loadConfig(process.env, process.argv.slice(2));
  if (errors.length > 0) {
    console.error('Invalid configuration:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  printSummary(config);

  const history = config.web.enabled
    ? createHistory({ file: config.web.historyFile, maxEntries: config.web.maxHistory })
    : null;
  await history?.load();

  const monitor = createMonitor({
    config,
    listProcesses: () => listPm2Processes(config),
    notifier: createNotifier({
      webhookUrl: config.slack.webhookUrl,
      timeoutMs: config.slack.timeoutMs,
      dryRun: config.dryRun,
      timezone: config.timezone,
    }),
    history,
  });

  if (config.runOnce) {
    const result = await monitor.runCycle();
    await monitor.stop();
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const server = config.web.enabled ? startServer(config, history, monitor) : null;

  // The first check only records restart counts as a baseline and reports current problems.
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
    await monitor.stop();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function startServer(config, history, monitor) {
  const { host, port, token } = config.web;
  const server = createStatusServer({ host, token, history, getState: monitor.getState });

  server.on('error', (error) => {
    console.error(`[Error] Status server failed: ${error.message}`);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const shown = host.includes(':') ? `[${host}]` : host;
    console.log(`[Info] Status server: http://${shown}:${address.port}/status${token ? ' (token required)' : ''}`);
    if (!token && !isLoopbackHost(host)) {
      console.warn(`[Warn] HOST=${host} is not a loopback address, so /status answers 401 until STATUS_TOKEN is set.`);
    }
  });
  return server;
}

function printSummary(config) {
  console.log('Starting PM2 monitor.');
  console.log(`- Schedule: ${config.runOnce ? 'run once' : `${config.schedule} (${config.timezone})`}`);
  console.log(`- Slack: ${config.dryRun ? 'dry run (alerts are only logged)' : 'enabled'}`);
  console.log(`- Thresholds: CPU > ${config.thresholds.cpu}%, Memory > ${config.thresholds.memoryMb}MB for ${config.resourceAlertSamples} check(s)`);
  console.log(`- Alert reminders: ${config.alertRepeatMs > 0 ? `every ${Math.round(config.alertRepeatMs / 60000)} min while a problem lasts` : 'off'}`);
  console.log(`- Excluded apps: ${config.excludedApps.join(', ') || 'none'}`);
  console.log(`- PM2 binary: ${config.pm2Bin}`);
}

main().catch((error) => {
  console.error(`[Fatal] ${error.stack || error.message}`);
  process.exit(1);
});
