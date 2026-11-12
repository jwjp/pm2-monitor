import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from './config.js';

/**
 * HTTP endpoints:
 *   GET /healthz             liveness plus the time of the last completed check
 *   GET /status[?limit=N]    status history, newest first (array)
 *   GET /status/latest       the most recent snapshot, or null
 */
export function createStatusServer({ host, token, history, getState, logger = console }) {
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

    if (!['/healthz', '/status', '/status/latest'].includes(path)) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true, ...getState() });
      return;
    }
    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'Unauthorized' });
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

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}
