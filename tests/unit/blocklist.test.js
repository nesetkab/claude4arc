import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude4arc-home-"));
process.env.HOME = home;
const { normalizePattern, blockedBy, readBlocklist, writeBlocklist, blockedError } = await import("../../lib/blocklist.js");

test("normalizePattern strips scheme, www, wildcard, and trailing slash", () => {
  assert.equal(normalizePattern("https://www.Chase.com/"), "chase.com");
  assert.equal(normalizePattern("*.bank.example"), "bank.example");
  assert.equal(normalizePattern("github.com/settings/"), "github.com/settings");
  assert.throws(() => normalizePattern(""), /Not a site pattern/);
  assert.throws(() => normalizePattern("two words"), /Not a site pattern/);
});

test("blockedBy matches a domain and its subdomains only", () => {
  const list = ["chase.com"];
  assert.equal(blockedBy("https://chase.com/", list), "chase.com");
  assert.equal(blockedBy("https://secure.chase.com/login", list), "chase.com");
  assert.equal(blockedBy("https://notchase.com/", list), null);
  assert.equal(blockedBy("https://chase.com.evil.test/", list), null);
});

test("blockedBy matches a path prefix at a segment boundary", () => {
  const list = ["github.com/settings"];
  assert.equal(blockedBy("https://github.com/settings", list), "github.com/settings");
  assert.equal(blockedBy("https://github.com/settings/keys", list), "github.com/settings");
  assert.equal(blockedBy("https://github.com/settingsx", list), null);
  assert.equal(blockedBy("https://github.com/nesetkab", list), null);
});

test("blockedBy ignores non-web URLs and an empty list", () => {
  assert.equal(blockedBy("about:blank", ["chase.com"]), null);
  assert.equal(blockedBy("chrome://extensions", ["extensions"]), null);
  assert.equal(blockedBy("https://chase.com", []), null);
  assert.equal(blockedBy("not a url", ["chase.com"]), null);
});

test("the blocklist round-trips through the config file", () => {
  assert.deepEqual(readBlocklist(), []);
  writeBlocklist(["b.test", "a.test", "a.test"]);
  assert.deepEqual(readBlocklist(), ["a.test", "b.test"]);
  const config = JSON.parse(fs.readFileSync(path.join(home, ".arc-bridge", "config.json"), "utf8"));
  assert.deepEqual(config.blockedSites, ["a.test", "b.test"]);
});

test("blockedError is fatal and names the pattern", () => {
  const error = blockedError("https://chase.com/", "chase.com");
  assert.equal(error.fatal, true);
  assert.match(error.message, /blocklist \(chase\.com\)/);
});
