import { Task } from "./task.js";

const SELECTOR_START = /^(?:@|ref=|text=|role=|css=|xpath=|loc=|#|\.|\[)/;

const number = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

function receiptText(receipt) {
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
  if (receipt.warning) parts.push(receipt.warning);
  return parts.length ? parts.join("\n") : null;
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
  snap: ({ page }, [mode, root]) => {
    if (mode === "full") return page.snapshot({ scope: "full_page", root });
    if (mode === "diff") return page.snapshot({ diff: true });
    if (mode?.startsWith("@")) return page.snapshot({ root: mode });
    return page.snapshot(root ? { root } : {});
  },
  diff: ({ page }) => page.snapshot({ diff: true }),
  find: ({ page }, words) => page.find(words.join(" ")),
  seek: ({ page }, args) => {
    const container = args.length === 2 && SELECTOR_START.test(args[1]) ? args.pop() : undefined;
    return page.seek(args.join(" "), { container });
  },
  text: async ({ page }, args) => {
    const maxChars = /^\d+$/.test(args.at(-1) ?? "") ? Number(args.pop()) : 8000;
    if (args[0] === "all") return (await page.text({ maxChars, all: true })) || "(no text)";
    const selector = args.join(" ").trim();
    return (await page.text({ maxChars, selector: selector || undefined })) || "(no text)";
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
  fill: async ({ page }, [selector, ...value]) => receiptText(await page.fill(selector, value.join(" "))),
  drag: async ({ page }, [source, target]) => {
    if (!source || !target) throw new Error("Usage: drag <source> <target> (selectors, refs, or x,y points)");
    const from = pointOf(source);
    const to = pointOf(target);
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
  type: async ({ page }, text) => {
    await page.keyboard.type(text.join(" "));
    return null;
  },
  insert: async ({ page }, text) => {
    await page.keyboard.insertText(text.join(" "));
    return null;
  },
  press: async ({ page }, args) => receiptText(args.length > 1 ? await page.press(args[0], args[1]) : await page.press(args[0])),
  select: async ({ page }, [selector, ...values]) => (await page.selectOption(selector, values.length > 1 ? values : values[0])).join(", "),
  check: async ({ page }, [selector]) => receiptText(await page.check(selector)),
  uncheck: async ({ page }, [selector]) => receiptText(await page.uncheck(selector)),
  upload: async ({ page }, [selector, ...files]) => {
    await page.setInputFiles(selector, files);
    return null;
  },
  scroll: async ({ page }, [deltaY, deltaX]) => {
    const position = await page.scroll(number(deltaY, 600), { deltaX: number(deltaX, 0) });
    return `y=${position.scrollY}`;
  },
  wait: async ({ page }, [target, ...rest]) => {
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
  info: async ({ page }) => JSON.stringify(await page.info()),
  close: async ({ page }) => {
    await page.close();
    return null;
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
    return `closed ${result.closed.join(",") || "-"} kept ${result.kept.join(",") || "-"} released ${result.released.join(",") || "-"}`;
  },
};

const ALIASES = { snapshot: "snap", go: "goto", screenshot: "shot", evaluate: "eval", key: "press" };

const TASK_COMMANDS = new Set(["open", "use", "pages", "tabs", "adopt", "finish"]);

export const COMMAND_NAMES = Object.keys(COMMANDS);

function splitChain(args) {
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
  const task = await Task.open(bridge, Number(idText));
  if (labelText) await task.use(labelText);
  const output = [];
  let finished = false;
  for (const [rawName, ...rest] of steps) {
    const name = ALIASES[rawName] ?? rawName;
    const handler = COMMANDS[name];
    if (!handler) throw new Error(`Unknown command "${rawName}". Commands: ${COMMAND_NAMES.join(", ")}`);
    const result = await handler({ task, page: TASK_COMMANDS.has(name) ? null : task.page() }, rest);
    if (result !== null && result !== undefined && result !== "") output.push(String(result));
    if (name === "finish") finished = true;
  }
  if (!finished) output.push(...(await task._settleDialogs()));
  if (snapAfter && !finished) {
    const page = task.page();
    await page.settle();
    output.push(await page.snapshot({ diff: true }));
  }
  return output.length ? output.join("\n") : "ok";
}

export async function createTask(bridge, args) {
  const snapAfter = args.at(-1) === "-s";
  const [url, ...nameParts] = snapAfter ? args.slice(0, -1) : args;
  const name = nameParts.join(" ") || (url ? url.replace(/^https?:\/\//, "").split("/")[0] : "task");
  const task = await Task.open(bridge, name, { url });
  const page = task.page();
  const lines = [`task ${task.spaceId} ${page.label} | ${await page.title()} | ${await page.url()}`];
  if (snapAfter && url) lines.push(await page.snapshot());
  return lines.join("\n");
}
