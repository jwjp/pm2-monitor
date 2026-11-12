# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.
User-facing documentation lives in [README.md](README.md); this file covers how
the code works and how to change it safely.

## What this is

A Node.js (ESM, Node >= 22) service that runs under PM2, polls `pm2 jlist` on a
cron schedule, and sends Slack alerts for restarts, non-`online` status, and
high CPU/memory. It sends a follow-up when each problem clears, reports apps
that leave the process list, can attach the end of an app's error log to
restart alerts, pings an optional heartbeat URL, and can serve the status
history as JSON over HTTP.

Runtime dependencies are only `axios`, `dotenv` and `node-cron`. Do not add
dependencies without a clear need; tests use Node's built-in `node:test`.

## Commands

```bash
npm install
npm test            # node --test, runs test/*.test.js (no PM2 or Slack needed)
npm run check       # syntax check of the entry point + tests
npm run dry-run     # one check against the local PM2; alerts are only logged
npm run once        # one check, alerts really sent to Slack
npm start           # pm2 start ecosystem.config.cjs
```

Run `npm test` after every change. All tests must pass before committing.
CI (`.github/workflows/test.yml`) runs `npm run check` on Linux and Windows
for every supported Node version.

## Layout

```text
pm2-monitor.js     entry point: loads .env, validates config, wires modules,
                   runs the first check, schedules the rest, handles SIGINT/SIGTERM
src/config.js      loadConfig(env, argv) -> { config, errors, warnings }; pure, no side effects
src/pm2.js         listPm2Processes(config, { usageReader }), parseJlist(stdout, excludedApps),
                   fillMissingUsage, decodeConsoleOutput (cmd.exe code page)
src/usage.js       createWindowsUsageReader({ run, now }): CPU/memory via Get-Process
src/logs.js        readLogTail(file, lines): end of a log file, reads only the last 64 KB
src/heartbeat.js   createHeartbeat({ url, timeoutMs }).ping() -> Promise<boolean>
src/monitor.js     createMonitor({...}): restart detection, restart watches,
                   status/resource conditions, incidents; the core logic
src/alerts.js      AlertTracker: per-condition state (fire / repeat / resolve)
src/notifier.js    createNotifier({...}).send(alert) -> Promise<boolean>; Slack payloads
src/history.js     in-memory history (newest first), atomic JSON file persistence,
                   saved at most every saveIntervalMs (flush({ force }) on shutdown)
src/state.js       createMonitorState({ file, saveIntervalMs, now }): alert and
                   incident state, same atomic write and retry rules as history
src/server.js      createStatusServer({...}): /healthz, /status, /status/latest
test/helpers.js    setup(): monitor with fake PM2 state, clock, sleep and notifier.
                   memoryState() stands in for the state file
test/*.test.js     monitor behavior, server, config/pm2/alerts/notifier units,
                   usage reader, history and monitor-state persistence, log tail
                   and heartbeat (operations.test.js)
```

## Design rules (keep these when changing code)

1. **Inject side effects.** `createMonitor` receives `listProcesses`, `notifier`,
   `history`, `heartbeat`, `readLog`, `state`, `now`, `sleep` and `logger`.
   Never call PM2, Slack, the file system, `Date.now()` or timers directly
   inside `src/monitor.js`; otherwise the tests cannot control them.
2. **One alert per problem.** Every condition goes through `AlertTracker` with a
   stable key: `"<app>#<pm_id>::status|cpu|memory"` or `"monitor::pm2"`.
   - `fire` when a condition starts or its signature changes (e.g. status
     `stopping` -> `errored`),
   - `repeat` after `alertRepeatMs` while it lasts (0 disables reminders),
   - `resolve` when it clears, but only if the alert was actually delivered.
     The condition stays tracked until `markResolved`, so a failed resolve is
     retried; if the problem returns first, it continues as the same alert.
   Call `markSent` / `markResolved` only after a successful send, so failed
   deliveries are retried. The same applies to incidents: "Restart Failed" is
   marked as sent, and an incident closed, only after delivery.
   Do not reintroduce a plain time-based throttle.
3. **Restarts are tracked per instance** (`<name>#<pm_id>`) and grouped per app.
   The first check with no saved state only sets the baseline. A lower restart
   count (e.g. after `pm2 reset`) resets the baseline without alerting. A
   saved baseline is compared on the next process start, so restarts during
   downtime are reported.
