import { Task } from "./task.js";
import { html5Drag, looksDraggable } from "./dnd.js";

const SELECTOR_START = /^(?:@|ref=|text=|role=|css=|xpath=|loc=|#|\.|\[)/;

const number = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

export function receiptText(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const parts = [];
  for (const popup of receipt.popups ?? []) parts.push(`popup ${popup.label}${popup.via ? ` (${popup.via})` : ""}`);
  if (receipt.navigated) parts.push(`navigated → ${receipt.navigated}`);
  for (const blocked of receipt.blocked ?? []) {
    parts.push(blocked.kind === "clipboard" ? `copied (kept off the user's clipboard): ${JSON.stringify(blocked.detail)}` : `blocked ${blocked.kind}: ${blocked.detail}`);
  }
  for (const download of receipt.downloads ?? []) parts.push(`download started: ${download} (run "wait download" for the file path)`);
  if (receipt.disabled) parts.push(`note: ${receipt.target} is disabled; the click may have done nothing`);
  if (receipt.warning) parts.push(`warning: ${receipt.warning}`);
  if (receipt.dialog) parts.push(`dialog ${receipt.dialog.type}: "${receipt.dialog.message}"`);
  for (const dialog of receipt.dialogs ?? []) {
    const outcome = dialog.type === "alert" ? "shown" : dialog.accepted ? "accepted" : "dismissed (to accept: accept -- <action>)";
    parts.push(`${dialog.type} "${dialog.message}" ${outcome}`);
  }
  return parts.length ? parts.join("\n") : null;
}

async function noticing(page, work) {
  const before = new Set(await page._notices());
  const result = await work();
  await page.settle({ quiet: 80, max: 400 }).catch(() => {});
  const fresh = (await page._notices()).filter((text) => !before.has(text));
  const lines = fresh.map((text) => `page now shows: ${JSON.stringify(text)} (check that the input was accepted)`);
  return [result, ...lines].filter(Boolean).join("\n") || null;
}

function tabLine(tab) {
  return `${tab.label ?? "-"} ${tab.tabId}${tab.active ? "*" : ""} ${tab.title?.slice(0, 50) ?? ""} | ${tab.url}`;
}

const POINT = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/;

const pointOf = (value) => {
  const match = POINT.exec(value ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};

const COMMANDS = {
  goto: async ({ page }, [url]) => {
    const result = await page.goto(url);
    return `${result.title} | ${result.url}`;
  },
  snap: ({ page }, args) => {
    const [mode, ...rest] = args;
    if (mode === "diff") return page.snapshot({ diff: true });
    if (mode === "full") return page.snapshot({ scope: "full_page", root: rest.join(" ").trim() || undefined });
    const root = args.join(" ").trim();
    return page.snapshot(root ? { root } : {});
  },
  diff: ({ page }) => page.snapshot({ diff: true }),
  find: ({ page }, words) => page.find(words.join(" ")),
  table: ({ page }, args) => page.table(args.join(" ").trim() || undefined),
  links: ({ page }, words) => page.links(words.join(" ")),
  seek: ({ page }, args) => {
    const container = args.length === 2 && SELECTOR_START.test(args[1]) ? args.pop() : undefined;
    return page.seek(args.join(" "), { container });
  },
  text: async ({ page }, args) => {
    const maxChars = /^\d+$/.test(args.at(-1) ?? "") ? Number(args.pop()) : 8000;
    if (args[0] === "all") return (await page.text({ maxChars, all: true })) || "(no text)";
    const selector = args.join(" ").trim();
    if (!selector) return (await page.text({ maxChars })) || "(no text)";
    try {
      return (await page.text({ maxChars, selector })) || "(no text)";
    } catch (error) {
      if (!/^Could not find /.test(error.message)) throw error;
      return `(${selector} matched nothing; main text follows)\n${(await page.text({ maxChars: Math.max(maxChars, 3000) })) || "(no text)"}`;
    }
  },
  section: async ({ page }, args) => {
    const maxChars = /^\d+$/.test(args.at(-1) ?? "") && args.length > 1 ? Number(args.pop()) : 4000;
    return page.section(args.join(" "), { maxChars });
  },
  click: async ({ page }, [selector]) => {
    const point = pointOf(selector);
    if (!point) return receiptText(await page.click(selector));
    await page.mouse.click(point.x, point.y, { label: `click ${selector}` });
    return null;
  },
  dblclick: async ({ page }, [selector]) => {
    const point = pointOf(selector);
    if (!point) return receiptText(await page.dblclick(selector));
    await page.mouse.dblclick(point.x, point.y, { label: `double-click ${selector}` });
    return null;
  },
  hover: async ({ page }, [selector]) => {
    const point = pointOf(selector);
    if (point) await page.mouse.move(point.x, point.y, { steps: 3, label: `hover ${selector}` });
    else await page.hover(selector);
    return null;
  },
  fill: ({ page }, [selector, ...value]) => noticing(page, async () => receiptText(await page.fill(selector, value.join(" ")))),
  drag: async ({ page }, [source, target]) => {
    if (!source || !target) throw new Error("Usage: drag <source> <target> (selectors, refs, or x,y points)");
    const from = pointOf(source);
    const to = pointOf(target);
    if (from && to && (await looksDraggable(page, from))) {
      await html5Drag(page, from, to, { steps: 12, draggable: true, labels: { from: `drag from ${source}`, to: `drag to ${target}` } });
      return null;
    }
    if (from && to) {
      await page.mouse.move(from.x, from.y, { label: `drag from ${source}` });
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12, label: `drag to ${target}` });
      await page.mouse.up();
      return null;
    }
    await page.dragAndDrop(source, target);
    return null;
  },
  type: ({ page }, text) =>
    noticing(page, async () => {
      await page.keyboard.type(text.join(" "));
      return null;
    }),
  insert: ({ page }, text) =>
    noticing(page, async () => {
      await page.keyboard.insertText(text.join(" "));
      return null;
    }),
  press: ({ page }, args) => noticing(page, async () => receiptText(args.length > 1 ? await page.press(args[0], args[1]) : await page.press(args[0]))),
  select: async ({ page }, [selector, ...values]) => (await page.selectOption(selector, values.length > 1 ? values : values[0])).join(", "),
  check: async ({ page }, [selector]) => receiptText(await page.check(selector)),
  uncheck: async ({ page }, [selector]) => receiptText(await page.uncheck(selector)),
  upload: async ({ page }, [selector, ...files]) => {
    await page.setInputFiles(selector, files);
    return null;
  },
  scroll: async ({ page }, args) => {
    const numbers = args.filter((arg) => /^-?\d+$/.test(arg));
    const selector = args.filter((arg) => !/^-?\d+$/.test(arg)).join(" ").trim() || undefined;
    const position = await page.scroll(number(numbers[0], 600), { deltaX: number(numbers[1], 0), selector });
    const end = position.scrollY + position.view >= position.height - 2 ? " (end)" : position.scrollY === 0 ? " (top)" : "";
    return `${position.scroller} y=${position.scrollY}/${Math.max(0, position.height - position.view)}${end}`;
  },
  wait: async ({ page }, [target, ...rest]) => {
    if (!target) throw new Error("Usage: wait <selector|ms|url:part|gone:selector> [timeout ms], or wait download [timeout ms]");
    const forget = rest.includes("forget");
    const timeout = rest.find((arg) => /^\d+$/.test(arg));
    const options = { timeout: number(timeout, 15_000) };
    if (target === "download") {
      const file = await page.waitForDownload({ timeout: number(timeout, 60_000), forget });
      return `download complete: ${file.path} (${file.bytes ?? "?"} bytes)`;
    }
    if (/^\d+$/.test(target)) await page.waitForTimeout(Number(target));
    else if (target.startsWith("url:")) await page.waitForURL(target.slice(4), options);
    else if (target.startsWith("gone:")) await page.waitForSelector(target.slice(5), { ...options, state: "hidden" });
    else await page.waitForSelector(target, options);
    return null;
  },
  back: async ({ page }) => page.goBack(),
  forward: async ({ page }) => page.goForward(),
  reload: async ({ page }) => {
    await page.reload();
    return null;
  },
  eval: async ({ page }, code) => {
    const frame = /^@\d+(\.\d+)*$/.test(code[0] ?? "") && code.length > 1 ? code.shift() : undefined;
    const value = await page.evaluate(code.join(" "), undefined, { frame });
    if (value === undefined) return "undefined";
    if (value === "") return '""';
    return typeof value === "string" ? value : JSON.stringify(value);
  },
  shot: ({ page }, args) =>
    page.screenshot({ fullPage: args.includes("full"), path: args.find((arg) => arg.includes("/")) }),
  front: async ({ page }) => {
    await page.bringToFront();
    return null;
  },
  accept: async ({ page }, text) => ((await page.acceptDialog(text.length ? text.join(" ") : undefined)) === "armed" ? null : "accepted"),
  dismiss: async ({ page }) => ((await page.dismissDialog()) === "armed" ? null : "dismissed"),
  url: ({ page }) => page.url(),
  title: ({ page }) => page.title(),
  info: async ({ page }) => JSON.stringify(await page.info()),
  close: async ({ task }, args) => {
    const force = args.includes("force");
    const label = args.find((arg) => arg !== "force") ?? task.current;
    const page = task.page(label);
    if (page.openedBy === "user" && !force) {
      await task.release(label);
      return `released ${label}; it is the user's tab, so it stays open ("close ${label} force" closes it)`;
    }
    await page.close();
    return `closed ${label}`;
  },
  open: async ({ task }, [url]) => {
    const page = await task.newPage({ url });
    return `${page.label} | ${await page.title()} | ${await page.url()}`;
  },
  use: async ({ task }, [label]) => {
    await task.use(label);
    return null;
  },
  pages: async ({ task }) => (await task.tabs()).filter((tab) => tab.label).map(tabLine).join("\n"),
  tabs: async ({ task }) => (await task.tabs()).map(tabLine).join("\n"),
  adopt: async ({ task }, [tabId]) => {
    const target = tabId ? Number(tabId) : await task.userTab();
    const page = await task.adopt(target);
    return `${page.label} | ${await page.title()} | ${await page.url()}`;
  },
  finish: async ({ task }, keep) => {
    const result = await task.finish({ keep });
    const shown = result.onScreen.length ? ` (${result.onScreen.join(",")} left open: the user is looking at it)` : "";
    return `closed ${result.closed.join(",") || "-"} kept ${result.kept.join(",") || "-"} released ${result.released.join(",") || "-"}${shown}`;
  },
};

