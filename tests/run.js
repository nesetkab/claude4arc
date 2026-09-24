#!/usr/bin/env node
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer, PORTS } from "./serve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "arc-browser.js");
const FIXTURES = path.join(HERE, "fixtures");
const BASE = `http://127.0.0.1:${PORTS[0]}`;
const CALL_TIMEOUT = 60_000;

const args = process.argv.slice(2);
const verbose = args.includes("-v") || args.includes("--verbose");
const filters = args.filter((arg) => !arg.startsWith("-")).flatMap((arg) => arg.split(","));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CliError extends Error {
  constructor(message, stdout) {
    super(message);
    this.stdout = stdout;
  }
}

function execCli(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv], { timeout: CALL_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout: stdout.trim(), stderr: stderr.trim(), killed: Boolean(error?.killed) });
    });
  });
}

async function cli(argv) {
  const started = performance.now();
  let result = await execCli(argv);
  if (result.code !== 0 && /Arc bridge is not running/.test(result.stderr)) {
    await sleep(5_000);
    result = await execCli(argv);
  }
  const ms = Math.round(performance.now() - started);
  if (verbose) console.log(`    ${String(ms).padStart(6)}ms  arc-browser ${argv.join(" ")}`.slice(0, 160));
  if (result.code !== 0) {
    const message = result.killed ? `timed out after ${CALL_TIMEOUT}ms` : result.stderr.replace(/^Error: /, "") || `exit ${result.code}`;
    throw new CliError(message, result.stdout);
  }
  return { out: result.stdout, ms };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function refs(output, pattern) {
  return output
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => /@[\d.]+/.exec(line)?.[0])
    .filter(Boolean);
}

class Session {
  constructor(taskId) {
    this.taskId = taskId;
    this.ms = 0;
  }

  async on(label, ...argv) {
    const { out, ms } = await cli([`${this.taskId}:${label}`, ...argv]);
    this.ms += ms;
    return out;
  }

  cmd(...argv) {
    return this.on("p1", ...argv);
  }

  async attempt(...argv) {
    try {
      return { ok: true, out: await this.cmd(...argv) };
    } catch (error) {
      return { ok: false, out: error.stdout ?? "", error: error.message };
    }
  }

  async script(code) {
    const { out, ms } = await cli(["run", String(this.taskId), "-e", `const p = t.page("p1");\n${code}`]);
    this.ms += ms;
    return out;
  }

  async goto(fixture) {
    const { out } = await cli([`${this.taskId}:p1`, "goto", `${BASE}/${fixture}`]);
    return out;
  }

  async result(label = "p1", selector = "#result") {
    const { out } = await cli([`${this.taskId}:${label}`, "eval", `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`]);
    return parseJson(out);
  }

  async pages() {
    const { out } = await cli([String(this.taskId), "pages"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [label, tab] = line.split(" ");
        return { label, active: tab.endsWith("*"), line };
      });
  }

