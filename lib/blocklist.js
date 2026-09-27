import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.js";

export const CONFIG_PATH = path.join(STATE_DIR, "config.json");

export function normalizePattern(raw) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
  if (!value || /\s/.test(value) || value.startsWith("/")) throw new Error(`Not a site pattern: "${raw}". Use a domain such as chase.com or mail.google.com/mail.`);
  return value;
}

export function blockedBy(url, patterns) {
  if (!patterns?.length) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  for (const pattern of patterns) {
    const slash = pattern.indexOf("/");
    const domain = slash < 0 ? pattern : pattern.slice(0, slash);
    const prefix = slash < 0 ? "" : pattern.slice(slash);
    const hostMatches = host === domain || host.endsWith(`.${domain}`);
    if (hostMatches && (!prefix || pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return pattern;
  }
  return null;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function readBlocklist() {
  const list = readConfig().blockedSites;
  return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
}

export function writeBlocklist(list) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const config = { ...readConfig(), blockedSites: [...new Set(list)].sort() };
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, CONFIG_PATH);
  return config.blockedSites;
}

export function blockedError(url, pattern) {
  const error = new Error(`${url} is on the claude4arc blocklist (${pattern}). Ask the user to do this themselves.`);
  error.fatal = true;
  error.blocked = true;
  return error;
}
