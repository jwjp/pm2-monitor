import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from './config.js';
import { renderDashboardHtml } from './dashboard.js';

/**
 * HTTP endpoints:
 *   GET /                    web dashboard (HTML)
 *   GET /dashboard           web dashboard (HTML)
 *   GET /healthz             liveness plus the time of the last completed check
 *   GET /metrics             Prometheus metrics in openmetrics format
 *   GET /status[?limit=N]    status history, newest first (array)
 *   GET /status/latest       the most recent snapshot, or null
 */
export function createStatusServer({ host, port, token, history, getState, logger = console }) {
  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (error) {
      logger.error(`[Error] Status request failed: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal Server Error' });
      else res.destroy();
    }
  });

  function route(req, res) {
    // A fixed base keeps a malformed Host header from throwing.
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!['/', '/dashboard', '/healthz', '/metrics', '/status', '/status/latest'].includes(path)) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    if (path === '/' || path === '/dashboard') {
      sendHtml(res, 200, renderDashboardHtml({ host, port }));
      return;
    }
    if (path === '/healthz') {
      // App names are only shown to clients that may also read /status.
      const { watchingRestarts, ...state } = getState();
      sendJson(res, 200, { ok: true, ...state, ...(isAuthorized(req) ? { watchingRestarts } : {}) });
      return;
    }
    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (path === '/metrics') {
      const snapshot = history?.list(1)[0] ?? null;
      const state = getState();
      sendText(res, 200, formatPrometheusMetrics({ snapshot, state }), 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }
    if (path === '/status/latest') {
      sendJson(res, 200, history.list(1)[0] ?? null);
      return;
    }

    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      sendJson(res, 400, { error: 'limit must be a positive integer.' });
      return;
    }
    sendJson(res, 200, history.list(limit));
  }

  function isAuthorized(req) {
    // Without a token, history is served only on a loopback bind address.
    if (!token) return isLoopbackHost(host);
    // Hashing gives both sides the same length, which timingSafeEqual requires.
    const sha256 = (value) => createHash('sha256').update(value).digest();
    return timingSafeEqual(sha256(req.headers.authorization || ''), sha256(`Bearer ${token}`));
  }

  return server;
}

export function formatPrometheusMetrics({ snapshot, state, now = Date.now() }) {
  const lines = [
    '# HELP pm2_monitor_up 1 if the PM2 monitor is running.',
    '# TYPE pm2_monitor_up gauge',
    `pm2_monitor_up ${state?.running ? 1 : 0}`,
    '# HELP pm2_monitor_watching_restarts Current number of apps being watched for stability.',
    '# TYPE pm2_monitor_watching_restarts gauge',
    `pm2_monitor_watching_restarts ${(state?.watchingRestarts || []).length}`,
  ];

  if (state?.lastCycleAt) {
    const timestampSec = Math.floor(new Date(state.lastCycleAt).getTime() / 1000);
    lines.push(
      '# HELP pm2_monitor_last_check_timestamp_seconds Epoch timestamp of the last completed check.',
      '# TYPE pm2_monitor_last_check_timestamp_seconds gauge',
      `pm2_monitor_last_check_timestamp_seconds ${timestampSec}`,
    );
  }

  const processes = snapshot?.processes || [];
  if (processes.length > 0) {
    lines.push(
      '# HELP pm2_process_status Process online status (1=online, 0=other).',
      '# TYPE pm2_process_status gauge',
    );
    for (const p of processes) {
      lines.push(`pm2_process_status{app="${escapeProm(p.name)}",pm_id="${p.pm_id}",status="${escapeProm(p.status)}"} ${p.status === 'online' ? 1 : 0}`);
    }

    lines.push(
      '# HELP pm2_process_cpu_percent Process CPU usage percent.',
      '# TYPE pm2_process_cpu_percent gauge',
    );
    for (const p of processes) {
      if (p.cpu !== null && p.cpu !== undefined) {
        lines.push(`pm2_process_cpu_percent{app="${escapeProm(p.name)}",pm_id="${p.pm_id}"} ${p.cpu}`);
      }
    }

    lines.push(
      '# HELP pm2_process_memory_bytes Process memory usage in bytes.',
      '# TYPE pm2_process_memory_bytes gauge',
    );
    for (const p of processes) {
      if (p.memory !== null && p.memory !== undefined) {
        lines.push(`pm2_process_memory_bytes{app="${escapeProm(p.name)}",pm_id="${p.pm_id}"} ${Math.round(p.memory * 1024 * 1024)}`);
      }
    }

    lines.push(
      '# HELP pm2_process_restarts_total Process restart count.',
      '# TYPE pm2_process_restarts_total counter',
    );
    for (const p of processes) {
      lines.push(`pm2_process_restarts_total{app="${escapeProm(p.name)}",pm_id="${p.pm_id}"} ${p.restarts || 0}`);
    }

    lines.push(
      '# HELP pm2_process_uptime_seconds Process uptime in seconds.',
      '# TYPE pm2_process_uptime_seconds gauge',
    );
    for (const p of processes) {
      if (p.uptimeStartedAt && p.status === 'online') {
        const uptime = Math.max(0, Math.floor((now - p.uptimeStartedAt) / 1000));
        lines.push(`pm2_process_uptime_seconds{app="${escapeProm(p.name)}",pm_id="${p.pm_id}"} ${uptime}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

function escapeProm(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : text);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : html);
}