  async closeExtraPages() {
    for (const page of await this.pages()) {
      if (page.label !== "p1") await cli([`${this.taskId}:${page.label}`, "close"]).catch(() => {});
    }
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const show = (value) => (typeof value === "string" ? value : JSON.stringify(value));

function popupLabel(output) {
  return /popup (p\d+)/.exec(output)?.[1];
}

async function expectBackgroundPopup(s, output, check) {
  const label = popupLabel(output);
  expect(label, `no popup reported; output: ${show(output)}`);
  const pages = await s.pages();
  const popup = pages.find((page) => page.label === label);
  expect(popup, `popup ${label} missing from pages`);
  expect(!popup.active, `popup ${label} was brought to the front`);
  const url = (await cli([`${s.taskId}:${label}`, "eval", "location.href"])).out;
  expect(check(url), `popup ${label} has unexpected url ${url}`);
  return `${label} ${new URL(url).search}`;
}

const scenarios = [
  {
    name: "react-form",
    fixture: "react-form.html",
    async run(s) {
      await s.cmd("fill", "#name", "Ada", "Lovelace", "--", "fill", "#email", "ada@example.com", "--", "select", "#plan", "pro", "--", "check", "#terms", "--", "click", 'role=button[name="Create account"]');
      const result = await s.result();
      expect(result?.submitted, `not submitted: ${show(result)}`);
      const { name, email, plan, terms } = result.submitted;
      expect(name === "Ada Lovelace" && email === "ada@example.com" && plan === "pro" && terms === true, `state ${show(result.submitted)}`);
    },
  },
  {
    name: "combobox-click",
    fixture: "combobox.html",
    async run(s) {
      await s.cmd("click", "#fruit", "--", "click", 'role=option[name="Banana"]');
      const result = await s.result();
      expect(result === "Banana", `selected ${show(result)}`);
    },
  },
  {
    name: "combobox-keys",
    fixture: "combobox.html",
    async run(s) {
      await s.cmd("fill", "#fruit", "ch", "--", "press", "#fruit", "ArrowDown", "--", "press", "#fruit", "Enter");
      const result = await s.result();
      expect(result === "Cherry", `selected ${show(result)}`);
    },
  },
  ...[
    ["native-select", ["select", "#country", "fr"], "country", "fr"],
    ["native-date", ["fill", "#date", "2026-03-14"], "date", "2026-03-14"],
    ["native-time", ["fill", "#time", "13:45"], "time", "13:45"],
    ["native-range", ["fill", "#range", "70"], "range", "70"],
    ["native-color", ["fill", "#color", "#ff8800"], "color", "#ff8800"],
  ].map(([name, command, key, value]) => ({
    name,
    fixture: "native-inputs.html",
    async run(s) {
      await s.cmd(...command);
      const result = await s.result();
      expect(result?.state?.[key] === value, `state ${show(result)}`);
      expect(result.events[`${key}:change`], `no change event: ${show(result.events)}`);
    },
  })),
  {
    name: "editor-fill",
    fixture: "editor.html",
    async run(s) {
      await s.cmd("fill", "#editor", "Hello", "from", "Arc");
      const result = await s.result();
      expect(result?.text === "Hello from Arc", `text ${show(result?.text ?? result)}`);
      expect(result.inputs > 0, `no input events: ${show(result)}`);
    },
  },
  {
    name: "editor-type",
    fixture: "editor.html",
    async run(s) {
      await s.cmd("click", "#editor", "--", "press", "Meta+a", "--", "type", "Typed", "text");
      const result = await s.result();
      expect(result?.text === "Typed text", `text ${show(result?.text ?? result)}`);
      expect(result.beforeinput > 0, `no beforeinput events: ${show(result)}`);
    },
  },
  {
    name: "dnd-html5-reorder",
    fixture: "dnd.html",
    async run(s) {
      await s.script('await p.dragAndDrop("#item-a", "#item-c");');
      const result = await s.result();
      expect(result?.order?.[0] !== "Alpha", `order unchanged ${show(result?.order ?? result)}`);
      expect(result.dataTransferOk, "dataTransfer data missing on drop");
    },
  },
  {
    name: "dnd-html5-dropzone",
    fixture: "dnd.html",
    async run(s) {
      await s.script('await p.dragAndDrop("#item-d", "#bin");');
      const result = await s.result();
      expect(result?.trashed === "Delta", `result ${show(result)}`);
    },
  },
  {
    name: "drag-pointer",
    fixture: "pointer-drag.html",
    async run(s) {
      await s.script('await p.dragAndDrop("#row-1", "#row-3");');
      const result = await s.result();
      expect(result?.moves > 1, `mousemove count ${show(result?.moves ?? result)}`);
      expect(result.order[0] === "Two" && result.order.indexOf("One") >= 1, `order ${show(result.order)}`);
    },
  },
  {
    name: "infinite-scroll",
    fixture: "infinite-list.html",
    async run(s) {
      let count = 0;
      for (let i = 0; i < 10 && count < 70; i += 1) {
        const out = await s.cmd("scroll", "2500", "--", "wait", "300", "--", "eval", "document.querySelectorAll('.item').length");
        count = Number(out.split("\n").at(-1));
      }
      expect(count >= 70, `only ${count} items loaded`);
      await s.cmd("click", "#item-70");
      const result = await s.result();
      expect(result === "clicked 70", `result ${show(result)}`);
    },
  },
  {
    name: "virtual-list",
    fixture: "virtual-list.html",
    async run(s) {
      await s.script(`
const box = await p.evaluate(() => { const r = document.getElementById("viewport").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
for (let i = 0; i < 6; i += 1) {
  if (await p.evaluate(() => Boolean(document.querySelector('[data-row="500"]')))) break;
  const top = await p.evaluate(() => document.getElementById("viewport").scrollTop);
  await p.scroll(15000 - top, box);
}
await p.click('text="Row 500"');`);
      const result = await s.result();
      expect(result === "row 500", `result ${show(result)}`);
    },
  },
  {
    name: "canvas-click",
    fixture: "canvas.html",
    async run(s) {
      await s.cmd("click", "#board");
      const result = await s.result();
      expect(result?.hit === "green" && result.trusted, `result ${show(result)}`);
    },
  },
  {
    name: "canvas-coords",
    fixture: "canvas.html",
    async run(s) {
      await s.script(`
const r = await p.evaluate(() => { const b = document.getElementById("board").getBoundingClientRect(); return { x: b.x, y: b.y }; });
await p.mouse.click(r.x + 60, r.y + 60);`);
      const result = await s.result();
      expect(result?.hit === "red" && Math.abs(result.x - 60) <= 1 && Math.abs(result.y - 60) <= 1, `result ${show(result)}`);
    },
  },
  {
    name: "shadow-open",
    fixture: "shadow.html",
    async run(s) {
      await s.cmd("fill", 'role=textbox[name="Open input"]', "open-value", "--", "click", 'role=button[name="Open shadow button"]');
      const result = await s.result();
      expect(result?.openValue === "open-value" && result.openClicked, `result ${show(result)}`);
    },
  },
  {
    name: "shadow-closed",
    fixture: "shadow.html",
    async run(s) {
      const found = await s.cmd("find", "Closed", "shadow", "button");
      const [ref] = refs(found, /button/);
      expect(ref, `find: ${show(found)}`);
      await s.cmd("click", ref, "--", "fill", 'role=textbox[name="Closed input"]', "closed-value");
      const result = await s.result();
      expect(result?.closedClicked && result.closedValue === "closed-value", `result ${show(result)}`);
    },
  },
  {
    name: "iframe-same-origin",
    fixture: "iframe-same.html",
    async run(s) {
      await s.cmd("fill", 'role=textbox[name="Frame input"]', "same-value", "--", "click", 'role=button[name="Frame button"]');
      const result = await s.result();
      expect(result?.same?.value === "same-value" && result.same.clicks === 1, `result ${show(result)}`);
    },
  },
  {
    name: "iframe-cross-snap",
    fixture: "iframe-cross.html",
    async run(s) {
      await s.cmd("wait", "500");
      const snap = await s.cmd("snap");
      const inner = refs(snap, /button "Frame button"/);
      expect(inner.length && /^@\d+\.\d+$/.test(inner[0]), `no frame ref in snap: ${show(snap.split("\n").slice(3, 7).join(" / "))}`);
    },
  },
  {
    name: "iframe-cross-find-click",
    fixture: "iframe-cross.html",
    async run(s) {
      const found = await s.cmd("find", "Frame", "button");
      const [ref] = refs(found, /Frame button/);
      expect(ref && ref.includes("."), `find: ${show(found)}`);
      await s.cmd("click", ref);
      const result = await s.result();
      expect(result?.cross?.clicks === 1 && result.cross.trusted, `result ${show(result)}`);
    },
  },
  {
    name: "iframe-cross-scoped-form",
    fixture: "iframe-cross.html",
    async run(s) {
      const found = await s.cmd("find", "Cross", "frame");
      const [frame] = refs(found, /^@[\d.]+ iframe /);
      expect(frame, `no iframe ref: ${show(found)}`);
      await s.cmd("fill", `${frame} >> #q`, "cross-value", "--", "check", `${frame} >> #agree`, "--", "click", `${frame} >> #send`);
      const result = await s.result();
      expect(result?.cross?.submitted === "cross-value" && result.cross.checked, `result ${show(result)}`);
    },
  },
  {
    name: "iframe-cross-site",
    fixture: "iframe-cross-site.html",
    async run(s) {
      const found = await s.cmd("find", "Frame");
      const [input] = refs(found, /Frame input/);
      const [button] = refs(found, /Frame button/);
      expect(input && button, `find: ${show(found)}`);
      await s.cmd("fill", input, "site-value", "--", "click", button);
      const result = await s.result();
      expect(result?.site?.value === "site-value" && result.site.clicks === 1, `result ${show(result)}`);
    },
  },
  {
    name: "iframe-nested",
    fixture: "iframe-nested.html",
    async run(s) {
      const found = await s.cmd("find", "Frame", "button");
      const [ref] = refs(found, /Frame button/);
      expect(ref, `find: ${show(found)}`);
      await s.cmd("click", ref);
      const result = await s.result();
      expect(result?.leaf?.clicks === 1, `result ${show(result)}`);
    },
  },
  {
    name: "iframe-nested-mixed",
    fixture: "iframe-nested-mixed.html",
    async run(s) {
      const found = await s.cmd("find", "Frame");
      const [input] = refs(found, /Frame input/);
      const [button] = refs(found, /Frame button/);
      expect(input && button && button.split(".").length === 3, `find: ${show(found)}`);
      const middle = button.split(".")[0];
      await s.cmd("fill", input, "mixed-value", "--", "click", button, "--", "click", `${middle} >> role=button[name="Middle button"]`);
      const result = await s.result();
      expect(result?.leaf?.value === "mixed-value" && result.leaf.clicks === 1 && result.mid?.clicks === 1, `result ${show(result)}`);
    },
  },
  {
    name: "popup-window-open",
    fixture: "popups.html",
    cleanup: true,
    async run(s) {
      const out = await s.cmd("click", "#open-popup");
      return expectBackgroundPopup(s, out, (url) => url.includes("via=window.open"));
    },
  },
  {
    name: "popup-target-blank",
    fixture: "popups.html",
    cleanup: true,
    async run(s) {
      const out = await s.cmd("click", "#blank-link");
      return expectBackgroundPopup(s, out, (url) => url.includes("via=link"));
    },
  },
  {
    name: "form-target-blank",
    fixture: "popups.html",
    cleanup: true,
    async run(s) {
      const out = await s.cmd("fill", "#comment", "hi", "there", "--", "click", "#blank-submit");
      const extra = (await s.pages()).filter((page) => page.label !== "p1");
      expect(!extra.length, `opened ${extra.map((page) => page.line).join("; ")} (output: ${show(out)})`);
      const location = (await s.cmd("eval", "location.pathname")).trim();
      expect(location === "/echo", `p1 is at ${location}`);
      const result = await s.result();
      expect(result?.comment === "hi there", `echo ${show(result)}`);
    },
  },
  {
    name: "dialog-alert",
    fixture: "dialogs.html",
    async run(s) {
      const out = await s.cmd("click", "#alert");
      expect(out.includes('alert "Saved!"'), `output ${show(out)}`);
      const result = await s.result();
      expect(result === "alert:closed", `result ${show(result)}`);
    },
  },
  {
    name: "dialog-confirm-dismiss",
    fixture: "dialogs.html",
    async run(s) {
      const out = await s.cmd("click", "#confirm");
      expect(out.includes('confirm "Delete the item?" dismissed'), `output ${show(out)}`);
      const result = await s.result();
      expect(result === "confirm:false", `result ${show(result)}`);
    },
  },
  {
    name: "dialog-confirm-accept",
    fixture: "dialogs.html",
    async run(s) {
      const out = await s.cmd("accept", "--", "click", "#confirm");
      const result = await s.result();
      expect(result === "confirm:true", `result ${show(result)} (output ${show(out)})`);
    },
  },
  {
    name: "dialog-prompt-accept",
    fixture: "dialogs.html",
    async run(s) {
      await s.cmd("accept", "Ada", "--", "click", "#prompt");
      const result = await s.result();
      expect(result === "prompt:Ada", `result ${show(result)}`);
    },
  },
  {
    name: "hover-css-menu",
    fixture: "hover-menu.html",
    async run(s) {
      await s.cmd("hover", "#menu-button", "--", "click", "#settings");
      const result = await s.result();
      expect(result === "settings", `result ${show(result)}`);
    },
  },
  {
    name: "hover-js-reveal",
    fixture: "hover-menu.html",
    async run(s) {
      await s.cmd("hover", "#js-trigger", "--", "click", "#js-action");
      const result = await s.result();
      expect(result === "js-action", `result ${show(result)}`);
    },
  },
  {
    name: "keyboard-shortcut",
    fixture: "keys.html",
    async run(s) {
      await s.cmd("press", "Control+k", "--", "type", "go", "home", "--", "press", "Escape");
      const result = await s.result();
      expect(result?.paletteOpened === 1, `palette not opened: ${show(result)}`);
      expect(result.command === "go home", `command ${show(result.command)}`);
      expect(!result.paletteVisible, "Escape did not close the palette");
      expect(result.keys.every((key) => key.trusted), "untrusted key events");
    },
  },
  {
    name: "upload-hidden-input",
    fixture: "upload.html",
    async run(s) {
      await s.cmd("upload", "#file", path.join(FIXTURES, "upload-a.txt"), path.join(FIXTURES, "upload-b.txt"));
      const result = await s.result();
      const names = result?.files?.map((file) => file.name).join(",");
      expect(names === "upload-a.txt,upload-b.txt", `result ${show(result)}`);
      expect(result.files[0].text.startsWith("hello from arc-browser"), "file content not readable");
    },
  },
  {
    name: "upload-file-chooser",
    fixture: "upload.html",
    async run(s) {
      await s.script(`
const chooser = p.waitForFileChooser({ timeout: 5000 });
await p.click("#pick");
await (await chooser).setFiles([${JSON.stringify(path.join(FIXTURES, "upload-a.txt"))}]);
await p.waitForFunction(() => document.getElementById("result").textContent !== "none", undefined, { timeout: 3000 });`);
      const result = await s.result();
      expect(result?.files?.[0]?.name === "upload-a.txt", `result ${show(result)}`);
    },
  },
  {
    name: "scroll-container",
    fixture: "scroll-container.html",
    async run(s) {
      await s.cmd("click", "#deep-button");
      const result = await s.result();
      expect(result?.clicked && result.panelScrollTop, `result ${show(result)}`);
    },
  },
  {
    name: "sticky-header",
    fixture: "sticky-header.html",
    async run(s) {
      const attempt = await s.attempt("click", "#target");
      const result = await s.result();
      expect(result === "target", `result ${show(result)}${attempt.ok ? "" : ` (${attempt.error})`}`);
    },
  },
  {
    name: "spa-pushstate",
    fixture: "spa/",
    async run(s) {
      await s.cmd("click", 'role=link[name="About"]', "--", "wait", "url:/spa/about", "--", "wait", 'text="About us"');
      const about = await s.result();
      expect(about?.path === "/spa/about" && about.title === "About us", `after click ${show(about)}`);
      await s.cmd("back");
      const home = await s.result();
      expect(home?.path === "/spa/" && home.title === "Home page", `after back ${show(home)}`);
    },
  },
  {
    name: "delayed-autowait",
    fixture: "delayed.html",
    async run(s) {
      await s.cmd("click", "#late");
      const result = await s.result();
      expect(result?.clicked, `result ${show(result)}`);
    },
  },
  {
    name: "delayed-wait",
    fixture: "delayed.html",
    async run(s) {
      await s.cmd("wait", "text=Late button", "--", "click", "text=Late button");
      const result = await s.result();
      expect(result?.clicked && result.after >= 1500, `result ${show(result)}`);
    },
  },
  {
    name: "disabled-until-checked",
    fixture: "disabled.html",
    async run(s) {
      const early = await s.attempt("click", "#submit");
      const before = await s.result();
      expect(before === "none", "disabled button submitted");
      await s.cmd("check", 'role=checkbox[name="I agree to the terms"]', "--", "click", 'role=button[name="Continue"]');
      const result = await s.result();
      expect(result === "submitted", `result ${show(result)}`);
      return early.ok ? `disabled click said ${show(early.out)}` : `disabled click: ${early.error.split("\n")[0]}`;
    },
  },
];

async function isServing(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function oneLine(text, width) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

function printTable(rows) {
  const nameWidth = Math.max(8, ...rows.map((row) => row.name.length));
  const header = `${"scenario".padEnd(nameWidth)} | ${"result".padEnd(6)} | ${"ms".padStart(6)} | note`;
  console.log(`\n${header}\n${"-".repeat(header.length + 40)}`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(nameWidth)} | ${(row.ok ? "pass" : "FAIL").padEnd(6)} | ${String(row.ms).padStart(6)} | ${oneLine(row.note, 90)}`);
  }
}

async function main() {
  const selected = scenarios.filter((scenario) => !filters.length || filters.some((filter) => scenario.name.includes(filter)));
  if (!selected.length) {
    console.error(`No scenario matches ${filters.join(", ")}. Scenarios: ${scenarios.map((scenario) => scenario.name).join(", ")}`);
    process.exit(2);
  }
  const serving = (await isServing(PORTS[0])) && (await isServing(PORTS[1]));
  const server = serving ? null : await startServer();
  let taskId = null;
  let finishing = null;
  const finish = () => {
    finishing ??= taskId ? cli([String(taskId), "finish"]).catch((error) => console.error(`finish failed: ${error.message}`)) : Promise.resolve();
    return finishing;
  };
  const stop = async () => {
    await finish();
    await server?.close();
    process.exit(130);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const rows = [];
  const started = performance.now();
  try {
    const created = await cli(["new", `${BASE}/index.html`, "arc-browser tests"]);
    taskId = Number(/task (\d+)/.exec(created.out)?.[1]);
    if (!taskId) throw new Error(`Could not parse the task id from: ${created.out}`);
    console.log(`task ${taskId}: ${selected.length} scenarios${server ? " (started fixture server)" : ""}`);
    for (const scenario of selected) {
      const session = new Session(taskId);
      const row = { name: scenario.name, ok: false, ms: 0, note: "" };
      if (verbose) console.log(`  ${scenario.name}`);
      try {
        await session.goto(scenario.fixture);
        row.note = (await scenario.run(session)) ?? "";
        row.ok = true;
      } catch (error) {
        row.note = error.message;
      }
      row.ms = session.ms;
      if (scenario.cleanup) await session.closeExtraPages().catch(() => {});
      rows.push(row);
      if (!verbose) process.stdout.write(row.ok ? "." : "F");
    }
  } finally {
    await finish();
    await server?.close();
  }
  printTable(rows);
  const failed = rows.filter((row) => !row.ok);
  const total = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed in ${total}s`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const row of failed) console.log(`- ${row.name}: ${row.note}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
