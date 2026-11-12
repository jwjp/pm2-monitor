# PM2 Slack Monitor

A small Node.js monitor for PM2-managed services. It checks process status,
restart counts, CPU and memory, sends a Slack alert when something needs
attention, and sends a follow-up when the problem clears.

## Features

- **Restart detection** per instance, with follow-up checks until the app is
  stable (all instances online and no further restarts) or the time limit is
  reached. An `errored` instance fails the check immediately.
- **One alert per problem.** Each problem is alerted once when it starts, then
  optionally as a reminder while it lasts (`ALERT_REPEAT_MS`), and once more
  when it is resolved. Crash loops do not flood the channel.
- **Spike filtering.** CPU and memory alerts fire only after
  `RESOURCE_ALERT_SAMPLES` consecutive checks above the threshold.
- **Strict configuration.** Invalid settings stop the monitor at startup with a
  message that names the variable, instead of falling back to a default without
  telling you.
- **Error log excerpts** (opt-in, `RESTART_LOG_LINES`): restart alerts show the
  end of the app's PM2 error log, so the crash reason is visible in Slack.
- **Heartbeat** (`HEARTBEAT_URL`): an external service such as Healthchecks.io
  or an Uptime Kuma push monitor alerts you when the monitor itself stops.
- **Removed apps are reported**, and statuses you do not care about (for
  example `stopped` for apps stopped on purpose) can be ignored.
- **Dry-run mode** to try the monitor without Slack.
- Optional local JSON endpoint with status history (`/status`, `/status/latest`, `/healthz`).

## Requirements

- Node.js 22 or later
- PM2 installed and available on `PATH` (or set `PM2_BIN`)
- A Slack Incoming Webhook URL (not needed for dry runs)

## Quick start

```bash
git clone git@github.com:jwjp/pm2-monitor.git
cd pm2-monitor
npm install
cp .env.example .env        # then set SLACK_WEBHOOK_URL

npm run dry-run             # one check, alerts printed instead of sent
npm run once                # one check, alerts sent to Slack
npm start                   # run under PM2 on the schedule
```

