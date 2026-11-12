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
   * - 'resolve' the condition cleared after it had been notified
   * - null      nothing to send
   */
  evaluate(key, isActive, now, signature = '') {
    const entry = this.active.get(key);

    if (!isActive) {
      if (!entry) return null;
      this.active.delete(key);
      return entry.lastSentAt === null ? null : 'resolve';
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

  since(key) {
    return this.active.get(key)?.since ?? null;
  }

  /** Drops conditions whose key no longer matches a live process, without notifying. */
  prune(keepKey) {
    for (const key of this.active.keys()) {
      if (!keepKey(key)) this.active.delete(key);
    }
  }
}