const ALIASES = { snapshot: "snap", go: "goto", screenshot: "shot", evaluate: "eval", key: "press" };

const TASK_COMMANDS = new Set(["open", "use", "pages", "tabs", "adopt", "finish", "close"]);

const REPEATABLE = new Set(["hover", "fill", "select", "check", "uncheck"]);

const ONCE = new Set(["back", "forward", "reload", "accept", "dismiss", "eval"]);

const RECOVERABLE = /Detached while handling command|Debugger is not attached|Session with given id not found|Cannot find context with specified id/i;

const inputSent = (page) => page.mouse.sent + page.keyboard.sent;

export function retryDecision(name, error, inputChanged) {
  if (!RECOVERABLE.test(error.message)) return "throw";
  if (ONCE.has(name) && /Detached while handling command/i.test(error.message)) return "stop";
  if (inputChanged && !REPEATABLE.has(name)) return "stop";
  return "retry";
}

export const COMMAND_NAMES = Object.keys(COMMANDS);

const DEFAULT_STEP_LIMIT = 45_000;

export function stepLimit(name, args, base = Number(process.env.CLAUDE4ARC_TIMEOUT) || DEFAULT_STEP_LIMIT) {
  if (name !== "wait") return base;
  const timeout = Number(args.slice(1).find((arg) => /^\d+$/.test(arg)) ?? (args[0] === "download" ? 60_000 : 15_000));
  const own = /^\d+$/.test(args[0] ?? "") ? Number(args[0]) : timeout;
  return Math.max(base, own + 5_000);
}

