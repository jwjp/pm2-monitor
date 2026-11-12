import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsUsageReader } from '../src/usage.js';
import { fillMissingUsage } from '../src/pm2.js';
import { createHistory } from '../src/history.js';
import { proc, silentLogger } from './helpers.js';

const MB = 1024 * 1024;

test('usage: CPU comes from the CPU time used since the previous reading', async () => {
  let clock = 0;
  let output = '';
  const asked = [];
  const reader = createWindowsUsageReader({
    now: () => clock,
    run: async (pids) => { asked.push(pids); return output; },
  });

  output = '10 1000 52428800\r\n20 500 1048576\r\n';
  const first = await reader.read([10, 20, 10, 0, -1]);
  assert.deepEqual(asked[0], [10, 20]); // deduplicated, invalid pids dropped
  assert.deepEqual(first.get(10), { cpu: null, memoryBytes: 50 * MB });

  // 10: 1500ms CPU in 5000ms = 30% of one core. 20 is gone. 30 is new.
  clock = 5000;
  output = '10 2500 52428800\n30 100 1048576\nnot a usage line\n';
  const second = await reader.read([10, 20, 30]);
  assert.equal(second.get(10).cpu, 30);
  assert.equal(second.has(20), false);
  assert.equal(second.get(30).cpu, null);
});

test('usage: a reused pid with less CPU time starts over', async () => {
  let clock = 0;
  let output = '10 9000 1048576';
  const reader = createWindowsUsageReader({ now: () => clock, run: async () => output });
  await reader.read([10]);
  clock = 1000;
  output = '10 100 1048576';
  assert.equal((await reader.read([10])).get(10).cpu, null);
});

test('usage: overlapping reads run one after another', async () => {
  let clock = 0;
  let cpuMs = 0;
  let active = 0;
  const reader = createWindowsUsageReader({
    now: () => clock,
    run: async () => {
      active += 1;
      assert.equal(active, 1);
      cpuMs += 500;
      const line = `10 ${cpuMs} 1048576`;
      await new Promise((resolve) => setTimeout(resolve, 5));
      clock += 1000;
      active -= 1;
      return line;
    },
  });
  const [, second, third] = await Promise.all([reader.read([10]), reader.read([10]), reader.read([10])]);
  assert.equal(second.get(10).cpu, 50);
  assert.equal(third.get(10).cpu, 50);
});

test('usage: a failed read does not block later ones', async () => {
  let fail = true;
  const reader = createWindowsUsageReader({
    run: async () => { if (fail) throw new Error('boom'); return '10 1 1048576'; },
  });
  await assert.rejects(reader.read([10]), /boom/);
  fail = false;
  assert.equal((await reader.read([10])).get(10).memoryBytes, 1048576);
});

test('usage: no pids means no PowerShell call', async () => {
  const reader = createWindowsUsageReader({ run: async () => { throw new Error('should not run'); } });
  assert.equal((await reader.read([])).size, 0);
});

test('pm2: only online processes that PM2 reports with 0 memory are filled in', async () => {
  const processes = [
    proc('api', 0, { pid: 11, cpu: 0, memory: 0 }),
    proc('api', 1, { pid: 12, cpu: 5, memory: 80 }), // PM2 could read it
    proc('job', 2, { pid: 0, status: 'stopped', cpu: 0, memory: 0 }),
  ];
  const asked = [];
  const reader = { read: async (pids) => { asked.push(...pids); return new Map([[11, { cpu: 12.5, memoryBytes: 150 * MB }]]); } };

  await fillMissingUsage(processes, reader, silentLogger);

  assert.deepEqual(asked, [11]);
  assert.deepEqual([processes[0].cpu, processes[0].memory], [12.5, 150]);
  assert.deepEqual([processes[1].cpu, processes[1].memory], [5, 80]);
});

test('pm2: a failing usage reader marks usage unknown and warns once', async () => {
  const warnings = [];
  const logger = { ...silentLogger, warn: (line) => warnings.push(line) };
  const reader = { read: async () => { throw new Error('powershell missing'); } };
  const processes = [proc('api', 0, { pid: 11, cpu: 0, memory: 0 })];

  await fillMissingUsage(processes, reader, logger);
  await fillMissingUsage(processes, reader, logger);

  assert.deepEqual([processes[0].cpu, processes[0].memory], [null, null]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /powershell missing/);
});

test('pm2: a missing pid and a first CPU reading stay unknown', async () => {
  const processes = [
    proc('api', 0, { pid: 11, cpu: 0, memory: 0 }),
    proc('api', 1, { pid: 12, cpu: 0, memory: 0 }),
  ];
  const reader = { read: async () => new Map([[11, { cpu: null, memoryBytes: 150 * MB }]]) };

  await fillMissingUsage(processes, reader, silentLogger);

  assert.deepEqual([processes[0].cpu, processes[0].memory], [null, 150]);
  assert.deepEqual([processes[1].cpu, processes[1].memory], [null, null]);
});

test('history: saved at most every saveIntervalMs, and always when forced', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm2-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json');
  let clock = 0;
  const history = createHistory({ file, maxEntries: 10, saveIntervalMs: 60000, now: () => clock, logger: silentLogger });
  const saved = async () => JSON.parse(await fs.readFile(file, 'utf-8')).length;

  history.add({ timestamp: '1' });
  await history.flush();
  assert.equal(await saved(), 1); // the first snapshot is saved right away

  clock = 30000;
  history.add({ timestamp: '2' });
  await history.flush();
  assert.equal(await saved(), 1); // within the interval

  clock = 60000;
  history.add({ timestamp: '3' });
  await history.flush();
  assert.equal(await saved(), 3);

  clock = 61000;
  history.add({ timestamp: '4' });
  await history.flush({ force: true });
  assert.equal(await saved(), 4);
});

test('history: a failed save is retried inside the interval', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm2-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'missing', 'history.json');
  let clock = 0;
  const history = createHistory({ file, maxEntries: 10, saveIntervalMs: 60000, now: () => clock, logger: silentLogger });

  history.add({ timestamp: '1' });
  await history.flush();
  await assert.rejects(fs.access(file));

  await fs.mkdir(path.dirname(file));
  clock = 1000;
  await history.flush();
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf-8')), [{ timestamp: '1' }]);
});
