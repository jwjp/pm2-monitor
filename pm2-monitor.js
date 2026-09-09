/**
 * PM2 Monitor Script
 *
 * Monitors PM2 processes and sends Slack notifications for restarts, abnormal
 * status, and high resource usage. It can also expose a local JSON status
 * endpoint for lightweight health dashboards.
 */

import { execFile as callbackExecFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import axios from 'axios';
import http from 'http';
import fs from 'fs/promises';

const execFile = promisify(callbackExecFile);

const DEFAULTS = {
  PM2_BIN: process.platform === 'win32' ? 'pm2.cmd' : 'pm2',
  CRON_SCHEDULE: '*/1 8-19 * * 1-5',
  CRON_TIMEZONE: 'America/New_York',
  EXCLUDED_APPS: ['pm2-monitor', 'pm2-logrotate'],
  CPU_THRESHOLD: 80,
  MEMORY_THRESHOLD_MB: 450,
  THROTTLE_DURATION_MS: 30 * 1000,
  RECHECK_INTERVAL_MS: 5 * 1000,
  RECHECK_MAX_ATTEMPTS: 12,
  WEB_ENABLED: true,
  WEB_HOST: '127.0.0.1',
  WEB_PORT: 3031,
  STATUS_LOG_FILE: './status-history.json',
  MAX_HISTORY: 1440,
  SLACK_TIMEOUT_MS: 10 * 1000,
  RUN_ONCE: false,
};

const CONFIG = {
  PM2_BIN: envString('PM2_BIN', DEFAULTS.PM2_BIN),
  CRON_SCHEDULE: envString('CRON_SCHEDULE', DEFAULTS.CRON_SCHEDULE),
  CRON_TIMEZONE: envString('CRON_TIMEZONE', DEFAULTS.CRON_TIMEZONE),
  EXCLUDED_APPS: envList('EXCLUDED_APPS', DEFAULTS.EXCLUDED_APPS),
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
  THRESHOLDS: {
    CPU: envNumber('CPU_THRESHOLD', DEFAULTS.CPU_THRESHOLD),
    MEMORY: envNumber('MEMORY_THRESHOLD_MB', DEFAULTS.MEMORY_THRESHOLD_MB),
  },
  THROTTLE_DURATION_MS: envNumber('THROTTLE_DURATION_MS', DEFAULTS.THROTTLE_DURATION_MS),
  RECHECK_INTERVAL_MS: envNumber('RECHECK_INTERVAL_MS', DEFAULTS.RECHECK_INTERVAL_MS),
  RECHECK_MAX_ATTEMPTS: envNumber('RECHECK_MAX_ATTEMPTS', DEFAULTS.RECHECK_MAX_ATTEMPTS),
  SLACK_TIMEOUT_MS: envNumber('SLACK_TIMEOUT_MS', DEFAULTS.SLACK_TIMEOUT_MS),
  RUN_ONCE: envBoolean('RUN_ONCE', DEFAULTS.RUN_ONCE),
  WEB_SERVER: {
    ENABLED: envBoolean('WEB_ENABLED', DEFAULTS.WEB_ENABLED),
    HOST: envString('HOST', DEFAULTS.WEB_HOST),
    PORT: envNumber('PORT', DEFAULTS.WEB_PORT),
    STATUS_TOKEN: process.env.STATUS_TOKEN,
    STATUS_LOG_FILE: envString('STATUS_LOG_FILE', DEFAULTS.STATUS_LOG_FILE),
    MAX_HISTORY: envNumber('MAX_HISTORY', DEFAULTS.MAX_HISTORY),
  },
  get RECHECK_TIMEOUT_SEC() {
    return Math.ceil((this.RECHECK_INTERVAL_MS * this.RECHECK_MAX_ATTEMPTS) / 1000);
  },
};

const appRestartHistory = new Map();
const notificationThrottleCache = new Map();
const activeRestartPolls = new Map();

async function monitorProcesses() {
  try {
    const processes = await getPm2Processes();
    const restartedApps = await detectAndHandleRestarts(processes);
    await checkStableProcesses(processes, restartedApps);

    if (CONFIG.WEB_SERVER.ENABLED) {
      await logStatusToFile(processes);
    }
  } catch (error) {
    console.error(`[Error] Failed to run monitoring cycle: ${error.message}`);
    await sendSlackNotification('PM2 Monitor', 'Monitoring Script Error', error.message, 'danger');
  }
}

async function detectAndHandleRestarts(processes) {
  const restartedApps = new Set();
  const currentRestartsByApp = new Map();

  for (const proc of processes) {
    const count = currentRestartsByApp.get(proc.name) || 0;
    currentRestartsByApp.set(proc.name, count + proc.restarts);
  }

  for (const [appName, totalRestarts] of currentRestartsByApp.entries()) {
    const prevRestarts = appRestartHistory.get(appName);

    if (prevRestarts !== undefined && totalRestarts > prevRestarts) {
      restartedApps.add(appName);
      const delta = totalRestarts - prevRestarts;
      const message = `Detected ${delta} restart(s) for '${appName}'. Monitoring status for up to ${CONFIG.RECHECK_TIMEOUT_SEC} seconds.`;
      await sendSlackNotification(appName, 'Process Restart Detected', message, 'warning');
      startPollingAppStatus(appName);
    }

    appRestartHistory.set(appName, totalRestarts);
  }

  return restartedApps;
}

function startPollingAppStatus(appName) {
  if (activeRestartPolls.has(appName)) {
    console.log(`[Polling] Restart polling for '${appName}' is already active.`);
    return;
  }

  let attempts = 0;
  const intervalId = setInterval(async () => {
    attempts += 1;
    console.log(`[Polling] Checking status for '${appName}' (${attempts}/${CONFIG.RECHECK_MAX_ATTEMPTS})`);

    try {
      const processes = await getPm2Processes();
      const appInstances = processes.filter((p) => p.name === appName);
      const isAllOnline = appInstances.length > 0 && appInstances.every((p) => p.status === 'online');

      if (isAllOnline) {
        stopPolling(appName);
        const avgCpu = average(appInstances.map((p) => p.cpu));
        const totalMemory = sum(appInstances.map((p) => p.memory));
        const message = `App '${appName}' restarted successfully and all ${appInstances.length} instance(s) are online.\n(CPU avg: ${avgCpu}%, Memory total: ${totalMemory}MB)`;
        console.log(`[Success] App '${appName}' has stabilized.`);
        await sendSlackNotification(appName, 'Restart Successful', message, 'good');
        return;
      }

      if (attempts >= CONFIG.RECHECK_MAX_ATTEMPTS) {
        stopPolling(appName);
        const reason = appInstances.length > 0
          ? `Current status:\n- ${appInstances.map((p) => `ID ${p.pm_id}: ${p.status}`).join('\n- ')}`
          : 'Could not find process.';
        const message = `App '${appName}' failed to become fully online within the time limit.\n${reason}`;
        console.error(`[Failure] App '${appName}' did not stabilize within the time limit.`);
        await sendSlackNotification(appName, 'Restart Failed', message, 'danger');
      }
    } catch (error) {
      stopPolling(appName);
      console.error(`[Error] Polling for '${appName}' failed: ${error.message}`);
      await sendSlackNotification(appName, `Status Polling Error for '${appName}'`, error.message, 'danger');
    }
  }, CONFIG.RECHECK_INTERVAL_MS);

  activeRestartPolls.set(appName, intervalId);
}

function stopPolling(appName) {
  const intervalId = activeRestartPolls.get(appName);
  if (intervalId) {
    clearInterval(intervalId);
    activeRestartPolls.delete(appName);
  }
}

async function checkStableProcesses(processes, restartedApps) {
  for (const proc of processes) {
    if (restartedApps.has(proc.name)) continue;

    const { name, pm_id, status, cpu, memory } = proc;
    console.log(`[Check] ${name}(${pm_id}): Status(${status}), CPU(${cpu}%), Memory(${memory}MB)`);

    if (status !== 'online') {
      await sendSlackNotification(name, 'Process Status Alert', `Instance \`${pm_id}\` has status \`${status}\`.`, 'danger');
      continue;
    }

    if (cpu > CONFIG.THRESHOLDS.CPU) {
      await sendSlackNotification(name, 'High CPU Usage', `Instance \`${pm_id}\` is using \`${cpu}%\` CPU.`, 'warning');
    }

    if (memory > CONFIG.THRESHOLDS.MEMORY) {
      await sendSlackNotification(name, 'High Memory Usage', `Instance \`${pm_id}\` is using \`${memory}MB\` of memory.`, 'warning');
    }
  }
}

async function getPm2Processes() {
  const { stdout } = await runPm2Jlist();
  if (!stdout.trim()) return [];

  let rawProcesses;
  try {
    rawProcesses = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`PM2 returned invalid JSON: ${error.message}`);
  }

  if (!Array.isArray(rawProcesses)) {
    throw new Error('PM2 returned an unexpected process list payload.');
  }

  return rawProcesses
    .filter((p) => p?.name && !CONFIG.EXCLUDED_APPS.includes(p.name))
    .map(({ pm_id, name, pm2_env = {}, monit = {} }) => ({
      pm_id,
      name,
      status: pm2_env.status || 'unknown',
      restarts: Number(pm2_env.restart_time) || 0,
      cpu: Number(monit.cpu) || 0,
      memory: roundMb(Number(monit.memory) || 0),
    }));
}

