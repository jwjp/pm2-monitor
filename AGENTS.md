# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.
User-facing documentation lives in [README.md](README.md); this file covers how
the code works and how to change it safely.

## What this is

A Node.js (ESM, Node >= 18) service that runs under PM2, polls `pm2 jlist` on a
cron schedule, and sends Slack alerts for restarts, non-`online` status, and
high CPU/memory. It sends a follow-up when each problem clears, and can serve
the status history as JSON over HTTP.

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

## Layout

```text
pm2-monitor.js     entry point: loads .env, validates config, wires modules,
                   runs the first check, schedules the rest, handles SIGINT/SIGTERM
src/config.js      loadConfig(env, argv) -> { config, errors }; pure, no side effects
src/pm2.js         listPm2Processes(config), parseJlist(stdout, excludedApps)
src/monitor.js     createMonitor({...}): restart detection, restart watches,
                   status/resource conditions, incidents; the core logic
src/alerts.js      AlertTracker: per-condition state (fire / repeat / resolve)
src/notifier.js    createNotifier({...}).send(alert) -> Promise<boolean>; Slack payloads
src/history.js     in-memory history (newest first), atomic JSON file persistence
src/server.js      createStatusServer({...}): /healthz, /status, /status/latest
test/helpers.js    setup(): monitor with fake PM2 state, clock, sleep and notifier
test/*.test.js     monitor behavior, server, config/pm2/alerts/notifier units
```

## Design rules (keep these when changing code)

1. **Inject side effects.** `createMonitor` receives `listProcesses`, `notifier`,
   `history`, `now`, `sleep` and `logger`. Never call PM2, Slack, `Date.now()` or
   timers directly inside `src/monitor.js`; otherwise the tests cannot control them.
2. **One alert per problem.** Every condition goes through `AlertTracker` with a
   stable key: `"<app>#<pm_id>::status|cpu|memory"` or `"monitor::pm2"`.
   - `fire` when a condition starts or its signature changes (e.g. status
     `stopping` -> `errored`),
   - `repeat` after `alertRepeatMs` while it lasts (0 disables reminders),
   - `resolve` when it clears, but only if the alert was actually delivered.
   Call `markSent` only after a successful send, so failed deliveries are retried.
   Do not reintroduce a plain time-based throttle.
3. **Restarts are tracked per instance** (`<name>#<pm_id>`) and grouped per app.
   The first check after startup only sets the baseline. A lower restart count
   (e.g. after `pm2 reset`) resets the baseline without alerting.
4. **Restart watches** (`watchRestart`) poll every `recheck.intervalMs` up to
   `recheck.maxAttempts` times. Success requires every instance `online` *and*
   no new restarts since the previous poll. `errored` fails immediately. While
   a watch runs, `checkInstances` skips that app so it is not reported twice.
5. **Incidents** (`incidents` map) group a crash loop: after one "Restart
   Detected" and one "Restart Failed", later restarts are only logged until the
   app is stable ("Restart Successful" / "App Recovered") or the reminder
   interval passes.
6. **Never throw out of a cycle.** `notifier.send` returns `false` instead of
   throwing, `history.flush` logs instead of throwing, and `runCycle` turns PM2
   failures into the `monitor::pm2` condition. `runCycle` skips itself if the
   previous run is still in progress.
7. **Config fails loudly.** Add new settings in `src/config.js` through the
   `string/number/boolean/list` helpers with explicit bounds; invalid values
   must become an entry in `errors`, not a silent fallback. Document every new
   variable in `README.md` (configuration table) and `.env.example`.
8. **HTTP server**: parse URLs against a fixed base (`http://localhost`), never
   the `Host` header (a malformed Host used to crash the process). `/status`
   needs a Bearer token compared with `timingSafeEqual`, or a loopback bind
   address when no token is set. Do not accept tokens in query strings.

## Platform gotchas

- **Windows + PM2**: `pm2` is a `.cmd` shim, so `src/pm2.js` runs it as
  `cmd.exe /d /s /c ""<PM2_BIN>" jlist"` with `windowsVerbatimArguments`. The
  double quoting is deliberate; it keeps `PM2_BIN` paths with spaces working.
- **`pm2 jlist` may print notices** (`[PM2] In-memory PM2 is out-of-date`)
  before the JSON; `parseJlist` handles this. Keep a test for it.
- **CPU/memory are 0 on recent Windows 11** because PM2's `wmic`-based usage
  reading is unavailable. This is not a parsing bug; check the raw `jlist`.
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
  `t.state.deliver` simulates Slack failures.
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
