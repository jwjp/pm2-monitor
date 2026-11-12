/**
 * Tracks ongoing alert conditions so that each problem is reported once when
 * it starts, optionally repeated as a reminder, and reported again when it
 * clears. This replaces a plain time-based throttle, which re-sent the same
 * alert every cycle whenever the throttle window was shorter than the schedule.
 */
export class AlertTracker {
  constructor({ repeatMs = 0 } = {}) {
    this.repeatMs = repeatMs;
    this.active = new Map();
  }

  /**
   * Returns what to notify for `key` at `now`:
   * - 'fire'    the condition is new (or its signature changed), or a previous send failed
   * - 'repeat'  the condition is still active and the reminder interval has passed
   * - 'resolve' the condition cleared after it had been notified; it is
   *             returned again on later checks until `markResolved` is called
   * - null      nothing to send
   */
  evaluate(key, isActive, now, signature = '') {
    const entry = this.active.get(key);

    if (!isActive) {
      if (!entry) return null;
      if (entry.lastSentAt === null) {
        this.active.delete(key);
        return null;
      }
      // Kept until the resolve is delivered, so a failed send is retried.
      entry.resolving = true;
      return 'resolve';
    }

    if (entry?.resolving) {
      // The problem came back before its resolve was delivered. For the
      // recipient it never ended, so it continues as the same alert.
      entry.resolving = false;
      if (entry.signature === signature) {
        return this.repeatMs > 0 && now - entry.lastSentAt >= this.repeatMs ? 'repeat' : null;
      }
    }

    if (!entry || entry.signature !== signature) {
      this.active.set(key, { since: now, lastSentAt: null, signature });
      return 'fire';
    }

    if (entry.lastSentAt === null) return 'fire';
    if (this.repeatMs > 0 && now - entry.lastSentAt >= this.repeatMs) return 'repeat';
    return null;
  }

  markSent(key, now) {
    const entry = this.active.get(key);
    if (entry) entry.lastSentAt = now;
  }

  /**
   * Records an active condition as already notified, because another alert
   * delivered at `now` covered it. Leaves a condition that is already tracked alone.
   */
  adopt(key, signature, now) {
    if (this.active.has(key)) return;
    this.active.set(key, { since: now, lastSentAt: now, signature });
  }

  /** Forgets a condition once its resolve has been delivered. */
  markResolved(key) {
    this.active.delete(key);
  }

  since(key) {
    return this.active.get(key)?.since ?? null;
  }

  /** Drops conditions whose key no longer matches a live process, without notifying. */
  prune(keepKey) {
    for (const key of this.active.keys()) {
      if (!keepKey(key)) this.active.delete(key);
    }
  }

  /** Plain data for the state file. `lastSentAt` stays null until a send lands. */
  exportState() {
    return [...this.active.entries()].map(([key, entry]) => ({
      key,
      since: entry.since,
      lastSentAt: entry.lastSentAt,
      signature: entry.signature ?? '',
      resolving: entry.resolving === true,
    }));
  }

  /**
   * Restores conditions saved by `exportState`. Malformed entries are skipped.
   * A pending resolve is only kept when the alert was actually sent.
   */
  importState(entries) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || entry.key === '') continue;
      if (typeof entry.since !== 'number' || !Number.isFinite(entry.since)) continue;
      const lastSentAt = typeof entry.lastSentAt === 'number' && Number.isFinite(entry.lastSentAt) ? entry.lastSentAt : null;
      this.active.set(entry.key, {
        since: entry.since,
        lastSentAt,
        signature: typeof entry.signature === 'string' ? entry.signature : '',
        resolving: entry.resolving === true && lastSentAt !== null,
      });
    }
  }
}
