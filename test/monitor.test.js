import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proc, setup } from './helpers.js';
import { formatDuration } from '../src/monitor.js';

const MINUTE = 60 * 1000;

test('the first check only records restart counts as a baseline', async () => {
  const t = setup({ processes: [proc('api', 0, { restarts: 7 })] });
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), []);
});

test('a restart is reported and confirmed once the app is stable', async () => {
  const t = setup({ processes: [proc('api', 0), proc('api', 1)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 }), proc('api', 1, { restarts: 2 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Successful']);
  assert.match(t.sent[0].message, /Detected 3 restart\(s\) of 'api' \(instance 0, 1\)/);
  assert.match(t.sent[0].message, /since the last check/);
  assert.match(t.sent[1].message, /\(CPU avg: 1%, Memory total: 100MB\)/);
});

test('unknown usage is left out of the recovery message, not counted as 0', async () => {
  const t = setup({ env: { INCIDENT_STABLE_MS: '0' }, processes: [proc('api', 0), proc('api', 1)] });
  await t.monitor.runCycle();

  t.state.processes = [
    proc('api', 0, { restarts: 1, cpu: null, memory: null }),
    proc('api', 1, { restarts: 1, cpu: 40, memory: 100 }),
  ];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();
  assert.match(t.sent[1].message, /\(CPU avg: 40% \(1 unknown\), Memory total: 100MB \(1 unknown\)\)/);

  t.state.processes = [
    proc('api', 0, { restarts: 2, cpu: null, memory: null }),
    proc('api', 1, { restarts: 2, cpu: null, memory: null }),
  ];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();
  assert.match(t.sent.at(-1).message, /\(CPU avg: unknown, Memory total: unknown\)/);
});

test('a restart that keeps crashing is reported as failed', async () => {
  const t = setup({ env: { RECHECK_MAX_ATTEMPTS: '3' }, processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  let restarts = 1;
  t.state.processes = [proc('api', 0, { restarts })];
  // Online at every poll, but restarting in between: not stable.
  t.state.beforePoll = () => {
    restarts += 1;
    t.state.processes = [proc('api', 0, { restarts })];
  };
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed']);
  assert.match(t.sent[1].message, /restarted 3 more time\(s\)/);
});

test('an errored instance fails the restart watch immediately', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1, status: 'errored' })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed']);
  assert.equal(t.state.clock, Date.UTC(2026, 0, 5, 14, 1, 5)); // one 5s poll, not 12
});

test('a crash loop does not repeat restart alerts within the reminder interval', async () => {
  const t = setup({ env: { RECHECK_MAX_ATTEMPTS: '2' }, processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  for (let i = 1; i <= 5; i += 1) {
    t.state.processes = [proc('api', 0, { restarts: i * 3, status: 'errored' })];
    t.advance(MINUTE);
    await t.monitor.runCycle();
    await t.monitor.idle();
  }
  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed']);

  // PM2 gave up restarting. "Restart Failed" already said `errored`, so the
  // lasting state is not reported again until its reminder is due.
  t.advance(MINUTE);
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed']);
  t.advance(30 * MINUTE);
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed', 'Process Still Down']);
});

test('a changed status after Restart Failed is still reported', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1, status: 'errored' })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  t.state.processes = [proc('api', 0, { restarts: 1, status: 'stopped' })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed', 'Process Status Alert', 'App Recovered']);
});

test('an app that restarts again after it was reported stable is one incident', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  // Restarts about once a minute, but is online at every poll of the watch.
  for (let i = 1; i <= 6; i += 1) {
    t.state.processes = [proc('api', 0, { restarts: i })];
    t.advance(MINUTE);
    await t.monitor.runCycle();
    await t.monitor.idle();
  }
  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Successful', 'Process Restart Detected']);
  assert.match(t.sent[2].message, /restarted again 1m after it was reported stable/);
  assert.match(t.sent[2].message, /2 restart\(s\) since this incident started/);
  assert.match(t.sent[2].message, /until it stays up for 10m/);

  // Stable from the last watch poll on: recovered once 10 minutes have passed, not before.
  for (let i = 0; i < 9; i += 1) {
    t.advance(MINUTE);
    await t.monitor.runCycle();
  }
  assert.equal(t.titles().length, 3);
  t.advance(MINUTE);
  await t.monitor.runCycle();
  assert.equal(t.titles().at(-1), 'App Recovered');
  assert.match(t.sent.at(-1).message, /stayed up for 10m after 6 restart\(s\)/);
});

test('a restart after the stable period is a new incident', async () => {
  const t = setup({ env: { INCIDENT_STABLE_MS: String(5 * MINUTE) }, processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();
  for (let i = 0; i < 6; i += 1) {
    t.advance(MINUTE);
    await t.monitor.runCycle();
  }

  t.state.processes = [proc('api', 0, { restarts: 2 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Successful', 'Process Restart Detected', 'Restart Successful']);
  assert.doesNotMatch(t.sent[2].message, /again|since this incident started/);
});

test('an undelivered relapse alert is retried at the next restart', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  t.state.deliver = false;
  t.state.processes = [proc('api', 0, { restarts: 2 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  t.state.deliver = true;
  t.state.processes = [proc('api', 0, { restarts: 3 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Successful', 'Process Restart Detected', 'Process Restart Detected']);
  assert.match(t.sent[3].message, /restarted again/);
});

test('a lasting problem is reported once, reminded, and resolved', async () => {
  const t = setup({ env: { ALERT_REPEAT_MS: String(30 * MINUTE) }, processes: [proc('api', 0, { status: 'stopped' })] });

  for (let i = 0; i < 31; i += 1) {
    await t.monitor.runCycle();
    t.advance(MINUTE);
  }
  t.state.processes = [proc('api', 0)];
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Still Down', 'Process Back Online']);
  assert.match(t.sent[1].message, /ongoing for 30m/);
  assert.match(t.sent[2].message, /online again after 31m/);
});

test('a status change while down is reported as a new alert', async () => {
  const t = setup({ processes: [proc('api', 0, { status: 'stopping' })] });
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { status: 'errored' })];
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Status Alert']);
  assert.match(t.sent[1].message, /errored/);
});

test('high CPU must last for RESOURCE_ALERT_SAMPLES checks before alerting', async () => {
  const t = setup({ processes: [proc('api', 0, { cpu: 95 })] });

  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), []);

  await t.monitor.runCycle();
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['High CPU Usage']);

  t.state.processes = [proc('api', 0, { cpu: 10 })];
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['High CPU Usage', 'CPU Usage Back to Normal']);
});

test('an unknown resource sample does not clear an open alert', async () => {
  const t = setup({ processes: [proc('api', 0, { cpu: 95, memory: 800 })] });
  await t.monitor.runCycle();
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['High CPU Usage', 'High Memory Usage']);

  t.state.processes = [proc('api', 0, { cpu: null, memory: null })];
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['High CPU Usage', 'High Memory Usage']);

  t.state.processes = [proc('api', 0, { cpu: 10, memory: 50 })];
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['High CPU Usage', 'High Memory Usage', 'CPU Usage Back to Normal', 'Memory Usage Back to Normal']);
});

test('an unknown CPU sample does not reset the breach streak', async () => {
  const t = setup({ processes: [proc('api', 0, { cpu: 95 })] });
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { cpu: null })];
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { cpu: 95 })];
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['High CPU Usage']);
});

