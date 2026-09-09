// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'pm2-monitor',
    script: './pm2-monitor.js',
    watch: false,
    time: true,
    env: {
      PORT: 3031,
      HOST: '127.0.0.1',
      WEB_ENABLED: 'true'
    },
  }]
};
