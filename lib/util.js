import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
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
  if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(url)) return `http://${url}`;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url)) return url;
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

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export const NODE_PATHS = ["/opt/homebrew/bin/node", "/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node", "/usr/local/opt/node/bin/node", "/opt/local/bin/node"];

export function nodeFallbacks(home) {
  return [
    ...NODE_PATHS,
    `${home}/.volta/bin/node`,
    `${home}/.local/share/mise/shims/node`,
    `${home}/.asdf/shims/node`,
    `${home}/.nvm/versions/node/*/bin/node`,
    `${home}/.local/share/fnm/node-versions/*/installation/bin/node`,
  ];
}

export function versionedNodePath(file) {
  return /\/Cellar\/|\/\.nvm\/versions\/|\/fnm\/node-versions\/|\/fnm_multishells\/|\/\.asdf\/installs\/|\/\.volta\/tools\/image\/|\/mise\/installs\/|\/n\/versions\//.test(file);
}

function realpathOrNull(file) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

export function stableNode(execPath, candidates) {
  const target = realpathOrNull(execPath);
  const brewOpt = execPath.replace(/\/Cellar\/([^/]+)\/[^/]+\//, "/opt/$1/");
  const same = [...candidates, brewOpt, execPath].filter((file) => file && target && realpathOrNull(file) === target);
  return same.find((file) => !versionedNodePath(file)) ?? execPath;
}

function shellWord(file) {
  const star = file.indexOf("*");
  return star < 0 ? shellQuote(file) : shellQuote(file.slice(0, star)) + file.slice(star);
}

export function launcherScript({ node, host, fallbacks, minMajor }) {
  const words = [...new Set(fallbacks)].filter((file) => file && file !== node).map(shellWord).join(" ");
  return `#!/bin/sh
host=${shellQuote(host)}
[ -x ${shellQuote(node)} ] && exec ${shellQuote(node)} "$host" "$@"
for node in ${words}; do
  version=$("$node" --version </dev/null 2>/dev/null) || continue
  version=\${version#v}
  [ "\${version%%.*}" -ge ${minMajor} ] 2>/dev/null && exec "$node" "$host" "$@"
done
echo 'claude4arc: no Node.js ${minMajor} or newer found, run claude4arc install' >&2
exit 1
`;
}