`.env` is loaded from the project directory, so it is found no matter where
PM2 or your shell starts the script. Values already in the process environment
take precedence over `.env`, so avoid setting the same variables in
`ecosystem.config.cjs`.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the monitor under PM2 (`ecosystem.config.cjs`). |
| `npm run once` | Run one check and exit (exit code 1 if PM2 could not be read). |
| `npm run dry-run` | Run one check and print alerts instead of sending them. |
| `npm test` | Run the test suite (Node's built-in test runner). |
| `npm run check` | Syntax check plus tests. |
| `npm run logs` / `restart` / `stop` | PM2 shortcuts. |

The script also accepts `--once` and `--dry-run` directly:
`node pm2-monitor.js --dry-run` runs on the schedule while only logging alerts.

## Alerts

| Alert | When |
| --- | --- |
| Process Restart Detected | An instance's restart count went up since the last check. |
| Restart Successful / Restart Failed | Result of the follow-up checks after a restart. |
| App Recovered | An app whose restart check failed is healthy again, or an app that relapsed has stayed up for `INCIDENT_STABLE_MS`. |
| Process Status Alert → Process Back Online | An instance is not `online` (a change such as `stopping` → `errored` is a new alert). Not sent for a status that "Restart Failed" already reported; its reminders still are. |
| Process Status Cleared | An instance with an open status alert moved to a status in `IGNORE_STATUSES` (e.g. `errored` → `stopped`). |
| App Removed | Every instance of an app left the PM2 process list (`pm2 delete`, or PM2 restarted without it). Its open alerts are closed. Scaling down is not reported. |
| High CPU / Memory Usage → Back to Normal | Above the threshold for `RESOURCE_ALERT_SAMPLES` checks in a row. |
| Monitoring Failed → Monitoring Recovered | `pm2 jlist` could not be run or parsed. |

With `RESTART_LOG_LINES` set, "Process Restart Detected" and "Restart Failed"
end with the last lines of the instance's PM2 error log (`pm2 logs --err`),
cut to about 1500 characters.

The first check after startup only records restart counts, so restarts that
happened before the monitor started are not reported. Checks run only on the
`CRON_SCHEDULE`; with the default business-hours schedule, a restart overnight
is reported at the first check of the next morning (the alert says since when).

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | required | Slack Incoming Webhook URL. Not needed with `DRY_RUN`. |
| `DRY_RUN` | `false` | Log alerts instead of sending them (same as `--dry-run`). |
| `PM2_BIN` | `pm2` (`pm2.cmd` on Windows) | PM2 executable name or path. |
| `CRON_SCHEDULE` | `*/1 8-19 * * 1-5` | Check schedule in node-cron syntax. |
| `CRON_TIMEZONE` | `Asia/Seoul` | IANA time zone for the schedule and alert times. |
| `EXCLUDED_APPS` | `pm2-monitor,pm2-logrotate` | Comma-separated PM2 app names to ignore. |
| `IGNORE_STATUSES` | empty | Comma-separated PM2 statuses that are not reported, e.g. `stopped`. Allowed: `stopped`, `stopping`, `launching`, `errored`, `one-launch-status`, `waiting restart`. An instance in such a status also counts as fine for restart checks. Note that an app with `autorestart: false` that crashes is `stopped` too. |
| `WINDOWS_USAGE_FALLBACK` | `true` | Windows only: when PM2 reports 0 memory for an online process, read CPU/memory from Windows (`Get-Process`) instead. |
| `CPU_THRESHOLD` | `80` | CPU percentage alert threshold. |
| `MEMORY_THRESHOLD_MB` | `450` | Memory alert threshold in MB. |
| `RESOURCE_ALERT_SAMPLES` | `2` | Consecutive checks above a threshold before alerting. |
| `ALERT_REPEAT_MS` | `1800000` (30 min) | Reminder interval while a problem lasts; `0` turns reminders off. `THROTTLE_DURATION_MS` is accepted as the old name (values under 5 min are ignored with a warning). |
| `INCIDENT_STABLE_MS` | `600000` (10 min) | How long an app must stay up after a restart before the incident closes. A restart within this time is reported once as a relapse, and later ones are logged until the app stays up this long. `0` closes the incident at the first success. |
| `RESTART_LOG_LINES` | `0` (off) | Lines of the app's error log to attach to restart alerts (max 50). Logs can contain secrets and are sent to Slack, so this is off by default. |
| `HEARTBEAT_URL` | empty | URL requested (GET) after every check that could read PM2. See [Heartbeat](#heartbeat). Not used by dry or one-off runs. |
| `HEARTBEAT_TIMEOUT_MS` | `10000` | Heartbeat request timeout. |
| `RECHECK_INTERVAL_MS` | `5000` | Interval between follow-up checks after a restart (min 1000). |
| `RECHECK_MAX_ATTEMPTS` | `12` | Number of follow-up checks after a restart. |
| `SLACK_TIMEOUT_MS` | `10000` | Slack request timeout. |
| `RUN_ONCE` | `false` | Run one check and exit (same as `--once`). |
| `WEB_ENABLED` | `true` | Enable the status endpoint and history file. |
| `HOST` | `127.0.0.1` | Bind address for the status endpoint. |
| `PORT` | `3031` | Port for the status endpoint. |
| `STATUS_LOG_FILE` | `./status-history.json` | File the status history is saved to. A relative path is relative to the project directory, like `.env`. |
| `MAX_HISTORY` | `1440` | Number of snapshots to keep. |
| `STATUS_SAVE_INTERVAL_MS` | `300000` (5 min) | How often the history file is rewritten; `0` saves after every check. Unsaved snapshots are written on shutdown. |
| `STATUS_TOKEN` | empty | Bearer token for `/status`. Required when `HOST` is not a loopback address. |

## Heartbeat

The monitor cannot report that it has stopped, so pair it with a heartbeat
("dead man's switch") service: Healthchecks.io, an Uptime Kuma push monitor,
Better Stack, Cronitor and similar. Create a check there, then set its ping URL:

```bash
HEARTBEAT_URL=https://hc-ping.com/<your-uuid>
```

The URL is requested after every check that could read PM2, so the service
alerts you when the monitor process dies, hangs, or loses access to PM2 (that
last case also sends "Monitoring Failed" to Slack). Configure the check with
the same schedule as `CRON_SCHEDULE`; with the default business-hours schedule,
a plain "every minute" check would alert every night. Healthchecks.io accepts
the cron expression and time zone directly. The URL is treated as a secret:
logs show only its origin.

## Status endpoint

```text
GET /healthz              {"ok":true,"lastCycleAt":"…","running":false}  (+ "watchingRestarts" when authorized)
GET /status[?limit=N]     status snapshots, newest first
GET /status/latest        the most recent snapshot, or null
```

Each snapshot looks like
`{"timestamp":"2026-11-12T02:31:00.017Z","processes":[{"pm_id":0,"name":"api","status":"online","restarts":3,"cpu":2,"memory":50,…}]}`.
Timestamps are ISO 8601 in UTC; `memory` is in MB. `cpu` and `memory` are
`null` when the value could not be read (see the Windows note under
[Known limitations](#known-limitations)); they are never reported as `0` in
that case.

By default the endpoint binds to `127.0.0.1`. If you set `HOST=0.0.0.0`, also
set `STATUS_TOKEN`; otherwise `/status` answers 401. `/healthz` needs no token,
but lists the apps under a restart watch (`watchingRestarts`) only to clients
that may read `/status`. One-off runs (`--once`, `npm run dry-run`) neither
start the endpoint nor write `status-history.json`.

```bash
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3031/status?limit=5
```

## Upgrading from 2.x

- **Node.js 22 or later is required.** Node 18 and 20 are end-of-life.
- **"App Removed" is new.** Deleting an app from PM2 (or restarting PM2 without
  it) now sends one alert; it used to be silent.
- Everything else is opt-in: `IGNORE_STATUSES`, `RESTART_LOG_LINES` and
  `HEARTBEAT_URL` are off by default.

## Upgrading from 1.x

- **History timestamps** in `/status` and `status-history.json` are now ISO 8601
  in UTC (`2026-11-12T02:31:00.017Z`) instead of a US-formatted local time.
  Update dashboards that parse the old format.
- **`THROTTLE_DURATION_MS` now means the reminder interval** (it is read as
  `ALERT_REPEAT_MS`). Problems are alerted once when they start and once when
  they clear. A value under 5 minutes, such as the old default `30000`, would
  send a reminder at every check, so it is ignored with a startup warning and
  the 30-minute default is used. Remove it or set `ALERT_REPEAT_MS` instead;
  `ALERT_REPEAT_MS` is always taken as given.
- **The default `CRON_TIMEZONE` is now `Asia/Seoul`** (was `America/New_York`).
  The default schedule therefore runs 08:00–19:59 Korean time on weekdays, and
  alert times are shown in Korean time (as `GMT+9`). Set `CRON_TIMEZONE` to keep another zone.
- **CPU and memory alerts wait for 2 consecutive checks** by default. Set
  `RESOURCE_ALERT_SAMPLES=1` for the old behavior.
- **`.env` is read from the project directory**, not the working directory, and
  `ecosystem.config.cjs` no longer sets `PORT`, `HOST` or `WEB_ENABLED`.
- **Re-create the PM2 process** so the updated `ecosystem.config.cjs` takes
  effect: `pm2 delete pm2-monitor && npm start`, then `pm2 save` if you use
  `pm2 startup`. `pm2 restart` keeps the old process options, including the
  `env` block and without `shutdown_with_message`.
- **Invalid settings stop startup** instead of silently falling back to defaults.
  Run `npm run dry-run` after upgrading to see any configuration errors.
- `/healthz` now also returns `lastCycleAt` and `running`, plus
  `watchingRestarts` for authorized clients.

## Known limitations

- **PM2 reports CPU and memory as 0 on recent Windows 11.** PM2 reads process
  usage through `wmic`, which those builds no longer include. The monitor then
  reads usage from Windows itself (`WINDOWS_USAGE_FALLBACK`, on by default),
  which starts one PowerShell per check. CPU is measured between two readings,
  so the first check after a process starts has `cpu: null`. A failed lookup
  leaves both `cpu` and `memory` as `null` for that check. Those samples are
  skipped, so they do not raise or clear a resource alert. `/status` history
  contains these values; `pm2 ls` still shows 0.
- **A crash loop may never become `errored`.** PM2 only counts a restart against
  `max_restarts` when the process lived shorter than `min_uptime` (1s by
  default). An app that crashes after a few seconds keeps restarting while
  showing `online`. The monitor reports this as one incident and logs later
  restarts quietly until the app is stable or the reminder interval passes.
  If the app crashes during the follow-up checks, that is "Restart Detected"
  followed by "Restart Failed". If it crashes later, after "Restart
  Successful", one more "Restart Detected" says that it restarted again. In
  both cases "App Recovered" follows once it stays up for `INCIDENT_STABLE_MS`.
- **Checks only run on the schedule.** Restarts between checks are counted and
  reported at the next check; the exact time of each restart is not known.

## Development

```bash
npm install
npm test            # unit and integration tests, no PM2 or Slack needed
npm run dry-run     # one real check against the local PM2, alerts printed only
```

See [AGENTS.md](AGENTS.md) for the architecture, design rules and how to test
against a real but isolated PM2 daemon.

## Project layout

```text
pm2-monitor.js     entry point: loads .env, wires everything, schedules checks
src/config.js      reads and validates settings
src/pm2.js         runs `pm2 jlist` and normalizes its output
src/usage.js       CPU/memory from Windows when PM2 cannot read them
src/logs.js        reads the end of an app's error log for restart alerts
src/heartbeat.js   pings HEARTBEAT_URL after each successful check
src/monitor.js     restart detection, follow-up checks, status/resource alerts
src/alerts.js      alert state (start, reminder, resolve)
src/notifier.js    Slack payloads and delivery (or dry-run logging)
src/history.js     in-memory status history persisted to a JSON file
src/server.js      /healthz and /status endpoints
test/              tests (npm test)
```

## Security notes

- Do not commit real Slack webhook URLs. Keep `.env` private; `.env.example` is safe to commit.
- `RESTART_LOG_LINES` sends lines of your apps' error logs to Slack. Enable it
  only if those logs do not contain secrets or personal data.
- `status-history.json` is runtime data and is ignored by Git.
- Keep dependencies patched with Dependabot and `npm audit`.

## License

Unlicense
