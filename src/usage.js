import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(callbackExecFile);

// Prints "<pid> <cpu milliseconds> <working set bytes>" per process. Missing
// pids are skipped; `exit 0` keeps them from turning the run into a failure.
const SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Get-Process -Id $env:PM2_MONITOR_PIDS.Split(",") | ForEach-Object {',
  '  "{0} {1} {2}" -f $_.Id, [long]$_.TotalProcessorTime.TotalMilliseconds, $_.WorkingSet64',
  '}',
  'exit 0',
].join('\n');

/**
 * Reads CPU and memory of processes from Windows itself. PM2 reads them through
 * `wmic`, which recent Windows 11 builds no longer ship, so `pm2 jlist` reports
 * 0 there. CPU is a percentage of one core, like PM2's, computed from the CPU
 * time used since the previous reading of the same pid; the first reading of a
 * pid therefore has no CPU value yet.
 */
export function createWindowsUsageReader({ run = runPowerShell, now = () => Date.now() } = {}) {
  const previous = new Map(); // pid -> { cpuMs, at }

  return {
    /** Returns Map(pid -> { cpu: number | null, memoryBytes: number }). */
    async read(pids) {
      const wanted = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
      const usage = new Map();
      if (wanted.length === 0) return usage;

      const stdout = await run(wanted);
      const at = now();
      for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
        if (!match) continue;
        const [pid, cpuMs, memoryBytes] = match.slice(1).map(Number);

        const last = previous.get(pid);
        const elapsed = last ? at - last.at : 0;
        // A lower CPU time means the pid now belongs to another process.
        const cpu = last && elapsed > 0 && cpuMs >= last.cpuMs
          ? Number((((cpuMs - last.cpuMs) / elapsed) * 100).toFixed(1))
          : null;
        previous.set(pid, { cpuMs, at });
        usage.set(pid, { cpu, memoryBytes });
      }

      for (const pid of previous.keys()) {
        if (!usage.has(pid)) previous.delete(pid);
      }
      return usage;
    },
  };
}

async function runPowerShell(pids) {
  // The pids go through the environment, so nothing is interpolated into the script.
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    windowsHide: true,
    timeout: 15 * 1000,
    env: { ...process.env, PM2_MONITOR_PIDS: pids.join(',') },
  });
  return stdout;
}
