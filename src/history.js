import fs from 'node:fs/promises';

/**
 * Keeps status snapshots in memory (newest first) and persists them to a JSON
 * file so history survives restarts. The file is rewritten atomically via a
 * temporary file and rename.
 */
export function createHistory({ file, maxEntries, saveIntervalMs = 0, now = () => Date.now(), logger = console }) {
  let entries = [];
  let writing = Promise.resolve();
  let savedAt = null;
  let dirty = false;

  return {
    async load() {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
        if (Array.isArray(parsed)) {
          entries = parsed.slice(0, maxEntries);
        } else {
          logger.warn(`[Warn] ${file} does not contain a JSON array. Starting a new history.`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn(`[Warn] Could not read ${file}: ${error.message}. Starting a new history.`);
        }
      }
    },

    add(snapshot) {
      entries.unshift(snapshot);
      if (entries.length > maxEntries) entries.length = maxEntries;
      dirty = true;
    },

    list(limit = maxEntries) {
      return entries.slice(0, limit);
    },

    /**
     * Writes the history to disk. Writes are serialized and never throw. The
     * whole file is rewritten each time, so unless `force` is set it is saved
     * at most every `saveIntervalMs`; the shutdown path forces a final save.
     */
    flush({ force = false } = {}) {
      if (!dirty) return writing;
      if (!force && savedAt !== null && now() - savedAt < saveIntervalMs) return writing;
      savedAt = now();
      dirty = false;
      const data = JSON.stringify(entries);
      writing = writing.then(async () => {
        const tmpFile = `${file}.${process.pid}.tmp`;
        try {
          await fs.writeFile(tmpFile, data);
          await fs.rename(tmpFile, file);
        } catch (error) {
          logger.error(`[Error] Failed to write ${file}: ${error.message}`);
          dirty = true;
          // savedAt was set before the write. Clear it so the next flush retries
          // inside the interval instead of waiting out a save that never landed.
          savedAt = null;
          await fs.rm(tmpFile, { force: true }).catch(() => {});
        }
      });
      return writing;
    },
  };
}
