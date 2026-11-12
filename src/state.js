import fs from 'node:fs/promises';

export const STATE_VERSION = 1;

/**
 * Persists the monitor's alert and incident state so a process restart
 * continues open problems instead of treating the next check as the first.
 * The file is rewritten atomically via a temporary file and rename. Writes are
 * serialized and never throw, matching src/history.js.
 */
export function createMonitorState({ file, saveIntervalMs = 0, now = () => Date.now(), logger = console }) {
  let writing = Promise.resolve();
  let savedAt = null;
  let dirty = false;
  let latest = null;

  const store = {
    async load() {
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn(`[Warn] Could not read ${file}: ${error.message}. Starting from a baseline.`);
        }
        return null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== STATE_VERSION) {
        logger.warn(`[Warn] ${file} has an unsupported monitor state version. Starting from a baseline.`);
        return null;
      }
      return parsed;
    },

    /**
     * Remembers `snapshot` and writes it. Unless `force` is set, the file is
     * rewritten at most every `saveIntervalMs`. A failed write is retried on
     * the next call instead of waiting out the interval.
     */
    save(snapshot, { force = false } = {}) {
      latest = snapshot;
      dirty = true;
      if (!force && savedAt !== null && now() - savedAt < saveIntervalMs) return writing;
      return writeLatest();
    },

    /** Writes the newest snapshot again. Shutdown passes `force`. */
    flush({ force = false } = {}) {
      if (latest === null) return writing;
      return store.save(latest, { force });
    },
  };

  return store;

  function writeLatest() {
    if (!dirty || latest === null) return writing;
    savedAt = now();
    dirty = false;
    // Captured now, so a snapshot taken later is not lost in this write: it
    // marks `dirty` again and the next save persists it.
    const data = `${JSON.stringify(latest)}\n`;
    writing = writing.then(async () => {
      const tmpFile = `${file}.${process.pid}.tmp`;
      try {
        await fs.writeFile(tmpFile, data);
        await fs.rename(tmpFile, file);
      } catch (error) {
        logger.error(`[Error] Failed to write ${file}: ${error.message}`);
        dirty = true;
        // savedAt was set before the write. Clear it so the next save retries
        // inside the interval instead of waiting out a save that never landed.
        savedAt = null;
        await fs.rm(tmpFile, { force: true }).catch(() => {});
      }
    });
    return writing;
  }
}
