import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMonitorState } from '../src/state.js';
import { memoryState, proc, setup, silentLogger } from './helpers.js';

test('state: saved at most every saveIntervalMs, and always when forced', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm2-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  let clock = 0;
  const store = createMonitorState({ file, saveIntervalMs: 60000, now: () => clock, logger: silentLogger });
  const saved = async () => JSON.parse(await fs.readFile(file, 'utf-8'));

  await store.save({ version: 1, n: 1 });
  assert.equal((await saved()).n, 1);

  clock = 30000;
  await store.save({ version: 1, n: 2 });
  assert.equal((await saved()).n, 1);

  clock = 60000;
  await store.save({ version: 1, n: 3 });
  assert.equal((await saved()).n, 3);

  clock = 61000;
  await store.save({ version: 1, n: 4 });
  await store.flush({ force: true });
  assert.equal((await saved()).n, 4);
});

test('state: a failed save is retried inside the interval', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm2-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'missing', 'state.json');
  let clock = 0;
  const store = createMonitorState({ file, saveIntervalMs: 60000, now: () => clock, logger: silentLogger });

  await store.save({ version: 1, n: 1 });
  await assert.rejects(fs.access(file));

  await fs.mkdir(path.dirname(file));
  clock = 1000;
  await store.save({ version: 1, n: 1 });
  assert.equal((await JSON.parse(await fs.readFile(file, 'utf-8'))).n, 1);
});

test('state: a missing, corrupt, or unknown-version file loads as no state', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm2-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const store = createMonitorState({ file, logger: silentLogger });
  assert.equal(await store.load(), null);

  await fs.writeFile(file, '{');
  assert.equal(await store.load(), null);

  await fs.writeFile(file, '{"version":2}\n');
  assert.equal(await store.load(), null);

  await fs.writeFile(file, '[]\n');
  assert.equal(await store.load(), null);
});

test('state: the next process reports restarts against the file on disk', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm2-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'monitor-state.json');

  const first = setup({
    monitorState: createMonitorState({ file, logger: silentLogger }),
    processes: [proc('api', 0, { restarts: 1 })],
  });
  await first.monitor.runCycle();
  await first.monitor.stop();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf-8')).restartBaseline['api#0'], 1);

  const second = setup({
    monitorState: createMonitorState({ file, logger: silentLogger }),
    processes: [proc('api', 0, { restarts: 3 })],
  });
  await second.monitor.runCycle();
  await second.monitor.stop();
  assert.equal(second.titles()[0], 'Process Restart Detected');
  assert.match(second.sent[0].message, /Detected 2 restart\(s\)/);
});

test('memoryState clones snapshots so later edits do not rewrite history', async () => {
  const store = memoryState();
  const snapshot = { version: 1, alerts: [{ key: 'a' }] };
  await store.save(snapshot);
  snapshot.alerts.push({ key: 'b' });
  assert.equal(store.box.saved.alerts.length, 1);
  assert.equal(store.box.saves, 1);
});