async function runPm2Jlist() {
  try {
    if (process.platform === 'win32') {
      return await execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', CONFIG.PM2_BIN, 'jlist'], execOptions());
    }

    return await execFile(CONFIG.PM2_BIN, ['jlist'], execOptions());
  } catch (error) {
    const detail = error.stderr || error.message;
    throw new Error(`Failed to execute '${CONFIG.PM2_BIN} jlist'. Ensure PM2 is installed and PM2_BIN is correct. ${detail}`.trim());
  }
}

function execOptions() {
  return {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  };
}

async function sendSlackNotification(appName, title, message, color = 'danger') {
  const key = `${appName}::${title}::${message}`;
  const now = Date.now();
  const lastSentAt = notificationThrottleCache.get(key);

  if (lastSentAt && now - lastSentAt < CONFIG.THROTTLE_DURATION_MS) {
    return;
  }

  console.log(`[Notification] Sending to Slack: [${appName}] ${title}`);
  try {
    const payload = createSlackPayload(appName, title, message, color);
    await axios.post(CONFIG.SLACK_WEBHOOK_URL, payload, {
      timeout: CONFIG.SLACK_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    notificationThrottleCache.set(key, now);
  } catch (error) {
    console.error(`[Error] Failed to send Slack notification: ${error.message}`);
  }
}

function createSlackPayload(appName, title, message, color) {
  const icon = color === 'good' ? ':white_check_mark:' : color === 'warning' ? ':warning:' : ':rotating_light:';

  return {
    attachments: [{
      color,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${icon} [PM2] ${title}`, emoji: true } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*App Name:*\n\`${appName}\`` },
            { type: 'mrkdwn', text: `*Time:*\n${formatTimestamp()}` },
          ],
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: message } },
      ],
    }],
  };
}

