import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { parseJlist } from '../src/pm2.js';
import { AlertTracker } from '../src/alerts.js';
import { buildSlackPayload, createNotifier } from '../src/notifier.js';
import { silentLogger } from './helpers.js';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';

test('config: defaults load with a valid webhook', () => {
  const { config, errors } = loadConfig({ SLACK_WEBHOOK_URL: WEBHOOK });
  assert.deepEqual(errors, []);
  assert.equal(config.alertRepeatMs, 30 * 60 * 1000);
  assert.equal(config.resourceAlertSamples, 2);
  assert.equal(config.web.host, '127.0.0.1');
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
  const { config } = loadConfig({ DRY_RUN: ' TRUE ', THROTTLE_DURATION_MS: '60000', EXCLUDED_APPS: ' a, ,b ' });
  assert.equal(config.dryRun, true);
  assert.equal(config.alertRepeatMs, 60000);
  assert.deepEqual(config.excludedApps, ['a', 'b']);
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
  assert.equal(tracker.evaluate('k', false, 1300), null);
});

test('alerts: an unsent alert is not resolved', () => {
  const tracker = new AlertTracker();
  assert.equal(tracker.evaluate('k', true, 0), 'fire');
  assert.equal(tracker.evaluate('k', false, 10), null);
});

test('notifier: payload has fallback text and escapes Slack control characters', () => {
  const payload = buildSlackPayload({ app: 'a<b>', title: 'T', message: 'x & <y>', level: 'warning', now: new Date(0), timezone: 'UTC' });
  assert.equal(payload.text, '[PM2] T: a<b>');
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