4. **Restart watches** (`watchRestart`) poll every `recheck.intervalMs` up to
   `recheck.maxAttempts` times. Success requires every instance `online` *and*
   no new restarts since the previous poll. `errored` fails immediately. While
   a watch runs, `checkInstances` skips that app so it is not reported twice.
5. **Incidents** (`incidents` map) group a crash loop: after one "Restart
   Detected" and one "Restart Failed", later restarts are only logged until the
   app is stable ("Restart Successful" / "App Recovered") or the reminder
   interval passes. The recovery message is sent if any alert of the incident
   was delivered, and it resolves the instances' status alerts, so no separate
   "Process Back Online" follows. The incident stays open for
   `incidentStableMs` after the app is first seen healthy (`stableSince`). A
   restart in that time is a relapse: it is reported once ("restarted again …")
   even inside the reminder interval, marks the incident `flapping`, and
   "App Recovered" is then sent only after the app stays up for the full
   period. Without this, an app that crashes slower than the watch polls sends
   "Restart Detected" + "Restart Successful" at every check. A delivered
   "Restart Failed" also `adopt`s the status alerts of its non-online
   instances as already sent, so the next check does not repeat the same
   `errored` state as "Process Status Alert" (reminders still follow).
6. **Never throw out of a cycle.** `notifier.send` returns `false` instead of
   throwing, `history.flush` and `state.save` log instead of throwing, and
   `runCycle` turns PM2 failures into the `monitor::pm2` condition. `runCycle`
   skips itself if the previous run is still in progress.
7. **Config fails loudly.** Add new settings in `src/config.js` through the
   `string/number/boolean/list` helpers with explicit bounds; invalid values
   must become an entry in `errors`, not a silent fallback. A deprecated or
   ignored legacy value goes into `warnings`, which are printed at startup
   (see `THROTTLE_DURATION_MS`). Document every new
   variable in `README.md` (configuration table) and `.env.example`.
8. **Ignored statuses** (`IGNORE_STATUSES`) count as healthy (`isHealthy`):
   they raise no status alert, an open one resolves as "Process Status
   Cleared" (not "Back Online"), and they do not fail a restart watch. Recovery
   still needs at least one `online` instance; if every instance is in an
   ignored status, the watch and incident end without a message.
9. **Removed apps** (`detectRemovedApps`): an app name in the previous check
   but not in this one sends "App Removed" once, retried until delivered unless
   the app returns first. It is per app, not per instance, so scaling down is
   silent. An app under a restart watch is left to the watch; a delivered
   "Restart Failed" for an app that left the list suppresses "App Removed".
10. **Log excerpts and heartbeat are best effort.** `logExcerpt` returns `''`
    when `RESTART_LOG_LINES` is 0 or the log cannot be read (warning logged);
    the alert is sent anyway. `heartbeat.ping()` runs only after a check that
    read PM2, never throws, warns once per outage, and logs only the URL's
    origin because heartbeat URLs carry a token. Dry and one-off runs get no
    heartbeat, so a manual check cannot mask a dead scheduled monitor.
11. **HTTP server**: parse URLs against a fixed base (`http://localhost`), never
    the `Host` header (a malformed Host used to crash the process). `/status`
    needs a Bearer token compared with `timingSafeEqual`, or a loopback bind
    address when no token is set. Do not accept tokens in query strings.
12. **Monitor state** (`src/state.js`) is the alert machine, separate from the
    status history. It stores restart baselines, `AlertTracker` entries
    (including a resolve that has not been delivered), breach streaks,
    incidents, known apps and undelivered "App Removed" entries. Version is
    `1`; anything else is ignored with a warning and the check starts from a
    baseline. One-off runs pass `state: null` so they cannot race a live
    monitor. An in-progress restart watch is not resumed after a process
    restart: the next check recovers the incident if the app is healthy, or
    reports status if it is not. Shutdown force-saves before it waits for
    watches, then again after they settle. `STATE_SAVE_INTERVAL_MS` defaults
    to 0 because the file is small and a missed save is a missed or repeated
    alert.
13. **Per-app thresholds** (`config.appThresholds`, from `APP_THRESHOLDS`)
    override cpu, memoryMb, or both for one app name. An omitted field keeps
    the global threshold. The alert text shows the threshold that was used.

## Platform gotchas

