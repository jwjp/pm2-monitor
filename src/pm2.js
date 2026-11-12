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
  if (process.platform !== 'win32') {
    try {
      return (await execFile(pm2Bin, ['jlist'], EXEC_OPTIONS)).stdout;
    } catch (error) {
      throw jlistError(pm2Bin, error.stderr || error.message);
    }
  }

  // On Windows, pm2 is a .cmd shim that can only be launched through cmd.exe.
  // With /s, cmd strips the outer quotes, so the inner quotes keep paths with spaces intact.
  // Output is read as bytes: PM2 writes UTF-8, but cmd.exe's own messages
  // ("... is not recognized") use the console code page, e.g. CP949 on Korean Windows.
  const options = { ...EXEC_OPTIONS, windowsVerbatimArguments: true, encoding: 'buffer' };
  try {
    const { stdout } = await execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${pm2Bin}" jlist"`], options);
    return stdout.toString('utf8');
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) && error.stderr.length > 0 ? await decodeConsoleOutput(error.stderr) : '';
    throw jlistError(pm2Bin, stderr || error.message);
  }
}

function jlistError(pm2Bin, detail) {
  const text = String(detail ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  return new Error(`Failed to run '${pm2Bin} jlist'. Check that PM2 is installed and PM2_BIN is correct. ${text}`.trim());
}

// Windows code pages that TextDecoder supports, by number.
const CODE_PAGE_LABELS = {
  866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
};
/** Decodes cmd.exe output: UTF-8 when valid, otherwise the console code page. */
export async function decodeConsoleOutput(bytes, getCodePage = readConsoleCodePage) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const label = CODE_PAGE_LABELS[await getCodePage().catch(() => null)] ?? 'utf-8';
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes); // Runtime without full ICU.
    }
  }
}

let codePage;

function readConsoleCodePage() {
  // The code page does not change while the process runs, so ask only once.
  codePage ??= execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, timeout: 5000, encoding: 'latin1' })
    .then(({ stdout }) => {
      // chcp prints a localized sentence, but the number is always its last digits.
      const match = /(\d+)\D*$/.exec(stdout);
      return match ? Number(match[1]) : null;
    })
    .catch(() => null);
  return codePage;
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
