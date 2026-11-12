import axios from 'axios';

/**
 * Pings an external heartbeat URL (Healthchecks.io, Uptime Kuma push monitors,
 * Better Stack, ...) after each successful check. The monitor cannot report its
 * own death, so that service alerts when the pings stop. `ping` resolves to
 * true when the ping was accepted and never throws.
 */
export function createHeartbeat({ url, timeoutMs, logger = console, get = axios.get }) {
  // Heartbeat URLs usually carry a secret token, so logs show only the origin.
  const shown = new URL(url).origin;
  let failing = false;

  return {
    async ping() {
      try {
        await get(url, { timeout: timeoutMs, validateStatus: (status) => status >= 200 && status < 300 });
        if (failing) logger.log(`[Info] Heartbeat to ${shown} is delivered again.`);
        failing = false;
        return true;
      } catch (error) {
        // Warn once per outage; a check every minute would otherwise repeat it each time.
        if (!failing) logger.warn(`[Warn] Heartbeat to ${shown} failed: ${error.message}`);
        failing = true;
        return false;
      }
    },
  };
}