test('a short CPU spike does not produce a recovery message', async () => {
  const t = setup({ processes: [proc('api', 0, { cpu: 95 })] });
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { cpu: 10 })];
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), []);
});

test('high memory alerts with the configured threshold', async () => {
  const t = setup({ env: { RESOURCE_ALERT_SAMPLES: '1', MEMORY_THRESHOLD_MB: '100' }, processes: [proc('api', 3, { memory: 120.5 })] });
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['High Memory Usage']);
  assert.match(t.sent[0].message, /`120.5MB` \(threshold 100MB\)/);
});

test('PM2 failures are reported once and their recovery is reported', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  t.state.fail = new Error('pm2 not found');

  const first = await t.monitor.runCycle();
  await t.monitor.runCycle();
  t.state.fail = null;
  await t.monitor.runCycle();

  assert.equal(first.ok, false);
  assert.deepEqual(t.titles(), ['Monitoring Failed', 'Monitoring Recovered']);
});

test('an alert whose delivery failed is retried on the next check', async () => {
  const t = setup({ processes: [proc('api', 0, { status: 'stopped' })], deliver: false });

  await t.monitor.runCycle();
  t.state.deliver = true;
  await t.monitor.runCycle();
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Status Alert']);
});

test('overlapping checks are skipped', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  const [a, b] = await Promise.all([t.monitor.runCycle(), t.monitor.runCycle()]);
  assert.equal(a.ok, true);
  assert.equal(b.skipped, true);
});

