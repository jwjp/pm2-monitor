import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { decodeConsoleOutput, parseJlist } from '../src/pm2.js';
import { AlertTracker } from '../src/alerts.js';
import { buildSlackPayload, buildDiscordPayload, createNotifier } from '../src/notifier.js';
import { silentLogger } from './helpers.js';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/123456/abcdef';

test('config: defaults load with a valid webhook', () => {
  const { config, errors } = loadConfig({ SLACK_WEBHOOK_URL: WEBHOOK });
  assert.deepEqual(errors, []);
  assert.equal(config.alertRepeatMs, 30 * 60 * 1000);
  assert.equal(config.resourceAlertSamples, 2);
  assert.equal(config.web.host, '127.0.0.1');
  assert.equal(config.timezone, 'Asia/Seoul');
  assert.equal(config.windowsUsageFallback, true);
  assert.equal(config.web.saveIntervalMs, 5 * 60 * 1000);
  assert.equal(config.incidentStableMs, 10 * 60 * 1000);
  assert.equal(config.state.file, './monitor-state.json');
  assert.equal(config.state.saveIntervalMs, 0);
  assert.equal(config.appThresholds.size, 0);
});

test('config: invalid values are reported instead of silently ignored', () => {
  const { errors } = loadConfig({
    SLACK_WEBHOOK_URL: 'https://example.com/hook',
    PORT: 'abc',
    RECHECK_INTERVAL_MS: '0',
    WEB_ENABLED: 'maybe',
    CRON_SCHEDULE: 'every minute',
    CRON_TIMEZONE: 'Mars/Base',
  });
  assert.equal(errors.length, 6);
  assert.match(errors.join('\n'), /PORT.*"abc"/);
  assert.match(errors.join('\n'), /RECHECK_INTERVAL_MS/);
});

test('config: dry run does not need a webhook, and flags override env', () => {
  const { config, errors } = loadConfig({}, ['--dry-run', '--once']);
  assert.deepEqual(errors, []);
  assert.equal(config.dryRun, true);
  assert.equal(config.runOnce, true);
});

test('config: legacy THROTTLE_DURATION_MS still works and values are trimmed', () => {
  const { config, warnings } = loadConfig({ DRY_RUN: ' TRUE ', THROTTLE_DURATION_MS: '600000', EXCLUDED_APPS: ' a, ,b ' });
  assert.equal(config.dryRun, true);
  assert.equal(config.alertRepeatMs, 600000);
  assert.deepEqual(config.excludedApps, ['a', 'b']);
  assert.match(warnings.join(' '), /Rename it to ALERT_REPEAT_MS/);
});

test('config: per-app thresholds override cpu, memory, or both', () => {
  const { config, errors } = loadConfig({ DRY_RUN: 'true', APP_THRESHOLDS: 'api:cpu=95:memoryMb=1024, worker:memoryMb=100' });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.appThresholds.get('api'), { cpu: 95, memoryMb: 1024 });
  assert.deepEqual(config.appThresholds.get('worker'), { memoryMb: 100 });
  assert.equal(config.thresholds.cpu, 80);
});

test('config: a bad APP_THRESHOLDS entry is reported', () => {
  const { errors } = loadConfig({ DRY_RUN: 'true', APP_THRESHOLDS: 'api:disk=1, :cpu=1, api:cpu=1:cpu=2, worker:cpu=80' });
  const text = errors.join('\n');
  assert.match(text, /invalid part "disk=1"/);
  assert.match(text, /must look like/);
  assert.match(text, /sets cpu more than once/);
  assert.doesNotMatch(text, /worker/);
});

test('config: a short 1.x THROTTLE_DURATION_MS is not used as the reminder interval', () => {
  const { config, errors, warnings } = loadConfig({ DRY_RUN: 'true', THROTTLE_DURATION_MS: '30000' });
  assert.deepEqual(errors, []);
  assert.equal(config.alertRepeatMs, 30 * 60 * 1000);
  assert.match(warnings.join(' '), /THROTTLE_DURATION_MS=30000 is ignored/);

  // ALERT_REPEAT_MS wins and is taken as given.
  const explicit = loadConfig({ DRY_RUN: 'true', THROTTLE_DURATION_MS: '30000', ALERT_REPEAT_MS: '60000' });
  assert.equal(explicit.config.alertRepeatMs, 60000);
  assert.deepEqual(explicit.warnings, []);
});