async function initialize() {
  validateConfig();

  console.log('Starting PM2 monitoring script.');
  console.log(`- Schedule: ${CONFIG.CRON_SCHEDULE}`);
  console.log(`- Timezone: ${CONFIG.CRON_TIMEZONE}`);
  console.log(`- Excluded Apps: ${CONFIG.EXCLUDED_APPS.join(', ') || 'None'}`);
  console.log(`- PM2 Binary: ${CONFIG.PM2_BIN}`);

  if (CONFIG.WEB_SERVER.ENABLED && !CONFIG.RUN_ONCE) {
    startWebServer();
  }

  const initialProcesses = await getPm2Processes();
  for (const proc of initialProcesses) {
    const count = appRestartHistory.get(proc.name) || 0;
    appRestartHistory.set(proc.name, count + proc.restarts);
  }
  console.log('Initial process state has been recorded.');

  console.log('Running the first monitoring check immediately.');
  await monitorProcesses();

  if (CONFIG.RUN_ONCE) {
    console.log('RUN_ONCE is enabled. Exiting after the initial monitoring check.');
    return;
  }

  cron.schedule(CONFIG.CRON_SCHEDULE, monitorProcesses, { timezone: CONFIG.CRON_TIMEZONE });
}

function startWebServer() {
  const { HOST, PORT, STATUS_LOG_FILE } = CONFIG.WEB_SERVER;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname !== '/status') {
      sendText(res, 404, 'Not Found');
      return;
    }

    if (!isAuthorizedStatusRequest(req, url)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      const data = await fs.readFile(STATUS_LOG_FILE, 'utf-8');
      sendJson(res, 200, JSON.parse(data));
    } catch (error) {
      if (error.code === 'ENOENT') {
        sendJson(res, 200, []);
        return;
      }
      console.error(`[Error] Failed to serve status history: ${error.message}`);
      sendJson(res, 500, { error: 'Could not read status file.' });
    }
  });

  server.listen(PORT, HOST, () => {
    const tokenNote = CONFIG.WEB_SERVER.STATUS_TOKEN ? ' token-protected' : '';
    console.log(`[Info] Status server is running at http://${HOST}:${PORT}/status${tokenNote}`);
  });

  server.on('error', (error) => {
    console.error(`[Error] Status server failed: ${error.message}`);
  });
}

