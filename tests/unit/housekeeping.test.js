import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude4arc-home-"));
process.env.HOME = home;
const { expired, pruneScreenshots, pruneTempFiles, SCREENSHOT_DIR } = await import("../../lib/housekeeping.js");

const HOUR = 3_600_000;

test("expired keeps the newest files inside the age limit", () => {
  const now = 10 * 24 * HOUR;
  const entries = [0, 1, 2, 30].map((hours) => ({ name: `${hours}`, mtime: now - hours * HOUR }));
  assert.deepEqual(expired(entries, { maxAge: 24 * HOUR, keep: 100, now }).map((entry) => entry.name), ["30"]);
  assert.deepEqual(expired(entries, { maxAge: 24 * HOUR, keep: 2, now }).map((entry) => entry.name), ["2", "30"]);
});

test("pruneScreenshots deletes old screenshots and keeps recent ones", async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const old = path.join(SCREENSHOT_DIR, "old.jpg");
  const fresh = path.join(SCREENSHOT_DIR, "fresh.jpg");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(fresh, "x");
  const past = new Date(Date.now() - 48 * HOUR);
  fs.utimesSync(old, past, past);
  assert.equal(await pruneScreenshots(), 1);
  assert.deepEqual(fs.readdirSync(SCREENSHOT_DIR), ["fresh.jpg"]);
  assert.equal(await pruneScreenshots({ all: true }), 1);
  assert.deepEqual(fs.readdirSync(SCREENSHOT_DIR), []);
});

test("pruneTempFiles removes only stale .tmp files", async () => {
  const state = path.dirname(SCREENSHOT_DIR);
  const stale = path.join(state, "tasks.json.1.2.tmp");
  const recent = path.join(state, "tasks.json.3.4.tmp");
  const keep = path.join(state, "tasks.json");
  for (const file of [stale, recent, keep]) fs.writeFileSync(file, "{}");
  const past = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(stale, past, past);
  fs.utimesSync(keep, past, past);
  assert.equal(await pruneTempFiles(), 1);
  assert.ok(fs.existsSync(recent) && fs.existsSync(keep) && !fs.existsSync(stale));
});