- **Windows + PM2**: `pm2` is a `.cmd` shim, so `src/pm2.js` runs it as
  `cmd.exe /d /s /c ""<PM2_BIN>" jlist"` with `windowsVerbatimArguments`. The
  double quoting is deliberate; it keeps `PM2_BIN` paths with spaces working.
- **`pm2 jlist` may print notices** (`[PM2] In-memory PM2 is out-of-date`)
  before the JSON; `parseJlist` handles this. Keep a test for it.
- **CPU/memory are 0 on recent Windows 11** because PM2's `wmic`-based usage
  reading is unavailable. This is not a parsing bug; check the raw `jlist`.
  `fillMissingUsage` fills them from `src/usage.js` (PowerShell `Get-Process`)
  only for online processes with 0 memory, so hosts where PM2 works are
  untouched. CPU is the CPU-time delta between two readings of the same pid
  (percent of one core, like PM2), so the first reading has no CPU value and
  stays `null`. A failed or missing reading sets CPU and memory to `null`.
  Resource checks skip a null sample: it does not start or clear an alert, and
  it does not reset the consecutive-sample count. Pids are passed through an
  environment variable, never interpolated into the script. Reads are
  serialized, because a check and a restart watch can read at the same time.
- **Windows cannot deliver SIGINT** to the monitor, so `ecosystem.config.cjs`
  sets `shutdown_with_message` and `pm2-monitor.js` also shuts down on the
  `'shutdown'` IPC message. Shutdown force-saves history, then monitor state,
  before it waits for restart watches. A watch blocked in `pm2 jlist` can
  outlast `kill_timeout`. History is not rewritten on every check; monitor
  state is, unless `STATE_SAVE_INTERVAL_MS` says otherwise. A failed write
  clears its timestamp so the next flush retries inside the interval.
- **cmd.exe messages use the console code page** (e.g. CP949), not UTF-8;
  `decodeConsoleOutput` handles that for `jlist` errors.
- **dotenv does not override** variables already set in the process
  environment. That is why `ecosystem.config.cjs` must not set an `env` block
  for settings users configure in `.env`.
- `.env` is loaded relative to `pm2-monitor.js` (`import.meta.url`), not `cwd`.

## Testing

- Prefer behavior tests in `test/monitor.test.js` using `setup()` from
  `test/helpers.js`: set `t.state.processes`, call `t.monitor.runCycle()`,
  `await t.monitor.idle()` for restart watches, then assert on `t.titles()` /
  `t.sent`. `t.advance(ms)` moves the fake clock; `t.state.beforePoll` runs
  before each watch poll; `t.state.fail` makes PM2 fail; `deliver: false` /
  `t.state.deliver` simulates Slack failures. `t.state.logs[path] = [lines]`
  provides error logs (give the process an `errLogPath`), and `t.state.pings`
  counts heartbeats. Pass `monitorState: memoryState()` to continue a second
  `setup()` from the first monitor's saved alerts and baselines.
- To check against a **real PM2 without touching the user's PM2**, install PM2
  in a temporary directory and isolate its daemon with `PM2_HOME`:

  ```bash
  mkdir /tmp/pm2env && cd /tmp/pm2env && npm init -y && npm install pm2@6
  export PM2_HOME=/tmp/pm2env/home
  export PM2_BIN=/tmp/pm2env/node_modules/.bin/pm2      # pm2.cmd on Windows
  $PM2_BIN start some-app.js --name demo
  cd <repo> && npm run dry-run
  $PM2_BIN kill                                          # always clean up
  ```

  For restart flows, run `node pm2-monitor.js --dry-run` with a seconds-based
  schedule (`CRON_SCHEDULE='*/10 * * * * *'`, `RECHECK_INTERVAL_MS=2000`) and
  restart or crash an app while it runs.
- Never put a real Slack webhook in tests, fixtures or commits. Use `--dry-run`.

## Conventions

- Plain JavaScript ES modules, `node:` prefixes for built-ins, 2-space indent,
  single quotes, semicolons. Comments explain *why*, not *what*.
- Log lines use a bracketed tag: `[Check]`, `[Restart]`, `[Notify]`, `[Info]`,
  `[Warn]`, `[Error]`.
- Alert titles are user-visible and appear in tests and the README's alert
  table; change all three together.
- Keep README (users) and this file (contributors) in sync with behavior
  changes, including the "Upgrading" section for anything breaking.
- Commit messages: imperative subject line, a body explaining what and why.