const TIMED_OUT = Symbol("timed out");

async function runStep(handler, context, rest, name, rawName) {
  const limit = stepLimit(name, rest);
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, limit, TIMED_OUT);
  });
  try {
    const result = await Promise.race([handler(context, rest), expired]);
    if (result !== TIMED_OUT) return result;
  } finally {
    clearTimeout(timer);
  }
  const page = context.page;
  const where = page ? `page ${page.label} stopped responding (its scripts may be busy or frozen)` : "the browser did not answer";
  throw new Error(`${rawName} gave up after ${Math.round(limit / 1000)}s: ${where}. Try "reload", or allow more time with --timeout <ms>.`);
}

export function splitChain(args) {
  const steps = [[]];
  for (const arg of args) {
    if (arg === "--") steps.push([]);
    else steps.at(-1).push(arg);
  }
  return steps.filter((step) => step.length);
}

export async function runCommands(bridge, target, args) {
  const snapAfter = args.at(-1) === "-s";
  const steps = splitChain(snapAfter ? args.slice(0, -1) : args);
  const [idText, labelText] = target.split(":");
  const task = await Task.resume(bridge, Number(idText));
  if (labelText) await task.use(labelText);
  return executeSteps(task, steps, snapAfter);
}

async function executeSteps(task, steps, snapAfter) {
  try {
    return await runSteps(task, steps, snapAfter);
  } catch (error) {
    if (snapAfter && !task.finished) {
      const page = task.page();
      const snapshot = await page.settle().then(() => page.snapshot()).catch(() => null);
      if (snapshot) error.message += `\nPage now:\n${snapshot}`;
    }
    throw error;
  } finally {
    await task.flush();
  }
}

