import cron from 'node-cron';

const TRUE_VALUES = ['1', 'true', 'yes', 'on'];
const FALSE_VALUES = ['0', 'false', 'no', 'off'];
const MINUTE_MS = 60 * 1000;
const LEGACY_MIN_REPEAT_MS = 5 * MINUTE_MS;

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/**
 * Builds the runtime configuration from environment variables and CLI flags.
 * Invalid values are collected as errors instead of silently falling back, so
 * a typo in `.env` is reported at startup rather than hiding a wrong setting.
 */
export function loadConfig(env = process.env, argv = []) {
  const errors = [];
  const warnings = [];
  const flags = new Set(argv);
  const read = (name) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const string = (name, fallback) => read(name) ?? fallback;

  const number = (name, fallback, { min = 0, max = Infinity, integer = false } = {}) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      const kind = integer ? 'an integer' : 'a number';
      const range = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
      errors.push(`${name} must be ${kind} ${range} (got "${raw}").`);
      return fallback;
    }
    return value;
  };

  const boolean = (name, fallback) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = raw.toLowerCase();
    if (TRUE_VALUES.includes(value)) return true;
    if (FALSE_VALUES.includes(value)) return false;
    errors.push(`${name} must be true/false (got "${raw}").`);
    return fallback;
  };

  const list = (name, fallback) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  };

  // THROTTLE_DURATION_MS is the 1.x name of ALERT_REPEAT_MS. It used to be a
  // short throttle (30000 in the old .env.example); read as a reminder interval,
  // such a value re-sends every ongoing alert at every check. Values below
  // LEGACY_MIN_REPEAT_MS are therefore ignored with a warning.
  const alertRepeatMs = () => {
    const fallback = 30 * MINUTE_MS;
    if (read('ALERT_REPEAT_MS') !== undefined) return number('ALERT_REPEAT_MS', fallback, { min: 0 });
    if (read('THROTTLE_DURATION_MS') === undefined) return fallback;

    const legacy = number('THROTTLE_DURATION_MS', fallback, { min: 0 });
    if (legacy > 0 && legacy < LEGACY_MIN_REPEAT_MS) {
      warnings.push(`THROTTLE_DURATION_MS=${legacy} is ignored: it now sets the reminder interval, and a value this short would repeat every alert at each check. Using ALERT_REPEAT_MS=${fallback}. Remove it or set ALERT_REPEAT_MS.`);
      return fallback;
    }
    warnings.push('THROTTLE_DURATION_MS is deprecated. Rename it to ALERT_REPEAT_MS.');
    return legacy;
  };

  const dryRun = flags.has('--dry-run') || boolean('DRY_RUN', false);

  const config = {
    pm2Bin: string('PM2_BIN', process.platform === 'win32' ? 'pm2.cmd' : 'pm2'),
    schedule: string('CRON_SCHEDULE', '*/1 8-19 * * 1-5'),
    timezone: string('CRON_TIMEZONE', 'Asia/Seoul'),
    excludedApps: list('EXCLUDED_APPS', ['pm2-monitor', 'pm2-logrotate']),
    // Only used on Windows: read CPU/memory from the OS when PM2 reports 0.
    windowsUsageFallback: boolean('WINDOWS_USAGE_FALLBACK', true),
    runOnce: flags.has('--once') || boolean('RUN_ONCE', false),
    dryRun,
    slack: {
      webhookUrl: read('SLACK_WEBHOOK_URL'),
      timeoutMs: number('SLACK_TIMEOUT_MS', 10 * 1000, { min: 1000 }),
    },
    thresholds: {
      cpu: number('CPU_THRESHOLD', 80, { min: 0 }),
      memoryMb: number('MEMORY_THRESHOLD_MB', 450, { min: 0 }),
    },
    resourceAlertSamples: number('RESOURCE_ALERT_SAMPLES', 2, { min: 1, integer: true }),
    alertRepeatMs: alertRepeatMs(),
    recheck: {
      intervalMs: number('RECHECK_INTERVAL_MS', 5 * 1000, { min: 1000 }),
      maxAttempts: number('RECHECK_MAX_ATTEMPTS', 12, { min: 1, integer: true }),
    },
    web: {
      enabled: boolean('WEB_ENABLED', true),
      host: string('HOST', '127.0.0.1'),
      port: number('PORT', 3031, { min: 0, max: 65535, integer: true }),
      token: read('STATUS_TOKEN'),
      historyFile: string('STATUS_LOG_FILE', './status-history.json'),
      maxHistory: number('MAX_HISTORY', 1440, { min: 1, integer: true }),
      saveIntervalMs: number('STATUS_SAVE_INTERVAL_MS', 5 * MINUTE_MS, { min: 0 }),
    },
  };

  if (!dryRun && !isValidSlackWebhookUrl(config.slack.webhookUrl)) {
    errors.push('SLACK_WEBHOOK_URL must be a Slack Incoming Webhook URL (https://hooks.slack.com/services/...). Use --dry-run to test without Slack.');
  }
  if (!cron.validate(config.schedule)) {
    errors.push(`CRON_SCHEDULE is not a valid cron expression: "${config.schedule}".`);
  }
  if (!isValidTimezone(config.timezone)) {
    errors.push(`CRON_TIMEZONE is not a valid IANA time zone: "${config.timezone}".`);
  }

  return { config, errors, warnings };
}

export function isValidSlackWebhookUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/');
  } catch {
    return false;
  }
}

export function isValidTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(host);
}
