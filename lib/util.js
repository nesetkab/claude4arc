import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const TRANSIENT =
  /Execution context was destroyed|Cannot find default execution context|Inspected target navigated|Cannot find context with specified id|No frame with given id|Target closed|Debugger is not attached/i;

export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function poll(check, { timeout, interval = 50, message }) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (true) {
    try {
      const value = await check();
      if (value) return value;
      lastError = null;
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(lastError && !TRANSIENT.test(lastError.message) ? `${message}: ${lastError.message}` : message);
    }
    await sleep(interval);
  }
}

export function fatal(error) {
  error.fatal = true;
  return error;
}

export function normalizeUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^localhost(:\d+)?(\/|$)/.test(url) || /^\d+\.\d+\.\d+\.\d+/.test(url)) return `http://${url}`;
  return `https://${url}`;
}

export function urlMatches(url, matcher) {
  if (matcher instanceof RegExp) return matcher.test(url);
  if (typeof matcher === "function") return Boolean(matcher(url));
  if (matcher.includes("*")) {
    const pattern = matcher.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${pattern}$`).test(url);
  }
  return url === matcher || url.includes(matcher);
}

export function pbcopy(text) {
  return new Promise((resolve, reject) => {
    const child = execFile("pbcopy", (error) => (error ? reject(error) : resolve()));
    child.stdin.end(text);
  });
}
