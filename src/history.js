import fs from 'node:fs/promises';

/**
 * Keeps status snapshots in memory (newest first) and persists them to a JSON
 * file so history survives restarts. The file is rewritten atomically via a
 * temporary file and rename.
 */
export function createHistory({ file, maxEntries, logger = console }) {
  let entries = [];
  let writing = Promise.resolve();

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
    },

    list(limit = maxEntries) {
      return entries.slice(0, limit);
    },

    /** Writes the history to disk. Writes are serialized and never throw. */
    flush() {
      const data = JSON.stringify(entries);
      writing = writing.then(async () => {
        const tmpFile = `${file}.${process.pid}.tmp`;
        try {
          await fs.writeFile(tmpFile, data);
          await fs.rename(tmpFile, file);
        } catch (error) {
          logger.error(`[Error] Failed to write ${file}: ${error.message}`);
          await fs.rm(tmpFile, { force: true }).catch(() => {});
        }
      });
      return writing;
    },
  };
}
