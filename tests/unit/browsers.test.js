import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSERS,
  browserByKey,
  browserForExecutable,
  hostManifestDirs,
  platformBrowsers,
  isInstalled,
  browserOfProcess,
  runningBrowsers,
  socketCandidates,
  browserOfSocket,
  socketPath,
  LEGACY_SOCKET,
} from "../../lib/browsers.js";

const LINUX = { platform: "linux", home: "/home/u", env: { PATH: "/usr/local/bin:/usr/bin" } };

test("browserForExecutable finds the browser from its binary path", () => {
  assert.equal(browserForExecutable("/Applications/Arc.app/Contents/MacOS/Arc").key, "arc");
  assert.equal(browserForExecutable("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").key, "chrome");
  assert.equal(browserForExecutable("/tmp/x/chrome-mac/Chromium.app/Contents/MacOS/Chromium").key, "chromium");
  assert.equal(browserForExecutable("/tmp/x/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing").key, "chrome-for-testing");
  assert.equal(browserForExecutable("/usr/bin/node"), null);
});

test("browserByKey accepts any case and rejects unknown names", () => {
  assert.equal(browserByKey("Dia").name, "Dia");
  assert.throws(() => browserByKey("netscape"), /Unknown browser/);
});

test("Arc and Dia register in Google Chrome's native host folder", () => {
  for (const key of ["arc", "dia", "chrome"]) {
    const dirs = hostManifestDirs(browserByKey(key), { platform: "darwin" });
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

test("browserForExecutable finds Linux browsers from their binary paths", () => {
  const cases = {
    "/opt/google/chrome/chrome": "chrome",
    "/opt/google/chrome-beta/chrome": "chrome",
    "/opt/google/chrome/chrome (deleted)": "chrome",
    "/usr/lib/chromium/chromium": "chromium",
    "/usr/lib64/chromium-browser/chromium-browser": "chromium",
    "/snap/chromium/2890/usr/lib/chromium-browser/chrome": "chromium",
    "/opt/brave.com/brave/brave": "brave",
    "/opt/microsoft/msedge/msedge": "edge",
    "/tmp/browsers/chrome/linux-131.0.6778.85/chrome-linux64/chrome": "chrome-for-testing",
  };
  for (const [file, key] of Object.entries(cases)) assert.equal(browserForExecutable(file)?.key, key, file);
  assert.equal(browserForExecutable("/usr/bin/node"), null);
  assert.equal(browserForExecutable("chrome"), null);
});

test("Linux registers native hosts in each browser's config folder and skips Arc and Dia", () => {
  const expected = {
    chrome: "/home/u/.config/google-chrome/NativeMessagingHosts",
    chromium: "/home/u/.config/chromium/NativeMessagingHosts",
    brave: "/home/u/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    edge: "/home/u/.config/microsoft-edge/NativeMessagingHosts",
    "chrome-for-testing": "/home/u/.config/google-chrome-for-testing/NativeMessagingHosts",
  };
  for (const [key, dir] of Object.entries(expected)) assert.deepEqual(hostManifestDirs(browserByKey(key), LINUX), [dir], key);
  assert.deepEqual(hostManifestDirs(browserByKey("arc"), LINUX), []);
  assert.deepEqual(hostManifestDirs(browserByKey("dia"), LINUX), []);
  assert.deepEqual(hostManifestDirs(browserByKey("chrome"), { ...LINUX, env: { XDG_CONFIG_HOME: "/xdg" } }), ["/xdg/google-chrome/NativeMessagingHosts"]);
  assert.deepEqual(platformBrowsers("linux").map((browser) => browser.key), ["chrome", "brave", "edge", "chromium", "chrome-for-testing"]);
  assert.equal(platformBrowsers("darwin"), BROWSERS);
});

test("macOS keeps its Application Support folders", () => {
  assert.deepEqual(hostManifestDirs(browserByKey("dia"), { platform: "darwin", home: "/Users/u" }), [
    "/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "/Users/u/Library/Application Support/Dia/User Data/NativeMessagingHosts",
  ]);
});

test("a Linux browser counts as installed by its config folder or its command on PATH", (t) => {
  const present = new Set(["/home/u/.config/google-chrome-for-testing", "/usr/bin/chromium-browser"]);
  t.mock.method(fs, "existsSync", (file) => present.has(file));
  const installed = BROWSERS.filter((browser) => isInstalled(browser, LINUX)).map((browser) => browser.key);
  assert.deepEqual(installed, ["chromium", "chrome-for-testing"]);
});

test("the host finds its Linux browser through /proc, falling back to cmdline", (t) => {
  const exes = { 10: "/opt/google/chrome/chrome", 11: "/usr/bin/bash" };
  t.mock.method(fs, "readlinkSync", (file) => {
    const pid = /\/proc\/(\d+)\/exe/.exec(file)[1];
    if (exes[pid]) return exes[pid];
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  });
  t.mock.method(fs, "readFileSync", (file) => {
    if (file === "/proc/12/cmdline") return "/opt/brave.com/brave/brave\0--type=renderer\0";
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  assert.equal(browserOfProcess(10, "linux").key, "chrome");
  assert.equal(browserOfProcess(11, "linux"), null);
  assert.equal(browserOfProcess(12, "linux").key, "brave");
  assert.equal(browserOfProcess(13, "linux"), null);
  t.mock.method(fs, "readdirSync", () => ["10", "11", "12", "self", "cpuinfo"]);
  assert.deepEqual(runningBrowsers(platformBrowsers("linux"), "linux").map((browser) => browser.key), ["chrome", "brave"]);
});
