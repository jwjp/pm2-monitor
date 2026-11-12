import axios from 'axios';

const LEVELS = {
  good: { color: 'good', discordColor: 0x2eb886, icon: ':white_check_mark:' },
  warning: { color: 'warning', discordColor: 0xdaa038, icon: ':warning:' },
  danger: { color: 'danger', discordColor: 0xa30200, icon: ':rotating_light:' },
};

/**
 * Sends alerts to Slack and/or Discord. In dry-run mode alerts are only logged,
 * which makes it easy to try the monitor without a webhook. `send` resolves to
 * true when the alert was delivered (or logged in dry-run mode) and never throws.
 */
export function createNotifier({
  webhookUrl,
  timeoutMs,
  slack = null,
  discord = null,
  dryRun = false,
  timezone,
  logger = console,
  post = axios.post,
}) {
  const slackUrl = slack?.webhookUrl || webhookUrl;
  const slackTimeout = slack?.timeoutMs || timeoutMs || 10 * 1000;
  const discordUrl = discord?.webhookUrl;
  const discordTimeout = discord?.timeoutMs || 10 * 1000;

  return {
    async send({ app, title, message, level = 'danger', now = new Date() }) {
      const prefix = dryRun ? '[Notify:dry-run]' : '[Notify]';
      logger.log(`${prefix} ${level.toUpperCase()} [${app}] ${title}: ${message.replace(/\n/g, ' | ')}`);
      if (dryRun) return true;

      const targets = [];
      if (slackUrl) {
        targets.push({
          name: 'Slack',
          url: slackUrl,
          timeout: slackTimeout,
          payload: buildSlackPayload({ app, title, message, level, now, timezone }),
        });
      }
      if (discordUrl) {
        targets.push({
          name: 'Discord',
          url: discordUrl,
          timeout: discordTimeout,
          payload: buildDiscordPayload({ app, title, message, level, now, timezone }),
        });
      }

      if (targets.length === 0) return true;

      const results = await Promise.all(targets.map(async (target) => {
        try {
          await post(target.url, target.payload, {
            timeout: target.timeout,
            validateStatus: (status) => status >= 200 && status < 300,
          });
          return true;
        } catch (error) {
          logger.error(`[Error] Failed to send ${target.name} notification "${title}" for ${app}: ${error.message}`);
          return false;
        }
      }));

      return results.every(Boolean);
    },
  };
}

export function buildSlackPayload({ app, title, message, level, now, timezone }) {
  const { color, icon } = LEVELS[level] || LEVELS.danger;
  const header = truncate(`${icon} [PM2] ${title}`, 150);

  return {
    // The fallback text is parsed as mrkdwn too, so an app name like <!channel> must not ping anyone.
    text: escapeMrkdwn(`[PM2] ${title}: ${app}`),
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

export function buildDiscordPayload({ app, title, message, level, now, timezone }) {
  const { discordColor, icon } = LEVELS[level] || LEVELS.danger;
  return {
    content: `[PM2] ${title}: ${app}`,
    embeds: [{
      title: truncate(`${icon} [PM2] ${title}`, 256),
      description: truncate(message, 4000),
      color: discordColor,
      fields: [
        { name: 'App', value: `\`${app}\``, inline: true },
        { name: 'Time', value: formatTime(now, timezone), inline: true },
      ],
      timestamp: (now instanceof Date ? now : new Date(now)).toISOString(),
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
