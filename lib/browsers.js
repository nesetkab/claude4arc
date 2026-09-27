import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR } from "./paths.js";

const SUPPORT = path.join(os.homedir(), "Library", "Application Support");

export const BROWSERS = [
  { key: "arc", name: "Arc", bundle: "Arc.app", process: "Arc", hostDirs: ["Google/Chrome"], extensionsPage: "arc://extensions" },
  { key: "dia", name: "Dia", bundle: "Dia.app", process: "Dia", hostDirs: ["Google/Chrome", "Dia/User Data"], extensionsPage: "chrome://extensions" },
  { key: "chrome", name: "Google Chrome", bundle: "Google Chrome.app", process: "Google Chrome", hostDirs: ["Google/Chrome"], extensionsPage: "chrome://extensions" },
  { key: "brave", name: "Brave", bundle: "Brave Browser.app", process: "Brave Browser", hostDirs: ["BraveSoftware/Brave-Browser"], extensionsPage: "brave://extensions" },
  { key: "edge", name: "Microsoft Edge", bundle: "Microsoft Edge.app", process: "Microsoft Edge", hostDirs: ["Microsoft Edge"], extensionsPage: "edge://extensions" },
  { key: "chromium", name: "Chromium", bundle: "Chromium.app", process: "Chromium", hostDirs: ["Chromium"], extensionsPage: "chrome://extensions" },
];

export const LEGACY_SOCKET = path.join(STATE_DIR, "bridge.sock");

export function browserByKey(key) {
  const browser = BROWSERS.find((item) => item.key === String(key ?? "").toLowerCase());
  if (!browser) throw new Error(`Unknown browser "${key}". Supported: ${BROWSERS.map((item) => item.key).join(", ")}.`);
  return browser;
}

export function browserForExecutable(executable) {
  return BROWSERS.find((browser) => String(executable ?? "").includes(`/${browser.bundle}/`)) ?? null;
}

export function hostManifestDirs(browser) {
  return browser.hostDirs.map((dir) => path.join(SUPPORT, dir, "NativeMessagingHosts"));
}

export function isInstalled(browser) {
  return [path.join("/Applications", browser.bundle), path.join(os.homedir(), "Applications", browser.bundle)].some((app) => fs.existsSync(app));
}

export function installedBrowsers() {
  return BROWSERS.filter(isInstalled);
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
