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

  // PM2 gave up restarting: the lasting errored state is now reported on its own.
  t.advance(MINUTE);
  await t.monitor.runCycle();
  assert.deepEqual(t.titles(), ['Process Restart Detected', 'Restart Failed', 'Process Status Alert']);
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

test('alerts for removed instances are dropped silently', async () => {
  const t = setup({ processes: [proc('api', 0, { status: 'stopped' })] });
  await t.monitor.runCycle();
  t.state.processes = [];
  await t.monitor.runCycle();
  t.state.processes = [proc('api', 0, { status: 'stopped' })];
  await t.monitor.runCycle();

  assert.deepEqual(t.titles(), ['Process Status Alert', 'Process Status Alert']);
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
