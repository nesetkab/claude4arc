import { readConfig, updateConfig, CONFIG_PATH } from "./config.js";

export { CONFIG_PATH };

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

export function readBlocklist() {
  const list = readConfig().blockedSites;
  return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
}

export function writeBlocklist(list) {
  return updateConfig({ blockedSites: [...new Set(list)].sort() }).blockedSites;
}

export function blockedError(url, pattern) {
  const error = new Error(`${url} is on the claude4arc blocklist (${pattern}). Ask the user to do this themselves.`);
  error.fatal = true;
  error.blocked = true;
  return error;
}
