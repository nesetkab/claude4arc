import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { STATE_DIR } from "./paths.js";

export const BROWSERS = [
  { key: "arc", name: "Arc", bundle: "Arc.app", process: "Arc", hostDirs: ["Google/Chrome"], extensionsPage: "arc://extensions" },
  { key: "dia", name: "Dia", bundle: "Dia.app", process: "Dia", hostDirs: ["Google/Chrome", "Dia/User Data"], extensionsPage: "chrome://extensions" },
  {
    key: "chrome",
    name: "Google Chrome",
    bundle: "Google Chrome.app",
    process: "Google Chrome",
    hostDirs: ["Google/Chrome"],
    extensionsPage: "chrome://extensions",
    linux: { config: "google-chrome", commands: ["google-chrome", "google-chrome-stable"], exe: /\/google\/chrome[^/]*\/chrome$/ },
  },
  {
    key: "brave",
    name: "Brave",
    bundle: "Brave Browser.app",
    process: "Brave Browser",
    hostDirs: ["BraveSoftware/Brave-Browser"],
    extensionsPage: "brave://extensions",
    linux: { config: "BraveSoftware/Brave-Browser", commands: ["brave-browser", "brave"], exe: /\/brave\.com\/brave[^/]*\/brave$/ },
  },
  {
    key: "edge",
    name: "Microsoft Edge",
    bundle: "Microsoft Edge.app",
    process: "Microsoft Edge",
    hostDirs: ["Microsoft Edge"],
    extensionsPage: "edge://extensions",
    linux: { config: "microsoft-edge", commands: ["microsoft-edge", "microsoft-edge-stable"], exe: /\/microsoft\/msedge[^/]*\/msedge$/ },
  },
  {
    key: "chromium",
    name: "Chromium",
    bundle: "Chromium.app",
    process: "Chromium",
    hostDirs: ["Chromium"],
    extensionsPage: "chrome://extensions",
    linux: { config: "chromium", commands: ["chromium", "chromium-browser"], exe: /\/chromium(-browser)?\/(chromium(-browser)?|chrome)$/ },
  },
  {
    key: "chrome-for-testing",
    name: "Chrome for Testing",
    bundle: "Google Chrome for Testing.app",
    process: "Google Chrome for Testing",
    hostDirs: ["Google/Chrome for Testing"],
    extensionsPage: "chrome://extensions",
    linux: { config: "google-chrome-for-testing", commands: [], exe: /\/chrome-linux64\/chrome$/ },
  },
];

export const LEGACY_SOCKET = path.join(STATE_DIR, "bridge.sock");

export function browserByKey(key) {
  const browser = BROWSERS.find((item) => item.key === String(key ?? "").toLowerCase());
  if (!browser) throw new Error(`Unknown browser "${key}". Supported: ${BROWSERS.map((item) => item.key).join(", ")}.`);
  return browser;
}

export function browserForExecutable(executable) {
  const file = String(executable ?? "").replace(/ \(deleted\)$/, "");
  return BROWSERS.find((browser) => file.includes(`/${browser.bundle}/`) || browser.linux?.exe.test(file)) ?? null;
}

export function platformBrowsers(platform = process.platform) {
  return platform === "linux" ? BROWSERS.filter((browser) => browser.linux) : BROWSERS;
}

function linuxConfigDir(browser, home, env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), browser.linux.config);
}

export function hostManifestDirs(browser, { platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "linux") return browser.linux ? [path.join(linuxConfigDir(browser, home, env), "NativeMessagingHosts")] : [];
  return browser.hostDirs.map((dir) => path.join(home, "Library", "Application Support", dir, "NativeMessagingHosts"));
}

export function isInstalled(browser, { platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "linux") {
    if (!browser.linux) return false;
    const dirs = String(env.PATH ?? "").split(":").filter(Boolean);
    return fs.existsSync(linuxConfigDir(browser, home, env)) || browser.linux.commands.some((command) => dirs.some((dir) => fs.existsSync(path.join(dir, command))));
  }
  return [path.join("/Applications", browser.bundle), path.join(home, "Applications", browser.bundle)].some((app) => fs.existsSync(app));
}

export function installedBrowsers(options) {
  return BROWSERS.filter((browser) => isInstalled(browser, options));
}

function linuxExecutable(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
  }
}

export function browserOfProcess(pid, platform = process.platform) {
  try {
    if (platform === "linux") return browserForExecutable(linuxExecutable(pid));
    return browserForExecutable(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

export function runningBrowsers(browsers, platform = process.platform) {
  if (platform === "linux") {
    let pids = [];
    try {
      pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
    } catch {}
    const keys = new Set(pids.map((pid) => browserOfProcess(pid, platform)?.key));
    return browsers.filter((browser) => keys.has(browser.key));
  }
  return browsers.filter((browser) => {
    try {
      execFileSync("pgrep", ["-x", browser.process]);
      return true;
    } catch {
      return false;
    }
  });
}

export function socketPath(key) {
  return path.join(STATE_DIR, `${key}.sock`);
}

export function socketCandidates(preferred) {
  if (preferred) {
    const browser = browserByKey(preferred);
    return browser.key === "arc" ? [socketPath("arc"), LEGACY_SOCKET] : [socketPath(browser.key)];
  }
  return [...BROWSERS.map((browser) => socketPath(browser.key)), LEGACY_SOCKET];
}

export function browserOfSocket(file) {
  if (file === LEGACY_SOCKET) return "arc";
  return path.basename(file, ".sock");
}