test('pm2: parses jlist output and skips excluded apps', () => {
  const stdout = JSON.stringify([
    { pm_id: 0, name: 'api', pid: 10, pm2_env: { status: 'online', restart_time: 2 }, monit: { cpu: 3, memory: 50 * 1024 * 1024 } },
    { pm_id: 1, name: 'pm2-monitor', pm2_env: { status: 'online' }, monit: {} },
  ]);
  const result = parseJlist(stdout, ['pm2-monitor']);
  assert.equal(result.length, 1);
  assert.deepEqual(
    { name: result[0].name, status: result[0].status, restarts: result[0].restarts, memory: result[0].memory },
    { name: 'api', status: 'online', restarts: 2, memory: 50 },
  );
});

test('pm2: tolerates notices printed before the JSON', () => {
  const stdout = '[PM2] In-memory PM2 is out-of-date, do:\n[PM2] $ pm2 update\n[{"pm_id":0,"name":"api","pm2_env":{"status":"online"}}]\n';
  assert.equal(parseJlist(stdout)[0].name, 'api');
});

test('pm2: cmd.exe messages in the console code page are decoded', async () => {
  // "'pm2'은(는)" as cmd.exe prints it on Korean Windows (CP949).
  const cp949 = Buffer.from([0x27, 0x70, 0x6d, 0x32, 0x27, 0xc0, 0xba, 0x28, 0xb4, 0xc2, 0x29]);
  assert.equal(await decodeConsoleOutput(cp949, async () => 949), "'pm2'은(는)");
  // Valid UTF-8 is kept as is, and an unknown code page does not throw.
  assert.equal(await decodeConsoleOutput(Buffer.from('café'), async () => 949), 'café');
  assert.equal(typeof await decodeConsoleOutput(cp949, async () => { throw new Error('no chcp'); }), 'string');
});

test('pm2: empty output is an empty list, garbage is an error', () => {
  assert.deepEqual(parseJlist('  '), []);
  assert.throws(() => parseJlist('not json'), /no valid JSON/);
});

test('alerts: fire, suppress, repeat, resolve', () => {
  const tracker = new AlertTracker({ repeatMs: 1000 });
  assert.equal(tracker.evaluate('k', true, 0), 'fire');
  tracker.markSent('k', 0);
  assert.equal(tracker.evaluate('k', true, 500), null);
  assert.equal(tracker.evaluate('k', true, 1000), 'repeat');
  tracker.markSent('k', 1000);
  assert.equal(tracker.evaluate('k', false, 1200), 'resolve');
  tracker.markResolved('k');
  assert.equal(tracker.evaluate('k', false, 1300), null);
});

test('alerts: an undelivered resolve is returned again, and a relapse continues the alert', () => {
  const tracker = new AlertTracker({ repeatMs: 1000 });
  tracker.evaluate('k', true, 0);
  tracker.markSent('k', 0);
  assert.equal(tracker.evaluate('k', false, 100), 'resolve');
  assert.equal(tracker.evaluate('k', false, 200), 'resolve');
  // Back before the resolve got through: still the same problem for the recipient.
  assert.equal(tracker.evaluate('k', true, 300), null);
  assert.equal(tracker.evaluate('k', true, 1000), 'repeat');
});

test('alerts: exported state restores an open condition and a pending resolve', () => {
  const tracker = new AlertTracker({ repeatMs: 1000 });
  tracker.evaluate('cpu', true, 0, 'high');
  tracker.markSent('cpu', 0);
  tracker.evaluate('down', true, 0, 'errored');
  tracker.markSent('down', 0);
  assert.equal(tracker.evaluate('down', false, 100, 'errored'), 'resolve');

  const copy = new AlertTracker({ repeatMs: 1000 });
  copy.importState(tracker.exportState());
  assert.equal(copy.evaluate('cpu', true, 500, 'high'), null);
  assert.equal(copy.evaluate('cpu', true, 1000, 'high'), 'repeat');
  assert.equal(copy.evaluate('down', false, 200, 'errored'), 'resolve');

  // Malformed entries are skipped and do not clear what was restored.
  copy.importState([{ key: '', since: 0 }, { since: 1 }, null, { key: 'ok', since: 5, lastSentAt: 5, signature: 's', resolving: true }]);
  assert.equal(copy.evaluate('ok', false, 6, 's'), 'resolve');
  assert.equal(copy.since('cpu'), 0);
});

