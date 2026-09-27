#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Console } from "node:console";

globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false });
import { Bridge } from "../lib/client.js";
import { Task, listTasks, browserOfTask } from "../lib/task.js";
import { runCommands, createTask, runBatch, COMMAND_NAMES } from "../lib/commands.js";
import { pruneScreenshots, pruneTempFiles } from "../lib/housekeeping.js";
import { normalizePattern, readBlocklist, writeBlocklist, CONFIG_PATH } from "../lib/blocklist.js";
import { readConfig, updateConfig } from "../lib/config.js";
import { ROOT, STATE_DIR, LOG_PATH, HOST_NAME, EXTENSION_ID } from "../lib/paths.js";
import { BROWSERS, installedBrowsers, hostManifestDirs, socketCandidates, browserOfSocket } from "../lib/browsers.js";

const manifestPathIn = (dir) => path.join(dir, `${HOST_NAME}.json`);
const manifestDirsFor = (browsers) => [...new Set(browsers.flatMap(hostManifestDirs))];
const LAUNCHER_PATH = path.join(STATE_DIR, "host-launcher.sh");
const SKILL_LINK = path.join(os.homedir(), ".claude", "skills", "claude4arc");
const LEGACY_SKILL_LINK = path.join(os.homedir(), ".claude", "skills", "arc-browser");

const USAGE = `claude4arc: let Claude Code drive Arc (or Dia, Chrome, Brave, Edge, Chromium)

Usage:
  claude4arc new [url] [name] [-s]          Create a task (page p1), -s prints a snapshot
  claude4arc <id>[:page] <cmd> [args] [-- <cmd> ...] [-s]
                                             Run one or more commands; -s appends a diff snapshot
  claude4arc batch [id] [--keep]            Run one command chain per stdin line ("B1: goto … -- click …");
                                             prints each line's start/end ms; finishes the task unless --keep or an id
  claude4arc run [id] [-e <code>]           Run a script (stdin when -e is absent); with id, t and page are set
  claude4arc status            Show bridge, extension, and task state
  claude4arc clean [--all]     Delete screenshots older than a day (or all) and stale temp files
  claude4arc block <site...>   Never let Claude open or act on these sites (chase.com, mail.google.com/mail)
  claude4arc unblock <site...> Remove sites from the blocklist
  claude4arc blocked           List blocked sites
  claude4arc tabs              List open Arc tabs
  claude4arc doctor            Diagnose installation problems
  claude4arc reload-extension  Reload the Arc extension after changing extension/
  claude4arc install [--no-skill] [--extension-id <id>]
                               Register the native host and link the Claude skill
  claude4arc uninstall         Remove the native host registration and skill link
  claude4arc help [topic]      Print API help (topics: api, selectors, keys)`;

const API_HELP = `Globals inside \`claude4arc run\`:
  await task(name, { active })   create a task; opens page p1 (background tab unless active: true)
  await task(id)                 resume an existing task by numeric id
  await listTasks()              list tasks saved on disk
  help(topic)                    print this help

Task:
  spaceId, name, page(label), await pages(), await tabs(), await userTab()
  await newPage({ url, active }), await adopt(tabOrTabId, { as }), await release(label)
  await finish({ keep: [] })

Page:
  label, tabId, openedBy, url(), title(), info()
  goto(url, { waitUntil: "load"|"domcontentloaded"|"networkidle"|"none", timeout })
  reload(), goBack(), goForward(), bringToFront(), close()
  snapshot({ scope: "viewport"|"full_page", root: "@N", diff, maxLines }), find(query, { limit })
  seek(selOrText, { container, max, timeout, direction: "down"|"up" })
  text({ maxChars, all }), screenshot({ path, fullPage, selector, scale: "css"|"device" })
  click(sel, { button, clickCount, force, modifiers, label }), dblclick(sel), hover(sel)
  fill(sel, value), press(sel, key) | press(key), focus(sel), check(sel, bool), uncheck(sel)
  selectOption(sel, value | { label } | { index } | array | null)
  setInputFiles(sel, paths), waitForFileChooser() -> { setFiles(paths) }
  dragAndDrop(source, target, { steps }) -> { mode: "html5"|"pointer" }, scroll(deltaY, { deltaX, x, y })
  waitForURL(match), waitForSelector(sel, { state }), waitForLoadState(state)
  waitForFunction(fn, arg, { timeout }), waitForTimeout(ms), waitForEvent("popup"|"dialog"|"load")
  acceptDialog(promptText), dismissDialog()
  evaluate(fnOrString, arg), fetch(url, { method, headers, body, saveAs }), cdp(method, params)
  mouse.move(x, y, { steps }), mouse.click(x, y), mouse.down(), mouse.up(), mouse.wheel(dx, dy)
  keyboard.press("Meta+a"), keyboard.type(text), keyboard.insertText(text), keyboard.paste(text)`;

