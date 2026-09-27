import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, urlMatches, poll, fatal, withTimeout } from "../../lib/util.js";

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