test('alerts: an unsent alert is not resolved', () => {
  const tracker = new AlertTracker();
  assert.equal(tracker.evaluate('k', true, 0), 'fire');
  assert.equal(tracker.evaluate('k', false, 10), null);
});

test('notifier: payload has fallback text and escapes Slack control characters', () => {
  const payload = buildSlackPayload({ app: 'a<b>', title: 'T', message: 'x & <y>', level: 'warning', now: new Date(0), timezone: 'UTC' });
  assert.equal(payload.text, '[PM2] T: a&lt;b&gt;');
  assert.doesNotMatch(JSON.stringify(buildSlackPayload({ app: '<!channel>', title: 'T', message: 'm', level: 'good', now: new Date(0), timezone: 'UTC' })), /<!channel>/);
  assert.equal(payload.attachments[0].color, 'warning');
  assert.match(JSON.stringify(payload), /x &amp; &lt;y&gt;/);
});

test('notifier: delivery failures return false instead of throwing', async () => {
  const notifier = createNotifier({
    webhookUrl: WEBHOOK, timeoutMs: 1000, timezone: 'UTC', logger: silentLogger,
    post: async () => { throw new Error('boom'); },
  });
  assert.equal(await notifier.send({ app: 'a', title: 't', message: 'm' }), false);
});

test('config: Discord webhook is supported as an alternative or complement to Slack', () => {
  const discordOnly = loadConfig({ DISCORD_WEBHOOK_URL: DISCORD_WEBHOOK });
  assert.deepEqual(discordOnly.errors, []);
  assert.equal(discordOnly.config.discord.webhookUrl, DISCORD_WEBHOOK);

  const both = loadConfig({ SLACK_WEBHOOK_URL: WEBHOOK, DISCORD_WEBHOOK_URL: DISCORD_WEBHOOK });
  assert.deepEqual(both.errors, []);
  assert.equal(both.config.slack.webhookUrl, WEBHOOK);
  assert.equal(both.config.discord.webhookUrl, DISCORD_WEBHOOK);

  const invalid = loadConfig({ DISCORD_WEBHOOK_URL: 'https://example.com/not-discord' });
  assert.match(invalid.errors.join('\n'), /DISCORD_WEBHOOK_URL must be a Discord Webhook URL/);
});

test('notifier: buildDiscordPayload format and color mapping', () => {
  const payload = buildDiscordPayload({
    app: 'my-app',
    title: 'High CPU',
    message: 'CPU is 95%',
    level: 'danger',
    now: new Date('2026-01-01T00:00:00Z'),
    timezone: 'UTC',
  });
  assert.equal(payload.content, '[PM2] High CPU: my-app');
  assert.equal(payload.embeds[0].color, 0xa30200);
  assert.match(payload.embeds[0].title, /\[PM2\] High CPU/);
  assert.equal(payload.embeds[0].description, 'CPU is 95%');
  assert.equal(payload.embeds[0].fields[0].value, '`my-app`');
});

test('notifier: sends to both Slack and Discord when configured', async () => {
  const sentUrls = [];
  const notifier = createNotifier({
    slack: { webhookUrl: WEBHOOK },
    discord: { webhookUrl: DISCORD_WEBHOOK },
    timezone: 'UTC',
    logger: silentLogger,
    post: async (url) => {
      sentUrls.push(url);
      return { status: 200 };
    },
  });

  const ok = await notifier.send({ app: 'test-app', title: 'Test Alert', message: 'testing' });
  assert.equal(ok, true);
  assert.deepEqual(sentUrls, [WEBHOOK, DISCORD_WEBHOOK]);
});
