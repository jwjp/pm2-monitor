// PM2 process file. Settings live in .env next to this file; see .env.example.
// Avoid setting variables in an `env` block here: values set by PM2 take
// precedence over .env, which makes .env edits silently ineffective.
module.exports = {
  apps: [{
    name: 'pm2-monitor',
    script: './pm2-monitor.js',
    cwd: __dirname,
    watch: false,
    time: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 5000,
    // Stop via a 'shutdown' message rather than SIGINT, which Windows cannot
    // deliver, so the monitor can save its history before exiting.
    shutdown_with_message: true,
  }],
};
