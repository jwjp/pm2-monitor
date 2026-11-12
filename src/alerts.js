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
}