test('stop lets a running check finish and skips later ones', async () => {
  const t = setup({ processes: [proc('api', 0, { status: 'errored' })] });
  let finished = false;
  t.monitor.runCycle().then(() => { finished = true; });
  await t.monitor.stop();
  assert.equal(finished, true);
  assert.deepEqual(t.titles(), ['Process Status Alert']);

  assert.equal((await t.monitor.runCycle()).skipped, true);
});

test('a removed app is reported once and its alerts are closed', async () => {
  const t = setup({ processes: [proc('api', 0, { status: 'stopped' }), proc('api', 1, { status: 'stopped' })] });
  await t.monitor.runCycle();
  t.state.processes = [];
  await t.monitor.runCycle();
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { status: 'stopped' })];
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Status Alert', 'App Removed', 'Process Status Alert']);
  assert.match(t.sent[2].message, /'api' \(2 instance\(s\)\) is no longer in the PM2 process list/);
});

test('scaling an app down is not reported as removed', async () => {
  const t = setup({ processes: [proc('api', 0), proc('api', 1), proc('web', 2)] });
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0), proc('web', 2)];
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), []);
});

test('an undelivered App Removed is retried, unless the app comes back first', async () => {
  const t = setup({ processes: [proc('api', 0), proc('web', 1)] });
  await t.monitor.runCycle();

  t.state.processes = [];
  t.state.deliver = false;
  await t.monitor.runCycle();
  t.state.deliver = true;
  t.state.processes = [proc('web', 1)];
  await t.monitor.runCycle();
  await t.monitor.runCycle();

  // Both removals failed to send; web came back before the retry, api did not.
  assert.deepEqual(t.sent.map((alert) => `${alert.title}:${alert.app}`), ['App Removed:api', 'App Removed:web', 'App Removed:api']);
});

test('an app that leaves during a restart watch is reported only by Restart Failed', async () => {
  const t = setup({ env: { RECHECK_MAX_ATTEMPTS: '2' }, processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.state.beforePoll = () => { t.state.processes = []; };
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();
  t.state.beforePoll = null;
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed']);
  assert.match(t.sent[1].message, /no longer in the PM2 process list/);
});

test('IGNORE_STATUSES silences a status and clears an open alert', async () => {
  const t = setup({ env: { IGNORE_STATUSES: 'stopped' }, processes: [proc('api', 0, { status: 'stopped' })] });
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), []);

  t.state.processes = [proc('api', 0, { status: 'errored' })];
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { status: 'stopped' })];
  await t.monitor.runCycle();
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Status Cleared']);
  assert.match(t.sent[1].message, /now `stopped`, which IGNORE_STATUSES excludes/);
});

test('an instance in an ignored status does not fail a restart watch', async () => {
  const t = setup({ env: { IGNORE_STATUSES: 'stopped' }, processes: [proc('api', 0), proc('api', 1, { status: 'stopped' })] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 }), proc('api', 1, { status: 'stopped' })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Successful']);
  assert.match(t.sent[1].message, /1 of 2 instance\(s\) are online, the others are stopped \(ignored\)/);
  assert.match(t.sent[1].message, /Memory total: 50MB/);
});

test('an app stopped during its restart watch ends the watch quietly', async () => {
  const t = setup({ env: { IGNORE_STATUSES: 'stopped' }, processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.state.beforePoll = () => { t.state.processes = [proc('api', 0, { restarts: 1, status: 'stopped' })]; };
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Restart Detected']);
});

test('restart alerts carry the end of the error log when RESTART_LOG_LINES is set', async () => {
  const log = '/logs/api-error-0.log';
  const t = setup({ env: { RESTART_LOG_LINES: '2' }, processes: [proc('api', 0, { errLogPath: log })] });
  t.state.logs[log] = ['old line', 'Error: boom', '    at main (app.js:1:1) ```'];
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1, status: 'errored', errLogPath: log })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed']);
  for (const alert of t.sent) {
    assert.match(alert.message, /Last 2 line\(s\) of the error log of instance 0:\n```\nError: boom\n {4}at main \(app\.js:1:1\) '''\n```$/);
    assert.doesNotMatch(alert.message, /old line/);
  }
});