async function logStatusToFile(processes) {
  const { STATUS_LOG_FILE, MAX_HISTORY } = CONFIG.WEB_SERVER;
  let history = [];

  try {
    const fileContent = await fs.readFile(STATUS_LOG_FILE, 'utf-8');
    history = JSON.parse(fileContent);
    if (!Array.isArray(history)) {
      console.error('[Error] Status history file is not an array. Starting a new history.');
      history = [];
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[Error] Failed to read status history file: ${error.message}`);
    }
  }

  history.unshift({ timestamp: formatTimestamp(), processes });
  const prunedHistory = history.slice(0, MAX_HISTORY);
  const tmpFile = `${STATUS_LOG_FILE}.${process.pid}.tmp`;

  await fs.writeFile(tmpFile, JSON.stringify(prunedHistory, null, 2));
  await fs.rename(tmpFile, STATUS_LOG_FILE);
}

function isAuthorizedStatusRequest(req, url) {
  const { STATUS_TOKEN } = CONFIG.WEB_SERVER;
  if (!STATUS_TOKEN) return true;

  const authHeader = req.headers.authorization || '';
  return authHeader === `Bearer ${STATUS_TOKEN}` || url.searchParams.get('token') === STATUS_TOKEN;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function validateConfig() {
  if (!isValidSlackWebhookUrl(CONFIG.SLACK_WEBHOOK_URL)) {
    console.error('Fatal Error: SLACK_WEBHOOK_URL must be a valid Slack Incoming Webhook URL.');
    process.exit(1);
  }

  if (!cron.validate(CONFIG.CRON_SCHEDULE)) {
    console.error(`Fatal Error: CRON_SCHEDULE is invalid: ${CONFIG.CRON_SCHEDULE}`);
    process.exit(1);
  }
}

function isValidSlackWebhookUrl(value) {
  if (!value) return false;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/');
  } catch {
    return false;
  }
}

function envString(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function envList(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatTimestamp() {
  return new Date().toLocaleString('en-US', { timeZone: CONFIG.CRON_TIMEZONE });
}

function roundMb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function sum(values) {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(2));
}

function average(values) {
  if (values.length === 0) return 0;
  return Number((sum(values) / values.length).toFixed(2));
}

initialize().catch((error) => {
  console.error(`[Fatal] ${error.message}`);
  process.exit(1);
});
