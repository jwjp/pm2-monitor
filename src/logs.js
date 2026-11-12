import fs from 'node:fs/promises';

const MAX_LINE_LENGTH = 300;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Returns the last `lines` non-empty lines of a log file. Only the end of the
 * file is read (`maxBytes`), because PM2 logs grow without bound unless they
 * are rotated. Colors are stripped and long lines are cut. Throws when the
 * file cannot be read; the caller decides how to report that.
 */
export async function readLogTail(file, lines, { maxBytes = 64 * 1024 } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);

    let text = buffer.toString('utf8');
    // A read that starts mid-file starts mid-line; that partial line is dropped.
    if (length < size) text = text.slice(text.indexOf('\n') + 1);

    return text
      .split(/\r?\n/)
      .map((line) => line.replace(ANSI_PATTERN, '').trimEnd())
      .filter((line) => line.trim() !== '')
      .slice(-lines)
      .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line));
  } finally {
    await handle.close();
  }
}
