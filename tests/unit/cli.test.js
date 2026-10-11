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

function cli(...args) {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE4ARC_BROWSER;
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let bytes = 0;
  let stderr = "";
  child.stdout.on("data", (chunk) => (bytes += chunk.length));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const started = Date.now();
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, bytes, stderr, ms: Date.now() - started })));
}

test("large output reaches a pipe in full and the process exits", async () => {
  const result = await cli("run", "-e", 'console.log("x".repeat(5_000_000))');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.bytes, 5_000_001);
  assert.ok(result.ms < 2000, `took ${result.ms}ms`);
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

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});
