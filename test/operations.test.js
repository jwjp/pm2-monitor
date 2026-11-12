import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { parseJlist } from '../src/pm2.js';
import { readLogTail } from '../src/logs.js';
import { createHeartbeat } from '../src/heartbeat.js';

test('config: IGNORE_STATUSES, RESTART_LOG_LINES and HEARTBEAT_URL are validated', () => {
  const defaults = loadConfig({ DRY_RUN: 'true' });
  assert.deepEqual(defaults.errors, []);
  assert.deepEqual(defaults.config.ignoreStatuses, []);
  assert.equal(defaults.config.restartLogLines, 0);
  assert.equal(defaults.config.heartbeat.url, undefined);

  const valid = loadConfig({
    DRY_RUN: 'true',
    IGNORE_STATUSES: 'stopped, waiting restart',
    RESTART_LOG_LINES: '20',
    HEARTBEAT_URL: 'https://hc-ping.com/abc',
  });
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.config.ignoreStatuses, ['stopped', 'waiting restart']);
  assert.equal(valid.config.restartLogLines, 20);
  assert.equal(valid.config.heartbeat.url, 'https://hc-ping.com/abc');

  const invalid = loadConfig({
    DRY_RUN: 'true',
    IGNORE_STATUSES: 'stopped,online,down',
    RESTART_LOG_LINES: '51',
    HEARTBEAT_URL: 'ftp://example.com',
  });
  assert.equal(invalid.errors.length, 3);
  assert.match(invalid.errors.join('\n'), /IGNORE_STATUSES.*"online, down"/);
  assert.match(invalid.errors.join('\n'), /RESTART_LOG_LINES/);
  assert.match(invalid.errors.join('\n'), /HEARTBEAT_URL/);
});

test('pm2: the error log path is kept from jlist', () => {
  const stdout = JSON.stringify([
    { pm_id: 0, name: 'api', pm2_env: { status: 'online', pm_err_log_path: '/home/u/.pm2/logs/api-error.log' } },
    { pm_id: 1, name: 'web', pm2_env: { status: 'online' } },
  ]);
  assert.deepEqual(parseJlist(stdout).map((p) => p.errLogPath), ['/home/u/.pm2/logs/api-error.log', null]);
});

test('logs: the tail skips blank lines, colors and a partial first line', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm2-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'api-error.log');

  await fs.writeFile(file, 'first\r\n\r\n\u001b[31mError: boom\u001b[39m\r\n    at main\r\n\r\n');
  assert.deepEqual(await readLogTail(file, 2), ['Error: boom', '    at main']);
  assert.deepEqual(await readLogTail(file, 10), ['first', 'Error: boom', '    at main']);

  // Only the last maxBytes are read; the line cut at that boundary is dropped.
  await fs.writeFile(file, `${'a'.repeat(100)}\nkept 1\nkept 2\n`);
  assert.deepEqual(await readLogTail(file, 10, { maxBytes: 20 }), ['kept 1', 'kept 2']);

  await fs.writeFile(file, `${'b'.repeat(500)}\n`);
  const [long] = await readLogTail(file, 1);
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));

  await fs.writeFile(file, '');
  assert.deepEqual(await readLogTail(file, 5), []);
  await assert.rejects(readLogTail(path.join(dir, 'missing.log'), 5), /ENOENT/);
});

test('heartbeat: failures do not throw, are logged once, and hide the URL token', async () => {
  const logs = [];
  const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  let fail = true;
  const requests = [];
  const heartbeat = createHeartbeat({
    url: 'https://hc-ping.com/secret-uuid',
    timeoutMs: 5000,
    logger,
    get: async (url, options) => {
      requests.push({ url, timeout: options.timeout });
      if (fail) throw new Error('timeout of 5000ms exceeded');
    },
  });

  assert.equal(await heartbeat.ping(), false);
  assert.equal(await heartbeat.ping(), false);
  fail = false;
  assert.equal(await heartbeat.ping(), true);

  assert.deepEqual(requests[0], { url: 'https://hc-ping.com/secret-uuid', timeout: 5000 });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /Heartbeat to https:\/\/hc-ping\.com failed/);
  assert.match(logs[1], /delivered again/);
  assert.ok(logs.every((line) => !line.includes('secret-uuid')));
});