test('the error log is off by default, and an unreadable log only drops the excerpt', async () => {
  const t = setup({ processes: [proc('api', 0, { errLogPath: '/logs/a.log' })] });
  t.state.logs['/logs/a.log'] = ['Error: boom'];
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { restarts: 1, errLogPath: '/logs/a.log' })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();
  assert.doesNotMatch(t.sent[0].message, /error log/);

  const u = setup({ env: { RESTART_LOG_LINES: '5' }, processes: [proc('api', 0, { errLogPath: '/missing.log' })] });
  await u.monitor.runCycle();
  u.state.processes = [proc('api', 0, { restarts: 1, errLogPath: '/missing.log' })];
  u.advance(MINUTE);
  await u.monitor.runCycle();
  await u.monitor.idle();
  assert.deepEqual(u.titles(), ['Process Restart Detected', 'Restart Successful']);
  assert.doesNotMatch(u.sent[0].message, /error log/);
});

test('a long error log is cut to fit the alert, keeping the newest lines', async () => {
  const log = '/logs/api.log';
  const t = setup({ env: { RESTART_LOG_LINES: '50' }, processes: [proc('api', 0, { errLogPath: log })] });
  t.state.logs[log] = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(200)}`);
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { restarts: 1, errLogPath: log })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  const excerpt = t.sent[0].message.split('```\n')[1];
  assert.ok(excerpt.length <= 1500 + '\n```'.length);
  assert.match(excerpt, /^line 4\d x+\n/);
  assert.match(excerpt, /line 49 x+\n```$/);
});

test('the heartbeat is sent after each check that could read PM2', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();
  t.state.fail = new Error('pm2 down');
  await t.monitor.runCycle();
  t.state.fail = null;
  await t.monitor.runCycle();

  assert.equal(t.state.pings, 2);
});

test('an undelivered resolve is retried on the next check', async () => {
  const t = setup({ processes: [proc('api', 0, { status: 'stopped' })] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0)];
  t.state.deliver = false;
  await t.monitor.runCycle();
  t.state.deliver = true;
  await t.monitor.runCycle();
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Back Online', 'Process Back Online']);
});

test('an undelivered Restart Failed is retried at the next failure', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1, status: 'errored' })];
  t.state.beforePoll = () => { t.state.deliver = false; };
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  t.state.beforePoll = null;
  t.state.deliver = true;
  t.state.processes = [proc('api', 0, { restarts: 2, status: 'errored' })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed', 'Restart Failed']);
});

test('recovery is reported when only the failure alert got through', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1, status: 'errored' })];
  t.state.deliver = false;
  t.state.beforePoll = () => { t.state.deliver = true; };
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed', 'App Recovered']);
});

test('an undelivered recovery is retried on the next check', async () => {
  const t = setup({ processes: [proc('api', 0)] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.state.beforePoll = () => { t.state.deliver = false; };
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();

  t.state.beforePoll = null;
  t.state.deliver = true;
  await t.monitor.runCycle();
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Successful', 'App Recovered']);
});

test('restarting a stopped app is not also reported as back online', async () => {
  const t = setup({ processes: [proc('api', 0, { status: 'stopped' })] });
  await t.monitor.runCycle();

  t.state.processes = [proc('api', 0, { restarts: 1 })];
  t.advance(MINUTE);
  await t.monitor.runCycle();
  await t.monitor.idle();
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Restart Detected', 'Restart Successful']);
});

test('formatDuration renders compact durations', () => {
  assert.equal(formatDuration(42 * 1000), '42s');
  assert.equal(formatDuration(5 * MINUTE), '5m');
  assert.equal(formatDuration(125 * MINUTE), '2h 5m');
  assert.equal(formatDuration(120 * MINUTE), '2h');
});
