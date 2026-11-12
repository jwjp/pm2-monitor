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
- **Dry-run mode** to try the monitor without Slack.
- Optional local JSON endpoint with status history (`/status`, `/status/latest`, `/healthz`).

## Requirements

- Node.js 18 or later
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
| App Recovered | An app whose restart check failed is healthy again. |
| Process Status Alert → Process Back Online | An instance is not `online` (a change such as `stopping` → `errored` is a new alert). |
| High CPU / Memory Usage → Back to Normal | Above the threshold for `RESOURCE_ALERT_SAMPLES` checks in a row. |
| Monitoring Failed → Monitoring Recovered | `pm2 jlist` could not be run or parsed. |

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
| `WINDOWS_USAGE_FALLBACK` | `true` | Windows only: when PM2 reports 0 memory for an online process, read CPU/memory from Windows (`Get-Process`) instead. |
| `CPU_THRESHOLD` | `80` | CPU percentage alert threshold. |
| `MEMORY_THRESHOLD_MB` | `450` | Memory alert threshold in MB. |
| `RESOURCE_ALERT_SAMPLES` | `2` | Consecutive checks above a threshold before alerting. |
| `ALERT_REPEAT_MS` | `1800000` (30 min) | Reminder interval while a problem lasts; `0` turns reminders off. `THROTTLE_DURATION_MS` is accepted as the old name (values under 5 min are ignored with a warning). |
| `RECHECK_INTERVAL_MS` | `5000` | Interval between follow-up checks after a restart (min 1000). |
| `RECHECK_MAX_ATTEMPTS` | `12` | Number of follow-up checks after a restart. |
| `SLACK_TIMEOUT_MS` | `10000` | Slack request timeout. |
| `RUN_ONCE` | `false` | Run one check and exit (same as `--once`). |
| `WEB_ENABLED` | `true` | Enable the status endpoint and history file. |
| `HOST` | `127.0.0.1` | Bind address for the status endpoint. |
| `PORT` | `3031` | Port for the status endpoint. |
| `STATUS_LOG_FILE` | `./status-history.json` | File the status history is saved to. |
| `MAX_HISTORY` | `1440` | Number of snapshots to keep. |
| `STATUS_SAVE_INTERVAL_MS` | `300000` (5 min) | How often the history file is rewritten; `0` saves after every check. Unsaved snapshots are written on shutdown. |
| `STATUS_TOKEN` | empty | Bearer token for `/status`. Required when `HOST` is not a loopback address. |

## Status endpoint

```text
GET /healthz              {"ok":true,"lastCycleAt":"…","running":false}  (+ "watchingRestarts" when authorized)
GET /status[?limit=N]     status snapshots, newest first
GET /status/latest        the most recent snapshot, or null
```

Each snapshot looks like
`{"timestamp":"2026-11-12T02:31:00.017Z","processes":[{"pm_id":0,"name":"api","status":"online","restarts":3,"cpu":2,"memory":50,…}]}`.
Timestamps are ISO 8601 in UTC; `memory` is in MB.

By default the endpoint binds to `127.0.0.1`. If you set `HOST=0.0.0.0`, also
set `STATUS_TOKEN`; otherwise `/status` answers 401. `/healthz` needs no token,
but lists the apps under a restart watch (`watchingRestarts`) only to clients
that may read `/status`. One-off runs (`--once`, `npm run dry-run`) neither
start the endpoint nor write `status-history.json`.

```bash
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3031/status?limit=5
```

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
  alert times are shown in KST. Set `CRON_TIMEZONE` to keep another zone.
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
  so the first check after a process starts shows 0% CPU. `/status` history
  contains the corrected values; `pm2 ls` still shows 0.
- **A crash loop may never become `errored`.** PM2 only counts a restart against
  `max_restarts` when the process lived shorter than `min_uptime` (1s by
  default). An app that crashes after a few seconds keeps restarting while
  showing `online`. The monitor reports this as one incident ("Restart
  Detected" followed by "Restart Failed") and logs later restarts quietly
  until the app is stable or the reminder interval passes.
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
src/monitor.js     restart detection, follow-up checks, status/resource alerts
src/alerts.js      alert state (start, reminder, resolve)
src/notifier.js    Slack payloads and delivery (or dry-run logging)
src/history.js     in-memory status history persisted to a JSON file
src/server.js      /healthz and /status endpoints
test/              tests (npm test)
```

## Security notes

- Do not commit real Slack webhook URLs. Keep `.env` private; `.env.example` is safe to commit.
- `status-history.json` is runtime data and is ignored by Git.
- Keep dependencies patched with Dependabot and `npm audit`.

## License

Unlicense
