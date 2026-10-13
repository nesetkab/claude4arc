#!/usr/bin/env node
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer, PORTS } from "./serve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "claude4arc.js");
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

function execCli(argv, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...argv], { timeout: CALL_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout: stdout.trim(), stderr: stderr.trim(), killed: Boolean(error?.killed) });
    });
    if (input !== undefined) child.stdin.end(input);
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
  if (verbose) console.log(`    ${String(ms).padStart(6)}ms  claude4arc ${argv.join(" ")}`.slice(0, 160));
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

  async batch(lines, ...argv) {
    const started = performance.now();
    const result = await execCli(["batch", ...argv], lines.join("\n"));
    const ms = Math.round(performance.now() - started);
    this.ms += ms;
    if (verbose) console.log(`    ${String(ms).padStart(6)}ms  claude4arc batch ${argv.join(" ")}`);
    if (result.killed) throw new Error(`batch timed out after ${CALL_TIMEOUT}ms`);
    return result;
  }

  async probe() {
    return parseJson(await this.cmd("eval", "JSON.stringify(window.probe?.() ?? null)"));
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

function batchSections(output) {
  return output
    .split(/^== /m)
    .slice(1)
    .map((chunk) => {
      const [header, ...body] = chunk.split("\n");
      const match = /^(\S+) (ok|FAILED) (\d+)-(\d+) \((\d+) ms\)$/.exec(header);
      return { label: match?.[1] ?? header, ok: match ? match[2] === "ok" : null, start: Number(match?.[3]), end: Number(match?.[4]), body: body.join("\n") };
    });
}

const RICH_TEXT = "Dear team,\nThe report is ready.\nThanks";
const CODE_TEXT = "function add(a, b) {\n  return a + b;\n}\n";
const TYPED_TEXT = "Typed one\nTyped two";

const EDITORS = [
  ["lexical", "lexical.html", "#editor", "#editor", RICH_TEXT],
  ["prosemirror", "prosemirror.html", "#editor", ".ProseMirror", RICH_TEXT],
  ["ckeditor5", "ckeditor5.html", ".ck-editor__editable", ".ck-editor__editable", RICH_TEXT],
  ["tinymce", "tinymce.html", ".tox-tinymce", ".tox-edit-area iframe", RICH_TEXT],
  ["ace", "ace.html", "#editor", "#editor", CODE_TEXT],
  ["codemirror5", "codemirror5.html", ".CodeMirror", ".CodeMirror", CODE_TEXT],
];

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
    platform: "darwin",
    async run(s) {
      await s.cmd("click", "#editor", "--", "press", "Meta+a", "--", "type", "Typed", "text");
      const result = await s.result();
      expect(result?.text === "Typed text", `text ${show(result?.text ?? result)}`);
      expect(result.beforeinput > 0, `no beforeinput events: ${show(result)}`);
    },
  },
  ...[
    ["editor-fill-codemirror6", "codemirror.html", ".cm-content", ".cm-content"],
    ["editor-fill-monaco", "monaco.html", ".monaco-editor .view-lines", "#editor"],
  ].map(([name, fixture, ready, target]) => ({
    name,
    fixture,
    async run(s) {
      await s.cmd("wait", ready, "20000");
      const text = await s.cmd("text");
      expect(text.includes("const line250 = 250;"), `text misses the last line: ${show(text.slice(-160))}`);
      const code = "function add(a, b) {\n  return [a, b].reduce((x, y) => x + y);\n}\n";
      const out = await s.cmd("fill", target, code);
      expect(out === "ok", `fill said ${show(out)}`);
      const result = await s.result();
      expect(result?.value === code, `value ${show(result?.value ?? result)}`);
      expect(result.changes > 0, `no change events: ${show(result)}`);
    },
  })),
  {
    name: "editor-fill-quill",
    fixture: "quill.html",
    async run(s) {
      await s.cmd("wait", ".ql-editor", "20000");
      const out = await s.cmd("fill", ".ql-editor", "Hello\nfrom Arc");
      expect(out === "ok", `fill said ${show(out)}`);
      const result = await s.result();
      expect(result?.value === "Hello\nfrom Arc", `value ${show(result?.value ?? result)}`);
      expect(result.changes > 0, `no text-change events: ${show(result)}`);
    },
  },
  ...EDITORS.flatMap(([kind, fixture, fillTarget, typeTarget, text]) => [
    {
      name: `editor-fill-${kind}`,
      fixture,
      async run(s) {
        await s.cmd("wait", "css=body[data-ready]", "30000");
        const before = await s.probe();
        expect(before?.value?.startsWith("Old") || before?.value?.startsWith("const old"), `initial value ${show(before)}`);
        const out = await s.cmd("fill", fillTarget, text);
        expect(out === "ok", `fill said ${show(out)}`);
        const filled = await s.probe();
        expect(filled?.value === text, `value ${show(filled?.value ?? filled)}`);
        expect(filled.changes > 0, `no change events: ${show(filled)}`);
        const again = await s.cmd("fill", fillTarget, "Replaced");
        expect(again === "ok", `second fill said ${show(again)}`);
        const replaced = await s.probe();
        expect(replaced?.value === "Replaced", `after second fill ${show(replaced?.value ?? replaced)}`);
        return filled.keys ? "via keyboard fallback" : "via editor API";
      },
    },
    {
      name: `editor-type-${kind}`,
      fixture,
      platform: "darwin",
      async run(s) {
        await s.cmd("wait", "css=body[data-ready]", "30000");
        await s.cmd("click", typeTarget, "--", "press", "Meta+a", "--", "type", TYPED_TEXT);
        const result = await s.probe();
        expect(result?.value === TYPED_TEXT, `value ${show(result?.value ?? result)}`);
        expect(result.keys > 0 && result.untrusted === 0, `keys ${result.keys}, untrusted ${result.untrusted}`);
        expect(result.changes > 0, `no change events: ${show(result)}`);
      },
    },
  ]),
  {
    name: "editor-fill-prosemirror-global-view",
    fixture: "prosemirror.html?global",
    async run(s) {
      await s.cmd("wait", "css=body[data-ready]", "30000");
      const out = await s.cmd("fill", ".ProseMirror", RICH_TEXT);
      expect(out === "ok", `fill said ${show(out)}`);
      const result = await s.probe();
      expect(result?.value === RICH_TEXT, `value ${show(result?.value ?? result)}`);
      expect(result.keys === 0, `fill used the keyboard (${result.keys} keydowns) instead of window.view`);
    },
  },
  {
    name: "dnd-cli-drag",
    fixture: "dnd.html",
    async run(s) {
      await s.cmd("drag", "#item-b", "#bin");
      const result = await s.result();
      expect(result?.trashed === "Bravo", `result ${show(result)}`);
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
      const found = await s.cmd("seek", "Row 500");
      const [ref] = refs(found, /button "Row 500"/);
      expect(ref, `seek: ${show(found)}`);
      await s.cmd("click", ref);
      const result = await s.result();
      expect(result === "row 500", `result ${show(result)}`);
    },
  },
  {
    name: "virtual-list-seek-container",
    fixture: "virtual-list.html",
    async run(s) {
      await s.cmd("seek", '[data-row="240"] button', "#viewport", "--", "click", 'text="Row 240"');
      const result = await s.result();
      expect(result === "row 240", `result ${show(result)}`);
    },
  },
  {
    name: "infinite-seek",
    fixture: "infinite-list.html",
    async run(s) {
      const found = await s.cmd("seek", "#item-150");
      const [ref] = refs(found, /Item 150/);
      expect(ref, `seek: ${show(found)}`);
      await s.cmd("click", ref);
      const result = await s.result();
      expect(result === "clicked 150", `result ${show(result)}`);
      const missing = await s.attempt("seek", "#item-999");
      expect(!missing.ok && /reached the end/.test(missing.error), `missing item: ${show(missing)}`);
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
    name: "popup-opener-relay",
    fixture: "oauth-opener.html",
    async run(s) {
      const out = await s.cmd("click", "#login", "--", "wait", "css=#result:not(:empty)", "8000");
      expect(out.includes("popup"), `output ${show(out)}`);
      const result = await s.result();
      expect(result?.token === "abc123" && result.origin.endsWith(String(Number(BASE.split(":").at(-1)) + 1)), `result ${show(result)}`);
      const pages = await s.pages();
      expect(pages.length === 1, `popup tab still open: ${pages.map((page) => page.line).join("; ")}`);
    },
  },
  {
    name: "no-intrusion",
    fixture: "intrusive.html",
    platform: "darwin",
    async run(s) {
      const { execFileSync } = await import("node:child_process");
      const before = execFileSync("pbpaste", { encoding: "utf8" });
      const outputs = [];
      for (const id of ["copy-api", "copy-exec", "print", "fullscreen", "mail", "notify", "locate", "picker"]) outputs.push(await s.cmd("click", `#${id}`));
      const joined = outputs.join("\n");
      for (const expected of ["secret from api", "secret from exec", "blocked print dialog", "blocked fullscreen", "blocked external link: mailto:", "notifications denied", "location denied", "blocked file chooser"]) {
        expect(joined.includes(expected), `missing ${show(expected)} in ${show(joined)}`);
      }
      expect(execFileSync("pbpaste", { encoding: "utf8" }) === before, "the user's clipboard changed");
      expect((await s.pages()).length === 1, "an extra page opened");
    },
  },
  {
    name: "download-wait",
    fixture: "download.html",
    async run(s) {
      await s.cmd("click", "#file");
      const out = await s.cmd("wait", "download", "15000", "forget");
      const match = /download complete: (.+) \(\d+ bytes\)/.exec(out);
      expect(match, `output ${show(out)}`);
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(match[1], "utf8");
      expect(content.startsWith("claude4arc download test"), `content ${show(content)}`);
      await fs.rm(match[1], { force: true });
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
      expect(result.files[0].text.startsWith("hello from claude4arc"), "file content not readable");
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
    name: "modal-scroll-check",
    fixture: "modal-scroll.html",
    async run(s) {
      await s.cmd("check", "text=Share usage data", "--", "click", "text=Save");
      const result = await s.result();
      expect(result === "checked", `result ${show(result)}`);
    },
  },
  {
    name: "hidden-tab-hint",
    fixture: "hidden-tab.html",
    async run(s) {
      const attempt = await s.attempt("click", "text=Rotate keys");
      expect(!attempt.ok && /hidden tab panel: open the tab first \(@\d+ tab "Security"\)/.test(attempt.error), `error ${show(attempt.error)}`);
    },
  },
  {
    name: "seek-pages",
    fixture: "paged-list.html",
    async run(s) {
      const found = await s.cmd("seek", "Invoice 1034");
      expect(/Invoice 1034.*\(page 4\)/.test(found), `seek ${show(found)}`);
      await s.cmd("click", 'text="Invoice 1034"');
      const result = await s.result();
      expect(result === "Invoice 1034", `result ${show(result)}`);
    },
  },
  {
    name: "css-has-text-descendant",
    fixture: "price-table.html",
    async run(s) {
      await s.cmd("click", 'css=tr:has-text("Paper clips") button');
      const result = await s.result();
      expect(result === "Paper clips", `result ${show(result)}`);
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
  {
    name: "popup-wait-agent-window-open",
    fixture: "popups.html",
    cleanup: true,
    async run(s) {
      const out = await s.script(`
const [popup, receipt] = await Promise.all([p.waitForEvent("popup", { timeout: 10000 }), p.click("#open-popup")]);
const pages = await t.pages();
console.log(JSON.stringify({ label: popup.label, url: await popup.url(), receipt: receipt.popups.map((item) => item.label), labels: pages.filter((page) => page.tabId === popup.tabId).map((page) => page.label) }));`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result?.label && result.url.includes("via=window.open"), `popup ${show(out)}`);
      expect(result.receipt.length === 1 && result.receipt[0] === result.label, `receipt ${show(result)}`);
      expect(result.labels.length === 1, `popup tab has labels ${show(result.labels)}`);
    },
  },
  {
    name: "popup-wait-agent-target-blank",
    fixture: "popups.html",
    cleanup: true,
    async run(s) {
      const out = await s.script(`
const [popup] = await Promise.all([p.waitForEvent("popup", { timeout: 10000 }), p.click("#blank-link")]);
console.log(JSON.stringify({ label: popup.label, url: await popup.url() }));`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result?.label && result.url.includes("via=link"), `popup ${show(out)}`);
    },
  },
  {
    name: "popup-adopted-single-label",
    fixture: "index.html",
    async run(s) {
      const out = await s.script(`
const tab = await t.bridge.call("tabs.create", { url: ${JSON.stringify(`${BASE}/popups.html`)}, active: true });
let popup = null;
try {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const user = await t.adopt(tab.id, { as: "u1" });
  let receipt;
  [popup, receipt] = await Promise.all([user.waitForEvent("popup", { timeout: 10000 }), user.click("#blank-link")]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pages = await t.pages();
  console.log(JSON.stringify({ label: popup.label, receipt: receipt.popups.map((item) => item.label), labels: pages.filter((page) => page.tabId === popup.tabId).map((page) => page.label) }));
} finally {
  if (popup) await popup.close().catch(() => {});
  await t.release("u1").catch(() => {});
  await t.bridge.call("tabs.remove", tab.id).catch(() => {});
}`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result?.label, `no popup ${show(out)}`);
      expect(result.labels.length === 1 && result.labels[0] === result.label, `popup tab has labels ${show(result.labels)}`);
      expect(result.receipt.every((label) => label === result.label), `receipt ${show(result)}`);
    },
  },
  {
    name: "seek-growing-capped",
    fixture: "live-log.html",
    async run(s) {
      const out = await s.script(`
await p.evaluate("document.getElementById('start').click()");
const started = Date.now();
const error = await p.seek("#nope", { timeout: 4000, idle: 1500 }).then(() => null, (error) => error.message);
console.log(JSON.stringify({ error, ms: Date.now() - started }));`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result?.error && /No match for #nope/.test(result.error), `seek ${show(out)}`);
      expect(result.ms < 15000, `seek took ${result.ms}ms`);
    },
  },
  {
    name: "seek-growth-stops",
    fixture: "live-log.html?ticks=4",
    async run(s) {
      const out = await s.script(`
await p.evaluate("document.getElementById('start').click()");
const started = Date.now();
const error = await p.seek("#nope", { timeout: 20000, idle: 1500 }).then(() => null, (error) => error.message);
console.log(JSON.stringify({ error, ms: Date.now() - started }));`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result?.error && /reached the end/.test(result.error), `seek ${show(out)}`);
      expect(result.ms < 15000, `seek took ${result.ms}ms`);
    },
  },
  {
    name: "iframe-cross-press-button-once",
    fixture: "iframe-cross.html",
    async run(s) {
      const found = await s.cmd("find", "Frame", "button");
      const [ref] = refs(found, /Frame button/);
      expect(ref && ref.includes("."), `find: ${show(found)}`);
      await s.cmd("press", ref, "Enter", "--", "wait", "300");
      const result = await s.result();
      expect(result?.cross?.clicks === 1, `Enter activated the frame button ${result?.cross?.clicks ?? 0} times: ${show(result)}`);
    },
  },
  {
    name: "iframe-cross-press-submit-once",
    fixture: "iframe-cross.html",
    async run(s) {
      const found = await s.cmd("find", "Cross", "frame");
      const [frame] = refs(found, /^@[\d.]+ iframe /);
      expect(frame, `no iframe ref: ${show(found)}`);
      await s.cmd("fill", `${frame} >> #q`, "pressed", "--", "press", `${frame} >> #send`, "Enter", "--", "wait", "300");
      const result = await s.result();
      expect(result?.cross?.submitted === "pressed" && result.cross.value === "pressed", `result ${show(result)}`);
    },
  },
  {
    name: "fetch-save-non-ok",
    fixture: "index.html",
    async run(s) {
      const os = await import("node:os");
      const fs = await import("node:fs");
      const missing = path.join(os.tmpdir(), `claude4arc-e2e-missing-${Date.now()}.bin`);
      const present = path.join(os.tmpdir(), `claude4arc-e2e-present-${Date.now()}.txt`);
      try {
        const out = await s.script(`
const error = await p.fetch("/no-such-file.bin", { saveAs: ${JSON.stringify(missing)} }).then(() => null, (error) => error.message);
const saved = await p.fetch("/upload-a.txt", { saveAs: ${JSON.stringify(present)} });
console.log(JSON.stringify({ error, savedTo: saved.savedTo }));`);
        const result = parseJson(out.split("\n").at(-1));
        expect(result?.error && /HTTP 404/.test(result.error), `error ${show(out)}`);
        expect(!fs.existsSync(missing), "the 404 body was written to disk");
        expect(result.savedTo === present && fs.existsSync(present), `ok fetch was not saved: ${show(result)}`);
      } finally {
        fs.rmSync(missing, { force: true });
        fs.rmSync(present, { force: true });
      }
    },
  },
  {
    name: "navigation-timeout-no-crash",
    fixture: "index.html",
    async run(s) {
      const out = await s.script(`
const error = await p.reload({ timeout: 1 }).then(() => null, (error) => error.message);
await p.waitForLoadState("load", { timeout: 10000 });
console.log(JSON.stringify({ error }));`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result && "error" in result, `script output ${show(out)}`);
      expect(result.error === null || /Navigation did not reach "load"/.test(result.error), `error ${show(result.error)}`);
    },
  },
  {
    name: "type-emoji-cjk-accents",
    fixture: "typing.html",
    async run(s) {
      const text = "Hi 👋🏽 日本語 café Ünïcode";
      await s.cmd("click", "#box", "--", "type", text);
      const result = await s.result();
      expect(result?.value === text, `value ${show(result?.value ?? result)}`);
      expect(result.inputs > 0, `no input events: ${show(result)}`);
      expect(result.keys.every((key) => key.trusted), "untrusted key events");
    },
  },
  {
    name: "press-shift-text",
    fixture: "typing.html",
    async run(s) {
      await s.cmd("click", "#box", "--", "press", "Shift+a", "--", "press", "Shift+1", "--", "press", "Shift+/", "--", "press", "b");
      const result = await s.result();
      expect(result?.value === "A!?b", `value ${show(result?.value ?? result)}`);
      const shifted = result.keys.filter((key) => key.code === "KeyA" || key.code === "Digit1");
      expect(shifted.every((key) => key.shift) && shifted.map((key) => key.key).join("") === "A!", `keys ${show(result.keys)}`);
    },
  },
  {
    name: "press-bad-chord-releases-modifiers",
    fixture: "typing.html",
    async run(s) {
      const bad = await s.attempt("press", "Meta+Foo");
      expect(!bad.ok && /Unknown key: Foo/.test(bad.error), `bad chord said ${show(bad)}`);
      await s.cmd("click", "#box", "--", "type", "ok");
      const result = await s.result();
      expect(result?.value === "ok", `Meta stayed held? value ${show(result?.value ?? result)}`);
    },
  },
  {
    name: "drag-points-html5",
    fixture: "drag-points.html",
    async run(s) {
      const points = JSON.parse(
        await s.cmd(
          "eval",
          "JSON.stringify([document.getElementById('card-b'), document.getElementById('zone')].map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)].join(','); }))",
        ),
      );
      await s.cmd("drag", points[0], points[1]);
      const result = await s.result();
      expect(result?.started === "card-b", `no dragstart: ${show(result)}`);
      expect(result.dropped === "card-b" && result.inZone?.includes("card-b"), `result ${show(result)}`);
    },
  },
  {
    name: "wait-without-argument",
    fixture: "typing.html",
    async run(s) {
      const out = await s.attempt("wait");
      expect(!out.ok && /^Usage: wait/.test(out.error), `wait said ${show(out)}`);
    },
  },
  {
    name: "opacity-zero-checkboxes",
    fixture: "opacity-controls.html",
    async run(s) {
      const snap = await s.cmd("snap");
      for (const name of ["Remember me", "Send me news", "I accept the terms"]) {
        expect(snap.includes(`checkbox "${name}"`), `snap misses checkbox ${show(name)}: ${show(snap)}`);
      }
      await s.cmd("check", "#remember", "--", "check", "#news", "--", "check", "#terms");
      const result = await s.result();
      expect(result?.remember === true && result.news === true && result.terms === true, `result ${show(result)}`);
      const after = await s.cmd("snap");
      expect(/checkbox "Remember me" \[checked/.test(after) && /checkbox "Send me news" \[checked/.test(after), `snap after ${show(after)}`);
      await s.cmd("uncheck", "#news");
      const unchecked = await s.result();
      expect(unchecked?.news === false && unchecked.remember === true, `after uncheck ${show(unchecked)}`);
    },
  },
  {
    name: "seek-pages-skips-carousel",
    fixture: "pager-trap.html",
    async run(s) {
      const found = await s.cmd("seek", "Invoice 1023");
      expect(/Invoice 1023.*\(page 5\)/.test(found), `seek ${show(found)}`);
      const state = await s.result();
      expect(state?.page === 5 && state.carousel === 0 && state.wizard === 0, `clicked the wrong next control: ${show(state)}`);
    },
  },
  {
    name: "svg-links",
    fixture: "inpage-misc.html",
    async run(s) {
      const links = await s.cmd("links");
      expect(links.includes("via=svg") && links.includes("via=html"), `links ${show(links)}`);
      await s.cmd("click", "loc=href:via=html");
      expect((await s.result()) === "html-link", `html link click ${show(await s.result())}`);
      await s.cmd("click", "loc=href:via=svg");
      expect((await s.result()) === "svg-link", `svg link click ${show(await s.result())}`);
    },
  },
  {
    name: "css-text-pseudo-combinators",
    fixture: "text-pseudo.html",
    async run(s) {
      await s.cmd("click", 'css=ul > :has-text("Beta")');
      expect((await s.result()) === "Beta", `ul > :has-text: ${show(await s.result())}`);
      await s.cmd("click", 'css=form :has-text("Submit")');
      expect((await s.result()) === "submitted", `form :has-text: ${show(await s.result())}`);
      await s.cmd("click", 'css=tr:has-text("Bolts") :text-is("Buy")');
      expect((await s.result()) === "Bolts:Buy", `tr :text-is: ${show(await s.result())}`);
      await s.cmd("click", 'css=div.card:has-text("Pro"):has-text("Yearly") button');
      expect((await s.result()) === "Pro-Yearly", `chained :has-text: ${show(await s.result())}`);
    },
  },
  {
    name: "snap-keeps-repeated-cells",
    fixture: "inpage-misc.html",
    async run(s) {
      const snap = await s.cmd("snap");
      const lines = snap.split("\n").map((line) => line.trim());
      const at = lines.indexOf("Exports");
      expect(at >= 0 && lines.slice(at + 1, at + 4).join(" ") === "Yes Yes No", `grid row ${show(lines.slice(Math.max(0, at), at + 4))}`);
    },
  },
  {
    name: "role-long-name",
    fixture: "inpage-misc.html",
    async run(s) {
      const name = "I have read and agree to the terms of service, the privacy policy, and the acceptable use policy for this workspace";
      await s.cmd("click", `role=button[name="${name}"]`);
      expect((await s.result()) === "long", `exact name: ${show(await s.result())}`);
      await s.cmd("eval", "document.getElementById('result').textContent = 'none'");
      await s.cmd("click", 'role=button[name$="policy for this workspace"]');
      expect((await s.result()) === "long", `suffix name: ${show(await s.result())}`);
    },
  },
  {
    name: "table-ref-without-table",
    fixture: "inpage-misc.html",
    async run(s) {
      const miss = await s.attempt("table", "#notes");
      expect(!miss.ok && /is not a table/.test(miss.error), `table #notes: ${show(miss)}`);
      const scoped = await s.cmd("table", "#prices");
      expect(/Pro\t12/.test(scoped), `table #prices: ${show(scoped)}`);
      const fallback = await s.cmd("table");
      expect(/Pro\t12/.test(fallback), `table: ${show(fallback)}`);
    },
  },
  {
    name: "text-strict-csp",
    fixture: "csp-text.html",
    async run(s) {
      const text = await s.cmd("text");
      expect(text.includes("Orders ship within two days."), `text ${show(text)}`);
      expect(!text.includes("decorative-glyph") && !text.includes("Atlantis"), `hidden text leaked: ${show(text)}`);
      const styles = await s.cmd("eval", "document.adoptedStyleSheets.length + document.querySelectorAll('style').length");
      expect(String(styles).trim() === "0", `left styles behind: ${show(styles)}`);
    },
  },
  {
    name: "batch-lines-finish",
    fixture: "index.html",
    async run(s) {
      const marker = `batch${Date.now()}`;
      const result = await s.batch([
        `form: goto ${BASE}/react-form.html?${marker} -- fill #name Ada -- fill #email ada@example.com -s`,
        "# comments and blank lines are skipped",
        "",
        "wait #missing-field 500",
        `last: eval "document.querySelector('#name').value"`,
      ]);
      const taskId = /^task (\d+)$/m.exec(result.stdout)?.[1];
      expect(taskId && taskId !== String(s.taskId), `batch task ${show(result.stdout.split("\n")[0])}`);
      expect(result.code === 1, `exit ${result.code} with one failed line (${show(result.stderr)})`);
      const sections = batchSections(result.stdout);
      expect(sections.map((section) => section.label).join(",") === "form,2,last,finish", `sections ${show(sections.map((section) => section.label))}`);
      const [form, failed, last, finish] = sections;
      expect(form.ok && /textbox "Full name".*="Ada"/.test(form.body) && /textbox "Email".*="ada@example.com"/.test(form.body), `form line has no -s snapshot: ${show(form)}`);
      expect(failed.ok === false && /^Error: .*#missing-field/.test(failed.body), `failed line ${show(failed)}`);
      expect(last.ok && last.body.trim() === "Ada", `last line ${show(last)}`);
      expect(form.start <= form.end && form.end <= failed.start && failed.end <= last.start, `timestamps ${show(sections)}`);
      expect(/^closed p1 kept - released -$/.test(finish.body.trim()), `finish ${show(finish.body)}`);
      const gone = await cli([taskId, "pages"]).then(
        (done) => done.out,
        (error) => error.message,
      );
      expect(/does not exist/.test(gone), `batch task still exists: ${show(gone)}`);
      const open = await s.script(`console.log((await t.bridge.call("tabs.query", {})).filter((tab) => tab.url?.includes(${JSON.stringify(marker)})).length);`);
      expect(open.trim().split("\n").at(-1) === "0", `batch tab still open (${show(open)})`);
    },
  },
  {
    name: "batch-existing-task-keeps",
    fixture: "index.html",
    async run(s) {
      const result = await s.batch([`goto ${BASE}/typing.html -- fill #box kept -- eval "document.getElementById('box').value"`], String(s.taskId));
      expect(result.code === 0, `exit ${result.code}: ${show(result.stderr || result.stdout)}`);
      const sections = batchSections(result.stdout);
      expect(sections.length === 1 && sections[0].ok && sections[0].body.trim().endsWith("kept"), `sections ${show(sections)}`);
      expect(new RegExp(`^task ${s.taskId}$`, "m").test(result.stdout), `batch used another task: ${show(result.stdout)}`);
      const value = await s.cmd("eval", "document.getElementById('box').value");
      expect(value === "kept", `task was finished or moved: ${show(value)}`);
    },
  },
  {
    name: "paste-restores-clipboard",
    fixture: "typing.html",
    platform: "darwin",
    async run(s) {
      const { execFileSync } = await import("node:child_process");
      const original = execFileSync("pbpaste", { encoding: "utf8" });
      const sentinel = `claude4arc clipboard sentinel ${Date.now()}`;
      const text = "Pasted line one\nPasted line two";
      try {
        execFileSync("pbcopy", { input: sentinel });
        await s.script(`await p.click("#box");\nawait p.keyboard.paste(${JSON.stringify(text)});`);
        const after = execFileSync("pbpaste", { encoding: "utf8" });
        expect(after === sentinel, `clipboard holds ${show(after.slice(0, 80))} after paste`);
        const result = await s.result();
        expect(result?.value === text, `pasted value ${show(result?.value ?? result)}`);
        expect(result.inputs > 0, `no input events: ${show(result)}`);
      } finally {
        execFileSync("pbcopy", { input: original });
      }
    },
  },
  {
    name: "popup-adopted-background-tab",
    fixture: "index.html",
    async run(s) {
      const out = await s.script(`
const tab = await t.bridge.call("tabs.create", { url: ${JSON.stringify(`${BASE}/popups.html`)}, active: false });
let popup = null;
try {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const user = await t.adopt(tab.id, { as: "u1" });
  let receipt;
  [popup, receipt] = await Promise.all([user.waitForEvent("popup", { timeout: 10000 }), user.click("#blank-link")]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pages = await t.pages();
  const info = await t.bridge.call("tabs.get", popup.tabId);
  const opener = await t.bridge.call("tabs.get", tab.id);
  console.log(JSON.stringify({ label: popup.label, receipt: receipt.popups.map((item) => item.label), labels: pages.filter((page) => page.tabId === popup.tabId).map((page) => page.label), count: pages.filter((page) => page.label !== "p1" && page.label !== "u1").length, active: info.active, openerTabId: info.openerTabId, url: info.url, openerActive: opener.active, tabId: tab.id }));
} finally {
  if (popup) await popup.close().catch(() => {});
  await t.release("u1").catch(() => {});
  await t.bridge.call("tabs.remove", tab.id).catch(() => {});
}`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result?.label, `no popup ${show(out)}`);
      expect(result.labels.length === 1 && result.labels[0] === result.label && result.count === 1, `popup labels ${show(result)}`);
      expect(result.receipt.length === 1 && result.receipt[0] === result.label, `receipt ${show(result)}`);
      expect(!result.active && !result.openerActive, `focus moved ${show(result)}`);
      expect(result.openerTabId === result.tabId && /via=link/.test(result.url), `popup ${show(result)}`);
      return `${result.label} ${result.url.split("/").at(-1)}`;
    },
  },
  {
    name: "popup-adopted-background-dialog",
    fixture: "index.html",
    async run(s) {
      const out = await s.script(`
const tab = await t.bridge.call("tabs.create", { url: ${JSON.stringify(`${BASE}/popups.html`)}, active: false });
let popup = null;
try {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const user = await t.adopt(tab.id, { as: "u1" });
  await user.evaluate("document.getElementById('blank-link').addEventListener('click', () => alert('leaving'))");
  const waiting = user.waitForEvent("popup", { timeout: 10000 });
  const receipt = await user.click("#blank-link");
  await user.acceptDialog();
  popup = await waiting;
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pages = await t.pages();
  const info = await t.bridge.call("tabs.get", popup.tabId);
  const trap = await user.evaluate("typeof globalThis.__arcPopupTrap");
  console.log(JSON.stringify({ dialog: receipt.dialog?.message, label: popup.label, count: pages.filter((page) => page.label !== "p1" && page.label !== "u1").length, active: info.active, openerTabId: info.openerTabId, url: info.url, tabId: tab.id, trap }));
} finally {
  if (popup) await popup.close().catch(() => {});
  await t.release("u1").catch(() => {});
  await t.bridge.call("tabs.remove", tab.id).catch(() => {});
}`);
      const result = parseJson(out.split("\n").at(-1));
      expect(result?.label, `no popup ${show(out)}`);
      expect(result.dialog === "leaving", `dialog ${show(result)}`);
      expect(result.count === 1 && !result.active && result.openerTabId === result.tabId && /via=link/.test(result.url), `popup ${show(result)}`);
      expect(result.trap === "undefined", `trap left in page ${show(result)}`);
      return `${result.label} after dialog`;
    },
  },
  {
    name: "text-target-hidden-tab-switch",
    fixture: "text-targets.html",
    async run(s) {
      const act = async (method, ...args) => {
        const out = await s.script(`console.log(JSON.stringify(await p.${method}(...${JSON.stringify(args)})));`);
        return parseJson(out.split("\n").at(-1))?.target ?? out;
      };
      const early = await s.attempt("check", "text=Paperless billing");
      expect(!early.ok && /hidden tab panel: open the tab first \(@\d+ tab "Billing"\)/.test(early.error), `hidden check: ${show(early)}`);
      const tab = await act("click", "text=Billing");
      expect(/tab "Billing"/.test(tab), `tab receipt ${show(tab)}`);
      const toggled = await act("check", "text=Paperless billing");
      expect(/switch "Paperless billing"/.test(toggled), `switch receipt ${show(toggled)}`);
      const filled = await act("fill", "text=Billing email", "ap@example.com");
      expect(/textbox "Billing email"/.test(filled), `fill receipt ${show(filled)}`);
      const billing = await s.result();
      expect(billing?.tab === "t2" && billing.paperless === true && billing.bill === "ap@example.com", `billing ${show(billing)}`);
      const general = await act("click", "text=General");
      expect(/tab "\* General"/.test(general), `general receipt ${show(general)}`);
      const receipts = await act("check", "text=Email receipts");
      expect(/switch "Email receipts"/.test(receipts), `label switch receipt ${show(receipts)}`);
      const renew = await act("click", "text=Auto-renew plan");
      expect(/checkbox "Auto-renew plan"/.test(renew), `wrapped checkbox receipt ${show(renew)}`);
      const result = await s.result();
      expect(result?.tab === "t1" && result.receipts === true && result.renew === true && result.paperless === true, `result ${show(result)}`);
      await s.cmd("uncheck", "text=Email receipts");
      expect((await s.result())?.receipts === false, `uncheck ${show(await s.result())}`);
    },
  },
  {
    name: "text-target-card-radio",
    fixture: "card-radios.html",
    async run(s) {
      const act = async (method, ...args) => {
        const out = await s.script(`console.log(JSON.stringify(await p.${method}(...${JSON.stringify(args)})));`);
        return parseJson(out.split("\n").at(-1))?.target ?? out;
      };
      const team = await act("click", "text=Team");
      expect(/radio "Team up to 8 desks"/.test(team), `team receipt ${show(team)}`);
      expect((await s.result())?.plan === "Team", `team ${show(await s.result())}`);
      const office = await act("check", "text=Office");
      expect(/radio "Office private room"/.test(office), `office receipt ${show(office)}`);
      expect((await s.result())?.plan === "Office", `office ${show(await s.result())}`);
      const yearly = await act("click", "text=Yearly");
      expect(/radio "Yearly two months free"/.test(yearly), `yearly receipt ${show(yearly)}`);
      await s.cmd("check", "text=Monthly");
      const result = await s.result();
      expect(result?.plan === "Office" && result.period === "monthly", `result ${show(result)}`);
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
  const matching = scenarios.filter((scenario) => !filters.length || filters.some((filter) => scenario.name.includes(filter)));
  if (!matching.length) {
    console.error(`No scenario matches ${filters.join(", ")}. Scenarios: ${scenarios.map((scenario) => scenario.name).join(", ")}`);
    process.exit(2);
  }
  const selected = matching.filter((scenario) => !scenario.platform || scenario.platform === process.platform);
  const skipped = matching.filter((scenario) => !selected.includes(scenario));
  if (skipped.length) console.log(`skipped on ${process.platform}: ${skipped.map((scenario) => `${scenario.name} (${scenario.platform} only)`).join(", ")}`);
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
    const created = await cli(["new", `${BASE}/index.html`, "claude4arc tests"]);
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
