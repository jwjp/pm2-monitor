# PM2 Slack Monitor

A small Node.js monitor for PM2-managed services. It checks process status,
restart counts, CPU, and memory usage, then sends Slack alerts when something
needs attention.

## Features

- Restart detection with follow-up polling until the app stabilizes or times out.
- Cluster-aware restart handling by grouping PM2 instances with the same app name.
- CPU and memory threshold alerts.
- Throttled Slack notifications to avoid repeated identical alerts.
- Optional local `/status` JSON endpoint with status history.
- Environment-driven configuration for production use.

## Requirements

- Node.js 18 or later
- PM2 installed and available on `PATH`
- A Slack Incoming Webhook URL

## Install

```bash
git clone git@github.com:jwjp/pm2-monitor.git
cd pm2-monitor
npm install
```

## Configure

Create a real environment file from the example, or set equivalent variables in
your shell, service manager, or PM2 environment.

```bash
cp .env.example .env
```

Required:

```env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

The script loads `.env` automatically through `dotenv`. Values provided by the
real process environment still take precedence.

## Run

```bash
npm start
```

Useful commands:

```bash
npm run logs
npm run restart
npm run stop
npm run check
npm run audit
```

## Configuration Reference

| Variable | Default | Description |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | required | Slack Incoming Webhook URL. |
| `PM2_BIN` | `pm2` or `pm2.cmd` on Windows | PM2 executable name or path. |
| `CRON_SCHEDULE` | `*/1 8-19 * * 1-5` | Monitor schedule in node-cron syntax. |
| `CRON_TIMEZONE` | `America/New_York` | Time zone used for scheduling and timestamps. |
| `EXCLUDED_APPS` | `pm2-monitor,pm2-logrotate` | Comma-separated PM2 app names to ignore. |
| `CPU_THRESHOLD` | `80` | CPU percentage alert threshold. |
| `MEMORY_THRESHOLD_MB` | `450` | Memory alert threshold in MB. |
| `THROTTLE_DURATION_MS` | `30000` | Minimum interval for identical Slack alerts. |
| `RECHECK_INTERVAL_MS` | `5000` | Restart polling interval. |
| `RECHECK_MAX_ATTEMPTS` | `12` | Restart polling attempt limit. |
| `SLACK_TIMEOUT_MS` | `10000` | Slack request timeout. |
| `RUN_ONCE` | `false` | Run one monitoring cycle and exit. Useful for smoke tests. |
| `WEB_ENABLED` | `true` | Enable the status HTTP endpoint. |
| `HOST` | `127.0.0.1` | Bind address for the status endpoint. |
| `PORT` | `3031` | Port for the status endpoint. |
| `STATUS_LOG_FILE` | `./status-history.json` | Runtime status history file. |
| `MAX_HISTORY` | `1440` | Number of status snapshots to retain. |
| `STATUS_TOKEN` | empty | Optional bearer/query token for `/status`. |

## Status Endpoint

When enabled, the monitor exposes:

```text
GET /healthz
GET /status
```

By default it binds to `127.0.0.1` to avoid exposing process details publicly.
If you set `HOST=0.0.0.0`, also set `STATUS_TOKEN`.

With a token:

```bash
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3031/status
```

## Security Notes

- Do not commit real Slack webhook URLs.
- Keep `.env` private. `.env.example` is safe to commit.
- `status-history.json` is runtime data and is ignored by Git.
- Keep dependencies patched with Dependabot and `npm audit`.

## License

Unlicense