const SELECTOR_HELP = `Selectors (every element action needs exactly one visible match):
  @12 or ref=12                   ref from the latest snapshot
  text=Sign in                    case-insensitive substring of visible text
  text="Sign in"                  exact, case-sensitive text
  role=button[name="Sign in"]     role + exact accessible name (also loc=role:...)
  role=link[name*="docs"]         role + name substring
  loc=href:/pricing               link whose href contains the value
  xpath=//main//h2
  css=.card:has-text("Pro")       CSS with a terminal :has-text() or :text-is()
  button.primary >> nth=0         any selector + index
  button.primary                  raw CSS (searches open and closed shadow roots and same-origin iframes)`;

const KEY_HELP = `Keys use Playwright names: Enter, Tab, Escape, Backspace, Delete, ArrowUp, Home, PageDown, F1, a, A, 1, ...
Chords join with "+": "Meta+a", "Shift+Tab", "ControlOrMeta+Enter". Mac editing shortcuts (Meta+a/c/v/x/z) run the native editing command.`;

function help(topic) {
  const text = topic === "selectors" ? SELECTOR_HELP : topic === "keys" ? KEY_HELP : `${API_HELP}\n\n${SELECTOR_HELP}\n\n${KEY_HELP}`;
  console.log(text);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function withBridge(work, { taskId, browser: requested } = {}) {
  const browser = requested ?? process.env.CLAUDE4ARC_BROWSER ?? (taskId ? await browserOfTask(taskId) : null) ?? undefined;
  const bridge = await Bridge.connect({ browser });
  try {
    return await work(bridge);
  } finally {
    bridge.close();
  }
}

async function runScript(code, taskId) {
  if (!code.trim()) throw new Error("No script given. Pipe code on stdin or pass -e '<code>'.");
  const bridge = await Bridge.connect({ browser: process.env.CLAUDE4ARC_BROWSER ?? (taskId ? await browserOfTask(taskId) : null) ?? undefined });
  const tasks = [];
  const openTask = async (nameOrId, options) => {
    const task = await Task.open(bridge, nameOrId, options);
    tasks.push(task);
    return task;
  };
  const cleanup = async () => {
    for (const task of tasks) {
      for (const note of await task._settleDialogs().catch(() => [])) console.log(note);
    }
    bridge.close();
  };
  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  const AsyncFunction = (async () => {}).constructor;
  const names = ["task", "taskSpace", "listTasks", "help", ...(taskId ? ["t", "page"] : [])];
  const script = new AsyncFunction(...names, code);
  try {
    const t = taskId ? await openTask(Number(taskId)) : undefined;
    await script(openTask, openTask, listTasks, help, ...(t ? [t, t.page()] : []));
  } finally {
    await cleanup();
  }
}

async function status() {
  const tasks = await listTasks();
  const bridges = await liveBridges();
  const browsers = [];
  for (const bridge of bridges.filter((entry) => !entry.error)) {
    await withBridge(
      async (connection) => {
        const host = await connection.call("host.status");
        const tabs = await connection.call("tabs.query", {});
        browsers.push({ browser: bridge.browser, host: host.host, extension: bridge.info, tabCount: tabs.length });
      },
      { browser: bridge.browser },
    );
  }
  console.log(JSON.stringify({ connected: browsers.length > 0, browsers, tasks }, null, 2));
  if (!browsers.length) process.exitCode = 1;
}

async function tabs() {
  await withBridge(async (bridge) => {
    const list = await bridge.call("tabs.query", {});
    for (const tab of list) {
      console.log(`${tab.active ? "*" : " "} ${String(tab.id).padEnd(10)} ${tab.title?.slice(0, 60).padEnd(60)} ${tab.url}`);
    }
  });
}

function resolveNode() {
  try {
    const found = execFileSync("/bin/sh", ["-lc", "command -v node"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {}
  return process.execPath;
}

async function removeOwnLink(link) {
  try {
    if ((await fs.readlink(link)) === path.join(ROOT, "skill")) await fs.rm(link);
  } catch {}
}

async function linkSkillFolder() {
  await fs.mkdir(path.dirname(SKILL_LINK), { recursive: true });
  try {
    const current = await fs.readlink(SKILL_LINK);
    return current === path.join(ROOT, "skill") ? "linked" : `left alone (points to ${current})`;
  } catch (error) {
    if (error.code !== "ENOENT") return `left alone (${SKILL_LINK} exists and is not a symlink)`;
    await fs.symlink(path.join(ROOT, "skill"), SKILL_LINK);
    return "linked";
  }
}

function allowedExtensionIds(extra = []) {
  const saved = readConfig().extensionIds;
  return [...new Set([EXTENSION_ID, ...(Array.isArray(saved) ? saved : []), ...extra])];
}

async function install(args = []) {
  const extra = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--extension-id") {
      const id = args[++index] ?? "";
      if (!/^[a-p]{32}$/.test(id)) throw new Error(`Not an extension ID: "${id}". It is 32 letters from a to p, shown on the extensions page.`);
      extra.push(id);
    }
  }
  const linkSkill = !args.includes("--no-skill");
  const extensionIds = allowedExtensionIds(extra);
  if (extra.length) updateConfig({ extensionIds: extensionIds.filter((id) => id !== EXTENSION_ID) });
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await removeOwnLink(LEGACY_SKILL_LINK);
  const node = resolveNode();
  const hostScript = path.join(ROOT, "host", "host.js");
  await fs.writeFile(LAUNCHER_PATH, `#!/bin/sh\nexec "${node}" "${hostScript}" "$@"\n`, { mode: 0o755 });
  await fs.chmod(LAUNCHER_PATH, 0o755);
  const browsers = installedBrowsers();
  if (!browsers.length) throw new Error(`No supported browser found in /Applications. Supported: ${BROWSERS.map((browser) => browser.name).join(", ")}.`);
  const manifest = {
    name: HOST_NAME,
    description: "claude4arc native bridge",
    path: LAUNCHER_PATH,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  const written = [];
  for (const dir of manifestDirsFor(browsers)) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(manifestPathIn(dir), JSON.stringify(manifest, null, 2) + "\n");
    written.push(manifestPathIn(dir));
  }
  const linked = linkSkill ? await linkSkillFolder() : (await removeOwnLink(SKILL_LINK), "not linked (--no-skill; use the Claude Code plugin instead)");
  const pages = browsers.map((browser) => `${browser.extensionsPage} (${browser.name})`).join(", ");
  console.log(`Browsers found:          ${browsers.map((browser) => browser.name).join(", ")}
Native host registered:  ${written.join("\n                         ")}
Host launcher:           ${LAUNCHER_PATH} (node: ${node})
Claude skill:            ${SKILL_LINK} ${linked}

Last step, once in each browser you want Claude to use:
  1. Open the extensions page: ${pages}
  2. Turn on "Developer mode"
  3. Click "Load unpacked" and choose: ${path.join(ROOT, "extension")}
  4. Run: claude4arc doctor`);
}

async function uninstall() {
  for (const dir of manifestDirsFor(BROWSERS)) await fs.rm(manifestPathIn(dir), { force: true });
  await fs.rm(LAUNCHER_PATH, { force: true });
  await removeOwnLink(SKILL_LINK);
  await removeOwnLink(LEGACY_SKILL_LINK);
  console.log("Removed the native host registration and the skill link. Remove the extension from each browser's extensions page.");
}

async function liveBridges() {
  const found = [];
  for (const file of [...new Set(socketCandidates())]) {
    let isSocket = false;
    try {
      isSocket = (await fs.stat(file)).isSocket();
    } catch {}
    if (!isSocket) continue;
    const browser = browserOfSocket(file);
    if (found.some((entry) => entry.browser === browser)) continue;
    try {
      const info = await withBridge((bridge) => bridge.call("extension.info"), { browser });
      found.push({ browser, file, info });
    } catch (error) {
      found.push({ browser, file, error: error.message });
    }
  }
  return found;
}

async function doctor() {
  const checks = [];
  const check = (name, ok, detail) => checks.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  const browsers = installedBrowsers();
  check("supported browser installed", browsers.length > 0, browsers.map((browser) => browser.name).join(", ") || BROWSERS.map((browser) => browser.name).join(", "));
  const running = browsers.filter((browser) => {
    try {
      execFileSync("pgrep", ["-x", browser.process]);
      return true;
    } catch {
      return false;
    }
  });
  check("browser running", running.length > 0, running.map((browser) => browser.name).join(", ") || "open Arc or another supported browser");
  for (const dir of manifestDirsFor(browsers)) {
    let manifest = null;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPathIn(dir), "utf8"));
    } catch {}
    const ok = Boolean(manifest?.allowed_origins?.includes(`chrome-extension://${EXTENSION_ID}/`));
    check("native host manifest", ok, ok ? manifestPathIn(dir) : `${manifestPathIn(dir)} missing, run \`claude4arc install\``);
  }
  let launcherOk = false;
  try {
    await fs.access(LAUNCHER_PATH, fs.constants.X_OK);
    launcherOk = true;
  } catch {}
  check("host launcher is executable", launcherOk, LAUNCHER_PATH);
  const bridges = await liveBridges();
  for (const bridge of bridges) {
    check(`extension responds in ${bridge.browser}`, !bridge.error, bridge.error ?? `v${bridge.info.version} (${bridge.info.id})`);
  }
  if (!bridges.length) {
    check("bridge socket", false, `none. Load the extension from ${path.join(ROOT, "extension")} on your browser's extensions page, or reload it there`);
  }
  try {
    const log = (await fs.readFile(LOG_PATH, "utf8")).trim().split("\n").slice(-3).join("\n      ");
    checks.push(`     host log tail:\n      ${log}`);
  } catch {}
  console.log(checks.join("\n"));
  if (checks.some((line) => line.startsWith("FAIL"))) process.exitCode = 1;
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  if (/^\d+(:[\w-]+)?$/.test(command)) {
    if (!rest.length) throw new Error(`Give a command after the task id. Commands: ${COMMAND_NAMES.join(", ")}`);
    console.log(await withBridge((bridge) => runCommands(bridge, command, rest), { taskId: command.split(":")[0] }));
    return;
  }
  switch (command) {
    case "new":
      console.log(await withBridge((bridge) => createTask(bridge, rest)));
      break;
    case "batch": {
      const taskId = rest.find((arg) => /^\d+$/.test(arg));
      const keep = rest.includes("--keep") || Boolean(taskId);
      const script = await readStdin();
      const failures = await withBridge((bridge) => runBatch(bridge, script, { taskId, keep, write: (text) => console.log(text) }), { taskId });
      if (failures) process.exitCode = 1;
      break;
    }
    case "run":
    case "nodejs": {
      const taskId = /^\d+$/.test(rest[0] ?? "") ? rest.shift() : undefined;
      const index = rest.indexOf("-e");
      const code = index >= 0 ? rest[index + 1] ?? "" : await readStdin();
      await runScript(code, taskId);
      break;
    }
    case "status":
      await status();
      break;
    case "block":
    case "unblock": {
      if (!rest.length) throw new Error(`Usage: claude4arc ${command} <site> [site...], for example: claude4arc ${command} chase.com mail.google.com`);
      const patterns = rest.map(normalizePattern);
      const current = new Set(readBlocklist());
      for (const pattern of patterns) command === "block" ? current.add(pattern) : current.delete(pattern);
      const list = writeBlocklist([...current]);
      console.log(list.length ? `Blocked sites (${CONFIG_PATH}):\n  ${list.join("\n  ")}` : "The blocklist is empty.");
      break;
    }
    case "blocked": {
      const list = readBlocklist();
      console.log(list.length ? `Blocked sites (${CONFIG_PATH}):\n  ${list.join("\n  ")}` : "The blocklist is empty. Add sites with: claude4arc block <site>");
      break;
    }
    case "clean": {
      const all = rest.includes("--all");
      const screenshots = await pruneScreenshots({ all });
      const temp = await pruneTempFiles();
      console.log(`Removed ${screenshots} screenshot${screenshots === 1 ? "" : "s"} and ${temp} temporary file${temp === 1 ? "" : "s"}.`);
      break;
    }
    case "reload-extension":
      await withBridge((bridge) => bridge.call("extension.reload"));
      console.log("Extension reloading. Run `claude4arc status` in a few seconds.");
      break;
    case "tabs":
      await tabs();
      break;
    case "doctor":
      await doctor();
      break;
    case "install":
      await install(rest);
      break;
    case "uninstall":
      await uninstall();
      break;
    case "help":
    case "--help":
    case "-h":
      if (rest[0]) help(rest[0]);
      else console.log(`${USAGE}\n\n${API_HELP}`);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  },
);
