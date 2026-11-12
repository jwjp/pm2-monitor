import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(callbackExecFile);

const EXEC_OPTIONS = {
  windowsHide: true,
  maxBuffer: 20 * 1024 * 1024,
  timeout: 30 * 1000,
};

/** Runs `pm2 jlist` and returns the normalized, filtered process list. */
export async function listPm2Processes({ pm2Bin, excludedApps }) {
  const stdout = await runJlist(pm2Bin);
  return parseJlist(stdout, excludedApps);
}

async function runJlist(pm2Bin) {
  try {
    // On Windows, pm2 is a .cmd shim that can only be launched through cmd.exe.
    // With /s, cmd strips the outer quotes, so the inner quotes keep paths with spaces intact.
    const { stdout } = process.platform === 'win32'
      ? await execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${pm2Bin}" jlist"`], { ...EXEC_OPTIONS, windowsVerbatimArguments: true })
      : await execFile(pm2Bin, ['jlist'], EXEC_OPTIONS);
    return stdout;
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    throw new Error(`Failed to run '${pm2Bin} jlist'. Check that PM2 is installed and PM2_BIN is correct. ${detail}`.trim());
  }
}

/**
 * Parses `pm2 jlist` output. PM2 sometimes prints notices such as
 * "[PM2] In-memory PM2 is out-of-date" before the JSON, so the parser looks for
 * the first line that starts a JSON array instead of parsing the whole output.
 */
export function parseJlist(stdout, excludedApps = []) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];

  const raw = extractJsonArray(text);
  const excluded = new Set(excludedApps);

  return raw
    .filter((p) => p && typeof p.name === 'string' && !excluded.has(p.name))
    .map(({ pm_id, name, pid, pm2_env = {}, monit = {} }) => ({
      pm_id,
      name,
      pid: Number(pid) || 0,
      status: pm2_env.status || 'unknown',
      restarts: Number(pm2_env.restart_time) || 0,
      cpu: Number(monit.cpu) || 0,
      memory: roundMb(Number(monit.memory) || 0),
      uptimeStartedAt: Number(pm2_env.pm_uptime) || null,
    }));
}

function extractJsonArray(text) {
  const end = text.lastIndexOf(']');
  let lastError;
  let offset = 0;

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('[') && end > offset) {
      try {
        const parsed = JSON.parse(text.slice(offset, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch (error) {
        lastError = error;
      }
    }
    offset += line.length + 1;
  }

  throw new Error(`PM2 returned no valid JSON process list${lastError ? `: ${lastError.message}` : '.'}`);
}

function roundMb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}
