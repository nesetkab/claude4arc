#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Console } from "node:console";

globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false });
import { Bridge } from "../lib/client.js";
import { Task, listTasks } from "../lib/task.js";
import { runCommands, createTask, COMMAND_NAMES } from "../lib/commands.js";
import {
  ROOT,
  STATE_DIR,
  SOCKET_PATH,
  LOG_PATH,
  HOST_NAME,
  EXTENSION_ID,
  NATIVE_HOSTS_DIR,
} from "../lib/paths.js";

const MANIFEST_PATH = path.join(NATIVE_HOSTS_DIR, `${HOST_NAME}.json`);
const LAUNCHER_PATH = path.join(STATE_DIR, "host-launcher.sh");
const SKILL_LINK = path.join(os.homedir(), ".claude", "skills", "arc-browser");

const USAGE = `arc-browser: let Claude Code drive Arc

Usage:
  arc-browser new [url] [name] [-s]          Create a task (page p1), -s prints a snapshot
  arc-browser <id>[:page] <cmd> [args] [-- <cmd> ...] [-s]
                                             Run one or more commands; -s appends a diff snapshot
  arc-browser run [id] [-e <code>]           Run a script (stdin when -e is absent); with id, t and page are set
  arc-browser status            Show bridge, extension, and task state
  arc-browser tabs              List open Arc tabs
  arc-browser doctor            Diagnose installation problems
  arc-browser install           Register the native host and link the Claude skill
  arc-browser uninstall         Remove the native host registration and skill link
  arc-browser help [topic]      Print API help (topics: api, selectors, keys)`;

const API_HELP = `Globals inside \`arc-browser run\`:
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
  button.primary                  raw CSS (searches open shadow roots and same-origin iframes)`;

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

async function withBridge(work) {
  const bridge = await Bridge.connect();
  try {
    return await work(bridge);
  } finally {
    bridge.close();
  }
}

async function runScript(code, taskId) {
  if (!code.trim()) throw new Error("No script given. Pipe code on stdin or pass -e '<code>'.");
  const bridge = await Bridge.connect();
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
  try {
    await withBridge(async (bridge) => {
      const host = await bridge.call("host.status");
      const extension = await bridge.call("extension.info");
      const tabs = await bridge.call("tabs.query", {});
      console.log(JSON.stringify({ connected: true, host: host.host, extension, tabCount: tabs.length, tasks }, null, 2));
    });
  } catch (error) {
    console.log(JSON.stringify({ connected: false, error: error.message, tasks }, null, 2));
    process.exitCode = 1;
  }
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

async function install() {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const node = resolveNode();
  const hostScript = path.join(ROOT, "host", "host.js");
  await fs.writeFile(LAUNCHER_PATH, `#!/bin/sh\nexec "${node}" "${hostScript}" "$@"\n`, { mode: 0o755 });
  await fs.chmod(LAUNCHER_PATH, 0o755);
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  const manifest = {
    name: HOST_NAME,
    description: "Arc for Claude native bridge",
    path: LAUNCHER_PATH,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  await fs.mkdir(path.dirname(SKILL_LINK), { recursive: true });
  let linked = "linked";
  try {
    const current = await fs.readlink(SKILL_LINK);
    if (current !== path.join(ROOT, "skill")) linked = `left alone (points to ${current})`;
  } catch (error) {
    if (error.code === "ENOENT") await fs.symlink(path.join(ROOT, "skill"), SKILL_LINK);
    else linked = `left alone (${SKILL_LINK} exists and is not a symlink)`;
  }
  console.log(`Native host registered:  ${MANIFEST_PATH}
Host launcher:           ${LAUNCHER_PATH} (node: ${node})
Claude skill:            ${SKILL_LINK} ${linked}

Last step, once, in Arc:
  1. Open arc://extensions
  2. Turn on "Developer mode" (top right)
  3. Click "Load unpacked" and choose: ${path.join(ROOT, "extension")}
  4. Run: arc-browser status`);
}

async function uninstall() {
  await fs.rm(MANIFEST_PATH, { force: true });
  await fs.rm(LAUNCHER_PATH, { force: true });
  try {
    if ((await fs.readlink(SKILL_LINK)) === path.join(ROOT, "skill")) await fs.rm(SKILL_LINK);
  } catch {}
  console.log("Removed the native host registration and the skill link. Remove the extension in arc://extensions.");
}

async function doctor() {
  const checks = [];
  const check = (name, ok, detail) => checks.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  let arcRunning = false;
  try {
    execFileSync("pgrep", ["-x", "Arc"]);
    arcRunning = true;
  } catch {}
  check("Arc is running", arcRunning);
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch {}
  check("native host manifest", Boolean(manifest), manifest ? MANIFEST_PATH : "run `arc-browser install`");
  if (manifest) {
    check("manifest allows extension", manifest.allowed_origins?.includes(`chrome-extension://${EXTENSION_ID}/`));
    let launcherOk = false;
    try {
      await fs.access(manifest.path, fs.constants.X_OK);
      launcherOk = true;
    } catch {}
    check("host launcher is executable", launcherOk, manifest.path);
  }
  let socket = false;
  try {
    socket = (await fs.stat(SOCKET_PATH)).isSocket();
  } catch {}
  check(
    "bridge socket",
    socket,
    socket ? SOCKET_PATH : `missing. Load the extension from ${path.join(ROOT, "extension")} in arc://extensions, or reload it there`,
  );
  if (socket) {
    try {
      await withBridge(async (bridge) => {
        const info = await bridge.call("extension.info");
        check("extension responds", true, `v${info.version} (${info.id})`);
      });
    } catch (error) {
      check("extension responds", false, error.message);
    }
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
    console.log(await withBridge((bridge) => runCommands(bridge, command, rest)));
    return;
  }
  switch (command) {
    case "new":
      console.log(await withBridge((bridge) => createTask(bridge, rest)));
      break;
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
    case "tabs":
      await tabs();
      break;
    case "doctor":
      await doctor();
      break;
    case "install":
      await install();
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
