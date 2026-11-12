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
| `CRON_TIMEZONE` | `America/New_York` | IANA time zone for the schedule and alert times. |
| `EXCLUDED_APPS` | `pm2-monitor,pm2-logrotate` | Comma-separated PM2 app names to ignore. |
| `CPU_THRESHOLD` | `80` | CPU percentage alert threshold. |
| `MEMORY_THRESHOLD_MB` | `450` | Memory alert threshold in MB. |
| `RESOURCE_ALERT_SAMPLES` | `2` | Consecutive checks above a threshold before alerting. |
| `ALERT_REPEAT_MS` | `1800000` (30 min) | Reminder interval while a problem lasts; `0` turns reminders off. `THROTTLE_DURATION_MS` is accepted as the old name. |
| `RECHECK_INTERVAL_MS` | `5000` | Interval between follow-up checks after a restart (min 1000). |
| `RECHECK_MAX_ATTEMPTS` | `12` | Number of follow-up checks after a restart. |
| `SLACK_TIMEOUT_MS` | `10000` | Slack request timeout. |
| `RUN_ONCE` | `false` | Run one check and exit (same as `--once`). |
| `WEB_ENABLED` | `true` | Enable the status endpoint and history file. |
| `HOST` | `127.0.0.1` | Bind address for the status endpoint. |
| `PORT` | `3031` | Port for the status endpoint. |
| `STATUS_LOG_FILE` | `./status-history.json` | File the status history is saved to. |
| `MAX_HISTORY` | `1440` | Number of snapshots to keep. |
| `STATUS_TOKEN` | empty | Bearer token for `/status`. Required when `HOST` is not a loopback address. |

## Status endpoint

```text
GET /healthz              {"ok":true,"lastCycleAt":"…","running":false,"watchingRestarts":[]}
GET /status[?limit=N]     status snapshots, newest first
GET /status/latest        the most recent snapshot, or null
```

Each snapshot looks like
`{"timestamp":"2026-11-12T02:31:00.017Z","processes":[{"pm_id":0,"name":"api","status":"online","restarts":3,"cpu":2,"memory":50,…}]}`.
Timestamps are ISO 8601 in UTC; `memory` is in MB.

By default the endpoint binds to `127.0.0.1`. If you set `HOST=0.0.0.0`, also
set `STATUS_TOKEN`; otherwise `/status` answers 401.

```bash
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3031/status?limit=5
```

## Project layout

```text
pm2-monitor.js     entry point: loads .env, wires everything, schedules checks
src/config.js      reads and validates settings
src/pm2.js         runs `pm2 jlist` and normalizes its output
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
