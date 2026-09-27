import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { BROWSERS, browserByKey, browserForExecutable, hostManifestDirs, socketCandidates, browserOfSocket, socketPath, LEGACY_SOCKET } from "../../lib/browsers.js";

test("browserForExecutable finds the browser from its binary path", () => {
  assert.equal(browserForExecutable("/Applications/Arc.app/Contents/MacOS/Arc").key, "arc");
  assert.equal(browserForExecutable("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").key, "chrome");
  assert.equal(browserForExecutable("/tmp/x/chrome-mac/Chromium.app/Contents/MacOS/Chromium").key, "chromium");
  assert.equal(browserForExecutable("/usr/bin/node"), null);
});

test("browserByKey accepts any case and rejects unknown names", () => {
  assert.equal(browserByKey("Dia").name, "Dia");
  assert.throws(() => browserByKey("netscape"), /Unknown browser/);
});

test("Arc and Dia register in Google Chrome's native host folder", () => {
  for (const key of ["arc", "dia", "chrome"]) {
    const dirs = hostManifestDirs(browserByKey(key));
    assert.ok(dirs.some((dir) => dir.endsWith(path.join("Google", "Chrome", "NativeMessagingHosts"))), key);
  }
});

test("socket candidates put Arc first and include the legacy socket", () => {
  const all = socketCandidates();
  assert.equal(all[0], socketPath("arc"));
  assert.equal(all.at(-1), LEGACY_SOCKET);
  assert.equal(all.length, BROWSERS.length + 1);
  assert.deepEqual(socketCandidates("arc"), [socketPath("arc"), LEGACY_SOCKET]);
  assert.deepEqual(socketCandidates("brave"), [socketPath("brave")]);
});

test("browserOfSocket reads the browser from the socket name", () => {
  assert.equal(browserOfSocket(socketPath("edge")), "edge");
  assert.equal(browserOfSocket(LEGACY_SOCKET), "arc");
});
