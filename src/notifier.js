import axios from 'axios';

const LEVELS = {
  good: { color: 'good', icon: ':white_check_mark:' },
  warning: { color: 'warning', icon: ':warning:' },
  danger: { color: 'danger', icon: ':rotating_light:' },
};

/**
 * Sends alerts to Slack. In dry-run mode alerts are only logged, which makes it
 * easy to try the monitor without a webhook. `send` resolves to true when the
 * alert was delivered (or logged in dry-run mode) and never throws.
 */
export function createNotifier({ webhookUrl, timeoutMs, dryRun = false, timezone, logger = console, post = axios.post }) {
  return {
    async send({ app, title, message, level = 'danger', now = new Date() }) {
      const prefix = dryRun ? '[Notify:dry-run]' : '[Notify]';
      logger.log(`${prefix} ${level.toUpperCase()} [${app}] ${title}: ${message.replace(/\n/g, ' | ')}`);
      if (dryRun) return true;

      try {
        await post(webhookUrl, buildSlackPayload({ app, title, message, level, now, timezone }), {
          timeout: timeoutMs,
          validateStatus: (status) => status >= 200 && status < 300,
        });
        return true;
      } catch (error) {
        logger.error(`[Error] Failed to send Slack notification "${title}" for ${app}: ${error.message}`);
        return false;
      }
    },
  };
}

export function buildSlackPayload({ app, title, message, level, now, timezone }) {
  const { color, icon } = LEVELS[level] || LEVELS.danger;
  const header = truncate(`${icon} [PM2] ${title}`, 150);

  return {
    text: `[PM2] ${title}: ${app}`,
    attachments: [{
      color,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*App:*\n\`${escapeMrkdwn(app)}\`` },
            { type: 'mrkdwn', text: `*Time:*\n${formatTime(now, timezone)}` },
          ],
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: truncate(escapeMrkdwn(message), 3000) } },
      ],
    }],
  };
}

export function formatTime(date, timezone) {
  return date.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' });
}

function escapeMrkdwn(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
