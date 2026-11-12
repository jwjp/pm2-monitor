import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createStatusServer } from '../src/server.js';
import { silentLogger } from './helpers.js';

const history = {
  list: (limit = 3) => [{ timestamp: '3' }, { timestamp: '2' }, { timestamp: '1' }].slice(0, limit),
};
const getState = () => ({ lastCycleAt: null, running: false, watchingRestarts: ['api'] });

async function start(options) {
  const server = createStatusServer({ history, getState, logger: silentLogger, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('a malformed Host header does not crash the server', async () => {
  const base = await start({ host: '127.0.0.1' });
  const { port } = new URL(base);

  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('GET /status HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });

  assert.match(reply, /^HTTP\/1\.1 (200|400)/);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
});

test('status is open on loopback without a token, with limit and latest', async () => {
  const base = await start({ host: '127.0.0.1' });

  assert.equal((await (await fetch(`${base}/status`)).json()).length, 3);
  assert.deepEqual(await (await fetch(`${base}/status?limit=1`)).json(), [{ timestamp: '3' }]);
  assert.deepEqual(await (await fetch(`${base}/status/latest`)).json(), { timestamp: '3' });
  assert.equal((await fetch(`${base}/status?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/status`, { method: 'POST' })).status, 405);
});

test('a non-loopback host requires a token', async () => {
  const base = await start({ host: '0.0.0.0' });
  assert.equal((await fetch(`${base}/status`)).status, 401);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  // App names are not shown to clients that cannot read /status.
  assert.deepEqual(await health.json(), { ok: true, lastCycleAt: null, running: false });
});

test('healthz lists watched apps for authorized clients', async () => {
  const base = await start({ host: '0.0.0.0', token: 's3cret' });
  const health = await fetch(`${base}/healthz`, { headers: { Authorization: 'Bearer s3cret' } });
  assert.deepEqual((await health.json()).watchingRestarts, ['api']);
});

test('a configured token is checked from the Authorization header only', async () => {
  const base = await start({ host: '127.0.0.1', token: 's3cret' });
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/status?token=s3cret`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { Authorization: 'Bearer s3cret' } })).status, 200);
});

test('dashboard: GET / and GET /dashboard serve HTML page', async () => {
  const base = await start({ host: '127.0.0.1' });
  for (const path of ['/', '/dashboard']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /PM2 Monitor Dashboard/);
    assert.match(body, /stat-total/);
  }
});

test('metrics: GET /metrics serves prometheus text format', async () => {
  const customHistory = {
    list: () => [{
      timestamp: '3',
      processes: [
        { name: 'api', pm_id: 0, status: 'online', restarts: 2, cpu: 15.5, memory: 120, uptimeStartedAt: 1000 },
        { name: 'worker', pm_id: 1, status: 'errored', restarts: 5, cpu: null, memory: null, uptimeStartedAt: null },
      ],
    }],
  };
  const base = await start({ host: '127.0.0.1', history: customHistory });
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const text = await res.text();
  assert.match(text, /# TYPE pm2_monitor_up gauge/);
  assert.match(text, /pm2_monitor_watching_restarts 1/);
  assert.match(text, /pm2_process_status\{app="api",pm_id="0",status="online"\} 1/);
  assert.match(text, /pm2_process_status\{app="worker",pm_id="1",status="errored"\} 0/);
  assert.match(text, /pm2_process_cpu_percent\{app="api",pm_id="0"\} 15\.5/);
  assert.match(text, /pm2_process_restarts_total\{app="api",pm_id="0"\} 2/);
});

test('metrics: requires token when configured on non-loopback', async () => {
  const base = await start({ host: '0.0.0.0', token: 's3cret' });
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const ok = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer s3cret' } });
  assert.equal(ok.status, 200);
});
