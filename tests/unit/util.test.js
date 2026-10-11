import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { normalizeUrl, urlMatches, poll, fatal, withTimeout, shellQuote, stableNode, versionedNodePath, launcherScript } from "../../lib/util.js";

test("normalizeUrl adds a scheme only when one is missing", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("localhost:3000/a"), "http://localhost:3000/a");
  assert.equal(normalizeUrl("127.0.0.1:8900"), "http://127.0.0.1:8900");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.equal(normalizeUrl("http://a.test"), "http://a.test");
  assert.equal(normalizeUrl("example.com:8443/x"), "https://example.com:8443/x");
  assert.equal(normalizeUrl("[::1]:8080"), "http://[::1]:8080");
  assert.equal(normalizeUrl("mailto:a@b.test"), "mailto:a@b.test");
});

test("urlMatches handles substrings, globs, regexes, and functions", () => {
  assert.ok(urlMatches("https://a.test/done?x=1", "/done"));
  assert.ok(urlMatches("https://a.test/done", "https://a.test/*"));
  assert.ok(!urlMatches("https://b.test/done", "https://a.test/*"));
  assert.ok(urlMatches("https://a.test/42", /\/\d+$/));
  assert.ok(urlMatches("https://a.test", (url) => url.startsWith("https")));
});

test("poll retries until the check passes", async () => {
  let calls = 0;
  const value = await poll(async () => (++calls >= 3 ? "ready" : null), { timeout: 1000, interval: 5, message: "never" });
  assert.equal(value, "ready");
  assert.equal(calls, 3);
});

test("poll stops at once on a fatal error and times out otherwise", async () => {
  await assert.rejects(poll(async () => { throw fatal(new Error("stop")); }, { timeout: 1000, interval: 5, message: "x" }), /stop/);
  await assert.rejects(poll(async () => null, { timeout: 30, interval: 5, message: "gave up" }), /gave up/);
});

test("withTimeout rejects a slow promise", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "too slow"), /too slow/);
  assert.equal(await withTimeout(Promise.resolve(7), 20, "x"), 7);
});

test("shellQuote survives the shell unchanged", () => {
  for (const value of ["/usr/local/bin/node", "/Users/a b/node", `/x/$HOME/\`id\`/"q"/\\/it's`, ""]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }), value);
  }
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "c4a node "));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fakeNode(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\necho "${version} $*"\n`, { mode: 0o755 });
  return file;
}

test("a Homebrew Cellar node is pinned through a stable symlink", () => {
  const root = path.join(scratch, "brew");
  const cellar = fakeNode(path.join(root, "Cellar", "node", "26.5.0", "bin", "node"), "26.5.0");
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync(cellar, path.join(root, "bin", "node"));
  fs.mkdirSync(path.join(root, "opt"));
  fs.symlinkSync(path.join(root, "Cellar", "node", "26.5.0"), path.join(root, "opt", "node"));
  const other = fakeNode(path.join(root, "other", "node"), "24.0.0");
  assert.equal(stableNode(cellar, [null, other, path.join(root, "bin", "node")]), path.join(root, "bin", "node"));
  assert.equal(stableNode(cellar, [other]), path.join(root, "opt", "node", "bin", "node"));
  assert.equal(stableNode(other, [path.join(root, "bin", "node")]), other);
  assert.ok(versionedNodePath(cellar));
  assert.ok(versionedNodePath("/Users/a/.nvm/versions/node/v24.1.0/bin/node"));
  assert.ok(!versionedNodePath(path.join(root, "bin", "node")));
});

function launch(options) {
  const file = path.join(scratch, `launcher-${Math.random()}.sh`);
  fs.writeFileSync(file, launcherScript({ host: "/host dir/host.js", minMajor: 22, ...options }), { mode: 0o755 });
  return spawnSync(file, ["--arg"], { encoding: "utf8" });
}

test("the launcher runs the pinned node while it exists", () => {
  const pinned = fakeNode(path.join(scratch, "pinned", "node"), "26.5.0");
  const result = launch({ node: pinned, fallbacks: [fakeNode(path.join(scratch, "spare", "node"), "24.0.0")] });
  assert.equal(result.stdout, "26.5.0 /host dir/host.js --arg\n");
});

test("the launcher falls back past missing and too-old nodes when the pinned one is gone", () => {
  const old = fakeNode(path.join(scratch, "old", "node"), "20.11.0");
  fakeNode(path.join(scratch, "nvm it's", "v24.0.0", "bin", "node"), "24.0.0");
  const result = launch({ node: path.join(scratch, "gone", "node"), fallbacks: [path.join(scratch, "missing", "node"), old, path.join(scratch, "nvm it's", "*", "bin", "node")] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "24.0.0 /host dir/host.js --arg\n");
});

test("the launcher fails loudly when no node is new enough", () => {
  const old = fakeNode(path.join(scratch, "old2", "node"), "18.0.0");
  const result = launch({ node: path.join(scratch, "gone", "node"), fallbacks: [old, path.join(scratch, "none", "*", "node")] });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no Node\.js 22 or newer/);
});