async function runSteps(task, steps, snapAfter) {
  const output = [];
  let finished = false;
  for (const [rawName, ...rest] of steps) {
    const name = ALIASES[rawName] ?? rawName;
    const handler = COMMANDS[name];
    if (!handler) throw new Error(`Unknown command "${rawName}". Commands: ${COMMAND_NAMES.join(", ")}`);
    const context = { task, page: TASK_COMMANDS.has(name) ? null : task.page() };
    let result;
    const before = context.page ? inputSent(context.page) : 0;
    try {
      result = await runStep(handler, context, rest, name, rawName);
    } catch (error) {
      if (!context.page) throw error;
      const decision = retryDecision(name, error, inputSent(context.page) !== before);
      if (decision === "throw") throw error;
      context.page._resetScopes();
      if (decision === "stop") {
        throw new Error(`${rawName} was interrupted because the page navigated or reloaded (${error.message}). It was not repeated because it may already have taken effect; check the page before running it again.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      result = await runStep(handler, context, rest, name, rawName);
    }
    if (result !== null && result !== undefined && result !== "") output.push(String(result));
    if (name === "finish") finished = true;
    else if (context.page) await context.page._enforceBlocklist();
  }
  if (!finished) output.push(...(await task._settleDialogs()));
  if (snapAfter && !finished) {
    const page = task.page();
    await page.settle();
    output.push(await page.snapshot({ diff: true }));
  }
  return output.length ? output.join("\n") : "ok";
}

function splitHead(args) {
  const snapAfter = args.at(-1) === "-s";
  const rest = snapAfter ? args.slice(0, -1) : args;
  const split = rest.indexOf("--");
  return {
    snapAfter,
    head: split >= 0 ? rest.slice(0, split) : rest,
    chain: split >= 0 ? splitChain(rest.slice(split + 1)) : [],
  };
}

async function startTask(task, chain, snapAfter, snapNow) {
  const page = task.page();
  const lines = [`task ${task.spaceId} ${page.label} | ${await page.title()} | ${await page.url()}`];
  if (chain.length) {
    if (snapAfter) await page.snapshot().catch(() => {});
    lines.push(await executeSteps(task, chain, snapAfter));
  } else if (snapAfter && snapNow) {
    lines.push(await page.snapshot());
  }
  return lines.join("\n");
}

export async function createTask(bridge, args) {
  const { snapAfter, head, chain } = splitHead(args);
  const [url, ...nameParts] = head;
  const name = nameParts.join(" ") || (url ? url.replace(/^https?:\/\//, "").split("/")[0] : "task");
  const task = await Task.create(bridge, name, { url });
  return startTask(task, chain, snapAfter, Boolean(url));
}

export async function adoptTask(bridge, args) {
  const { snapAfter, head, chain } = splitHead(args);
  const [tabId] = head;
  if (tabId !== undefined && !/^\d+$/.test(tabId)) throw new Error(`Usage: claude4arc adopt [tabId] [-- <cmd> ...]. "${tabId}" is not a tab id; run \`claude4arc tabs\` to list them.`);
  const task = await Task.create(bridge, "adopt", { page: false });
  const target = tabId ? Number(tabId) : await task.userTab();
  if (!target) throw new Error("No tab is on screen to adopt. Pass a tab id from `claude4arc tabs`.");
  await task.adopt(target);
  return startTask(task, chain, snapAfter, true);
}

export function shellWords(line) {
  const words = [];
  let index = 0;
  const escapes = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
  while (index < line.length) {
    while (/\s/.test(line[index] ?? "")) index++;
    if (index >= line.length) break;
    let word = "";
    while (index < line.length && !/\s/.test(line[index])) {
      const char = line[index];
      if (char === "$" && line[index + 1] === "'") {
        index += 2;
        while (index < line.length && line[index] !== "'") {
          if (line[index] === "\\") {
            word += escapes[line[index + 1]] ?? `\\${line[index + 1]}`;
            index += 2;
          } else word += line[index++];
        }
        index++;
      } else if (char === "'") {
        const end = line.indexOf("'", index + 1);
        if (end < 0) throw new Error(`Unclosed ' in: ${line}`);
        word += line.slice(index + 1, end);
        index = end + 1;
      } else if (char === '"') {
        index++;
        while (index < line.length && line[index] !== '"') {
          if (line[index] === "\\" && /["\\$`]/.test(line[index + 1] ?? "")) {
            word += line[index + 1];
            index += 2;
          } else word += line[index++];
        }
        if (index >= line.length) throw new Error(`Unclosed " in: ${line}`);
        index++;
      } else if (char === "\\") {
        word += line[index + 1] ?? "";
        index += 2;
      } else {
        word += char;
        index++;
      }
    }
    words.push(word);
  }
  return words;
}

const LABEL = /^([A-Za-z][\w.-]{0,15}):\s+(.*)$/;

export function batchLabel(line, number) {
  return line.match(LABEL)?.[1] ?? String(number + 1);
}

export function parseBatchLine(line) {
  const labelled = line.match(LABEL);
  const args = shellWords(labelled ? labelled[2] : line);
  const snapAfter = args.at(-1) === "-s";
  return { steps: splitChain(snapAfter ? args.slice(0, -1) : args), snapAfter };
}

export async function runBatch(bridge, script, { taskId, keep = false, tabPerLine = false, write }) {
  const lines = script.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) throw new Error("No batch lines given. Pipe one command chain per line on stdin.");
  const task = taskId ? await Task.resume(bridge, Number(taskId)) : await Task.create(bridge, "batch", { url: "about:blank" });
  write(`task ${task.spaceId}`);
  let failures = 0;
  for (const [number, line] of lines.entries()) {
    const label = batchLabel(line, number);
    const start = Date.now();
    let body;
    let ok = true;
    let page = "";
    try {
      const { steps, snapAfter } = parseBatchLine(line);
      if (tabPerLine && (number > 0 || !task.current)) await task.newPage();
      if (tabPerLine) page = ` ${task.current}`;
      body = await executeSteps(task, steps, snapAfter);
    } catch (error) {
      ok = false;
      failures++;
      body = `Error: ${error.message}`;
    }
    const end = Date.now();
    write(`== ${label} ${ok ? "ok" : "FAILED"} ${start}-${end} (${end - start} ms)${page}\n${body}`);
  }
  if (!keep && !task.finished) write(`== finish\n${await executeSteps(task, [["finish"]], false)}`);
  return failures;
}
