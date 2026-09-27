import fs from "node:fs/promises";
import path from "node:path";
import { STATE_DIR, LOG_PATH } from "./paths.js";

const HOUR = 3_600_000;

export const SCREENSHOT_DIR = path.join(STATE_DIR, "screenshots");
export const SCREENSHOT_LIMITS = { maxAge: 24 * HOUR, keep: 100 };
export const LOG_LIMIT = 512 * 1024;

async function filesIn(directory) {
  const names = await fs.readdir(directory).catch(() => []);
  const entries = await Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name);
      const stat = await fs.stat(file).catch(() => null);
      return stat?.isFile() ? { file, name, mtime: stat.mtimeMs } : null;
    }),
  );
  return entries.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

export function expired(entries, { maxAge, keep, now = Date.now() }) {
  return entries.filter((entry, index) => index >= keep || now - entry.mtime > maxAge);
}

export async function pruneScreenshots({ all = false, now = Date.now() } = {}) {
  const entries = await filesIn(SCREENSHOT_DIR);
  const doomed = all ? entries : expired(entries, { ...SCREENSHOT_LIMITS, now });
  await Promise.all(doomed.map((entry) => fs.rm(entry.file, { force: true })));
  return doomed.length;
}

export async function pruneTempFiles({ now = Date.now() } = {}) {
  const entries = await filesIn(STATE_DIR);
  const doomed = entries.filter((entry) => entry.name.endsWith(".tmp") && now - entry.mtime > HOUR);
  await Promise.all(doomed.map((entry) => fs.rm(entry.file, { force: true })));
  return doomed.length;
}

export async function rotateLog(limit = LOG_LIMIT) {
  const stat = await fs.stat(LOG_PATH).catch(() => null);
  if (!stat || stat.size <= limit) return false;
  await fs.rename(LOG_PATH, `${LOG_PATH}.1`);
  return true;
}
