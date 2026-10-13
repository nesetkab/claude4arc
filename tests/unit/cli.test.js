import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "claude4arc.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "c4a-"));
fs.mkdirSync(path.join(home, ".arc-bridge"));
const server = net.createServer(() => {});
await new Promise((resolve) => server.listen(path.join(home, ".arc-bridge", "arc.sock"), resolve));

function cliIn(dir, ...args) {
  const env = { ...process.env, HOME: dir };
  delete env.CLAUDE4ARC_BROWSER;
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let bytes = 0;
  let firstByteAt = null;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    firstByteAt ??= Date.now();
    bytes += chunk.length;
    if (stdout.length < 100_000) stdout += chunk;
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, bytes, stdout, stderr, afterOutputMs: Date.now() - (firstByteAt ?? Date.now()) })));
}

const cli = (...args) => cliIn(home, ...args);

test("large output reaches a pipe in full and the process exits", async () => {
  const result = await cli("run", "-e", 'console.log("x".repeat(5_000_000))');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.bytes, 5_000_001);
  assert.ok(result.afterOutputMs < 1500, `exited ${result.afterOutputMs}ms after its output began`);
});

test("a script that leaves a timer running still exits after its output", async () => {
  const result = await cli("run", "-e", 'setInterval(() => {}, 1000); console.log("x".repeat(200_000))');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.bytes, 200_001);
});

test("errors still set a failing exit code", async () => {
  const result = await cli("run", "-e", 'throw new Error("nope")');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Error: nope/);
});

test("install pins a node that survives upgrades and doctor reads it back", async () => {
  const installHome = fs.mkdtempSync(path.join(os.tmpdir(), "c4a-install-"));
  try {
    await cliIn(installHome, "install", "--no-skill");
    const launcher = fs.readFileSync(path.join(installHome, ".arc-bridge", "host-launcher.sh"), "utf8");
    const pinned = /exec '([^']*)'/.exec(launcher)[1];
    assert.equal(fs.realpathSync(pinned), fs.realpathSync(process.execPath));
    if (process.execPath.includes("/Cellar/")) assert.ok(!pinned.includes("/Cellar/"), pinned);
    const doctor = await cliIn(installHome, "doctor");
    assert.match(doctor.stdout, new RegExp(`ok   host node version — ${pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is v`));
  } finally {
    fs.rmSync(installHome, { recursive: true, force: true });
  }
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});
