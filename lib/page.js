import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { LIBRARY_KEY, LIBRARY_PRELUDE } from "./inpage.js";
import { EDITOR_PRELUDE } from "./editors.js";
import { html5Drag } from "./dnd.js";
import { describeKey, parseChord, modifierMask, macCommand } from "./keys.js";
import { STATE_DIR } from "./paths.js";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT =
  /Execution context was destroyed|Cannot find default execution context|Inspected target navigated|Cannot find context with specified id|No frame with given id|Target closed|Debugger is not attached/i;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function poll(check, { timeout, interval = 50, message }) {
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

function fatal(error) {
  error.fatal = true;
  return error;
}

function agentShim(version) {
  if (window.__arcShim?.version === version) return;
  const state = { log: [], policy: null };
  const opens = [];
  const shim = { version, dialogs: state, opens };
  Object.defineProperty(window, "__arcShim", { value: shim, configurable: true, writable: true });
  const current = () => window.__arcShim === shim;
  const answer = (type, message, fallback) => {
    const policy = state.policy;
    state.policy = null;
    const accepted = type === "alert" ? true : Boolean(policy?.accept);
    state.log.push({ type, message: String(message ?? ""), accepted });
    if (type === "confirm") return accepted;
    if (type === "prompt") return accepted ? String(policy.text ?? fallback ?? "") : null;
  };
  window.alert = function alert(message) {
    answer("alert", message);
  };
  window.confirm = function confirm(message) {
    return answer("confirm", message);
  };
  window.prompt = function prompt(message, fallback) {
    return answer("prompt", message, fallback);
  };
  const absolute = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  };
  const namedFrameExists = (name) => {
    const selector = `iframe[name="${CSS.escape(name)}"], frame[name="${CSS.escape(name)}"]`;
    if (document.querySelector(selector)) return true;
    try {
      if (window.top.document.querySelector(selector)) return true;
    } catch {}
    let view = window;
    try {
      while (view) {
        if (view.name === name) return true;
        if (view === view.parent) break;
        view = view.parent;
      }
    } catch {}
    return false;
  };
  const opensWindow = (target) => {
    const name = String(target || "");
    const lower = name.toLowerCase();
    if (!name || lower === "_self" || lower === "_parent" || lower === "_top") return false;
    if (lower === "_blank") return true;
    return !namedFrameExists(name);
  };
  const nativeOpen = window.open;
  window.open = function open(url, target) {
    if (!current() || (target && !opensWindow(target))) return nativeOpen.apply(window, arguments);
    const entry = { kind: "window.open", url: url ? absolute(url) : "about:blank" };
    opens.push(entry);
    const setUrl = (value) => {
      entry.url = absolute(value);
    };
    const place = { assign: setUrl, replace: setUrl, reload() {} };
    Object.defineProperty(place, "href", { get: () => entry.url, set: setUrl });
    const stub = { closed: false, opener: window, focus() {}, blur() {}, postMessage() {}, close() { stub.closed = true; } };
    Object.defineProperty(stub, "location", { get: () => place, set: setUrl });
    return stub;
  };
  const retarget = (form, submitter) => {
    if (!current()) return;
    const target = submitter?.getAttribute?.("formtarget") || form.getAttribute("target");
    if (!opensWindow(target)) return;
    const url = new URL(absolute(form.getAttribute("action") || location.href));
    if ((form.method || "get").toLowerCase() === "get") url.search = new URLSearchParams(new FormData(form, submitter ?? null)).toString();
    opens.push({ kind: "form", url: url.href, method: (form.method || "get").toLowerCase() });
    form.setAttribute("target", "_top");
    if (submitter?.hasAttribute?.("formtarget")) submitter.setAttribute("formtarget", "_top");
  };
  addEventListener("submit", (event) => retarget(event.target, event.submitter), true);
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function submit() {
    retarget(this);
    return nativeSubmit.call(this);
  };
  addEventListener("click", (event) => {
    if (!current() || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.composedPath().find((node) => node instanceof Element && node.matches("a[href], area[href]"));
    if (!anchor || anchor.hasAttribute("download") || !opensWindow(anchor.getAttribute("target"))) return;
    if (!anchor.href || anchor.href.startsWith("javascript:")) return;
    event.preventDefault();
    opens.push({ kind: "link", url: anchor.href });
  });
}

const SHIM_SOURCE = agentShim.toString();

export const AGENT_SHIM = `(${SHIM_SOURCE})(${JSON.stringify(createHash("sha1").update(SHIM_SOURCE).digest("hex").slice(0, 10))});`;

const ROOT_INPUT = { sessionId: null, x: 0, y: 0 };

const ROOT_CONTEXT = { sessionId: null, contextId: null, input: ROOT_INPUT, offset: { x: 0, y: 0 }, prefix: "", depth: 0 };

const scopeOf = (context) => ({ sessionId: context.sessionId, contextId: context.contextId });

const CLOSED_AWARE = new Set(["snapshot", "find", "resolve", "count", "seekProbe"]);

function registerClosedRoot(key) {
  let view = window;
  while (view) {
    try {
      view[key]?.registerClosedRoot(this);
    } catch {}
    let parent = view.parent === view ? null : view.parent;
    try {
      void parent?.[key];
    } catch {
      parent = null;
    }
    view = parent;
  }
  return true;
}

const REGISTER_CLOSED_ROOT = registerClosedRoot.toString();

function splitFrameSelector(selector) {
  const text = String(selector).trim();
  const match = text.match(/^@(\d+(?:\.\d+)*)(?:\s*>>\s*(?!nth=)([\s\S]+))?$/);
  if (!match) return { path: [], local: text };
  const parts = match[1].split(".").map(Number);
  if (match[2] !== undefined) return { path: parts, local: match[2].trim() };
  return { path: parts.slice(0, -1), local: `@${parts.at(-1)}` };
}

const pathOf = (context) => context.prefix.split(".").filter(Boolean).map(Number);

const prefixRefs = (text, prefix) => (prefix ? text.replace(/@(\d+)/g, `@${prefix}$1`) : text);

export function normalizeUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^localhost(:\d+)?(\/|$)/.test(url) || /^\d+\.\d+\.\d+\.\d+/.test(url)) return `http://${url}`;
  return `https://${url}`;
}

function urlMatches(url, matcher) {
  if (matcher instanceof RegExp) return matcher.test(url);
  if (typeof matcher === "function") return Boolean(matcher(url));
  if (matcher.includes("*")) {
    const pattern = matcher.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${pattern}$`).test(url);
  }
  return url === matcher || url.includes(matcher);
}

class Mouse {
  #page;
  #pressed = new Set();
  #input = ROOT_INPUT;

  constructor(page) {
    this.#page = page;
    this.x = null;
    this.y = null;
  }

  #buttons() {
    let mask = 0;
    if (this.#pressed.has("left")) mask |= 1;
    if (this.#pressed.has("right")) mask |= 2;
    if (this.#pressed.has("middle")) mask |= 4;
    return mask;
  }

  async #ensurePosition() {
    if (this.x !== null) return;
    const size = await this.#page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    this.x = Math.round(size.width / 2);
    this.y = Math.round(size.height / 2);
  }

  #dispatch(params) {
    const input = this.#input;
    return this.#page.cdp(
      "Input.dispatchMouseEvent",
      { ...params, x: params.x - input.x, y: params.y - input.y },
      { sessionId: input.sessionId },
    );
  }

  async move(x, y, { steps = 1, label, input = ROOT_INPUT } = {}) {
    await this.#ensurePosition();
    this.#input = input;
    const startX = this.x;
    const startY = this.y;
    for (let step = 1; step <= steps; step++) {
      const nextX = startX + ((x - startX) * step) / steps;
      const nextY = startY + ((y - startY) * step) / steps;
      await this.#dispatch({
        type: "mouseMoved",
        x: nextX,
        y: nextY,
        buttons: this.#buttons(),
        button: this.#pressed.size ? [...this.#pressed][0] : "none",
      });
    }
    this.x = x;
    this.y = y;
    if (label !== false) await this.#page._showCursor(x, y, label);
  }

  async down({ button = "left", clickCount = 1, modifiers = [] } = {}) {
    await this.#ensurePosition();
    this.#pressed.add(button);
    await this.#dispatch({
      type: "mousePressed",
      x: this.x,
      y: this.y,
      button,
      buttons: this.#buttons(),
      clickCount,
      modifiers: modifierMask(modifiers),
    });
  }

  async up({ button = "left", clickCount = 1, modifiers = [] } = {}) {
    await this.#ensurePosition();
    this.#pressed.delete(button);
    await this.#dispatch({
      type: "mouseReleased",
      x: this.x,
      y: this.y,
      button,
      buttons: this.#buttons(),
      clickCount,
      modifiers: modifierMask(modifiers),
    });
  }

  async click(x, y, { button = "left", clickCount = 1, delay = 0, modifiers = [], label, input } = {}) {
    await this.move(x, y, { label, input });
    for (let count = 1; count <= clickCount; count++) {
      await this.down({ button, clickCount: count, modifiers });
      if (delay) await sleep(delay);
      await this.up({ button, clickCount: count, modifiers });
    }
  }

  async dblclick(x, y, options = {}) {
    await this.click(x, y, { ...options, clickCount: 2 });
  }

  async wheel(deltaX, deltaY, { label } = {}) {
    await this.#ensurePosition();
    if (label) await this.#page._showCursor(this.x, this.y, label);
    await this.#dispatch({
      type: "mouseWheel",
      x: this.x,
      y: this.y,
      deltaX,
      deltaY,
    });
    await this.#page._frame();
  }
}

class Keyboard {
  #page;
  #modifiers = new Set();

  constructor(page) {
    this.#page = page;
  }

  #mask() {
    return modifierMask([...this.#modifiers]);
  }

  async down(key, options) {
    await this.#page._focusForKeys();
    await this.#down(key, options);
  }

  async #down(key, { commands } = {}) {
    const description = describeKey(key);
    if (["Shift", "Control", "Alt", "Meta"].includes(key)) this.#modifiers.add(key);
    const mask = this.#mask();
    const sendText = description.text && !(mask & (1 | 2 | 4));
    await this.#page.cdp("Input.dispatchKeyEvent", {
      type: sendText ? "keyDown" : "rawKeyDown",
      modifiers: mask,
      key: description.key,
      code: description.code,
      windowsVirtualKeyCode: description.keyCode,
      nativeVirtualKeyCode: description.keyCode,
      text: sendText ? description.text : undefined,
      unmodifiedText: sendText ? description.text : undefined,
      commands,
    });
  }

  async up(key) {
    const description = describeKey(key);
    if (["Shift", "Control", "Alt", "Meta"].includes(key)) this.#modifiers.delete(key);
    await this.#page.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: this.#mask(),
      key: description.key,
      code: description.code,
      windowsVirtualKeyCode: description.keyCode,
      nativeVirtualKeyCode: description.keyCode,
    });
  }

  async press(chord, { delay = 0 } = {}) {
    const { modifiers, key } = parseChord(chord);
    const command = macCommand(modifiers, key);
    await this.#page._focusForKeys();
    for (const modifier of modifiers) await this.#down(modifier);
    await this.#down(key, { commands: command ? [command] : undefined });
    if (delay) await sleep(delay);
    await this.up(key);
    for (const modifier of [...modifiers].reverse()) await this.up(modifier);
  }

  async type(text, { delay = 0 } = {}) {
    await this.#page._focusForKeys();
    for (const char of text) {
      if (char === "\n") await this.press("Enter");
      else if (char === "\t") await this.press("Tab");
      else {
        const description = describeKey(char);
        const params = {
          key: description.key,
          code: description.code,
          windowsVirtualKeyCode: description.keyCode,
          nativeVirtualKeyCode: description.keyCode,
          modifiers: description.shift ? 8 : 0,
        };
        await this.#page.cdp("Input.dispatchKeyEvent", { type: "keyDown", text: char, unmodifiedText: char, ...params });
        await this.#page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
      }
      if (delay) await sleep(delay);
    }
  }

  async insertText(text) {
    await this.#page.cdp("Input.insertText", { text });
  }

  async paste(content) {
    const text = typeof content === "string" ? content : content.text;
    if (process.platform !== "darwin") {
      await this.insertText(text);
      return;
    }
    let saved = null;
    try {
      saved = (await run("pbpaste", [], { encoding: "utf8" })).stdout;
    } catch {}
    await pbcopy(text);
    try {
      await this.press("Meta+v");
      await sleep(150);
    } finally {
      if (saved !== null) await pbcopy(saved);
    }
  }
}

function pbcopy(text) {
  return new Promise((resolve, reject) => {
    const child = execFile("pbcopy", (error) => (error ? reject(error) : resolve()));
    child.stdin.end(text);
  });
}

export class Page {
  #task;
  #attached = false;
  #stoppedByUser = false;
  #dialog = null;
  #dialogWaiters = new Set();
  #eventWaiters = new Set();

  constructor(task, label, tabId, openedBy) {
    this.#task = task;
    this.label = label;
    this.tabId = tabId;
    this.openedBy = openedBy;
    this.mouse = new Mouse(this);
    this.keyboard = new Keyboard(this);
  }

  get spaceId() {
    return this.#task.spaceId;
  }

  get #bridge() {
    return this.#task.bridge;
  }

  get attached() {
    return this.#attached;
  }

  get dialog() {
    return this.#dialog;
  }

  _onEvent(message) {
    if (message.type === "detached") {
      this.#attached = false;
      if (message.reason === "canceled_by_user") this.#stoppedByUser = true;
      return;
    }
    if (message.type !== "event" || message.sessionId) return;
    if (message.method === "Page.javascriptDialogOpening") {
      this.#dialog = {
        type: message.params.type,
        message: message.params.message,
        defaultPrompt: message.params.defaultPrompt,
        url: message.params.url,
      };
      for (const waiter of this.#dialogWaiters) waiter(this.#dialog);
    }
    if (message.method === "Page.javascriptDialogClosed") this.#dialog = null;
    for (const waiter of this.#eventWaiters) waiter(message);
  }

  _waitForCdpEvent(method, options) {
    return this.#waitForCdpEvent(method, options);
  }

  #waitForCdpEvent(method, { timeout, filter = () => true }) {
    let listener;
    const promise = new Promise((resolve) => {
      listener = (message) => {
        if (message.method === method && filter(message.params)) resolve(message.params);
      };
      this.#eventWaiters.add(listener);
    });
    return withTimeout(promise, timeout, `Timed out after ${timeout}ms waiting for ${method}`).finally(() =>
      this.#eventWaiters.delete(listener),
    );
  }

  async #attach() {
    if (this.#stoppedByUser) {
      throw fatal(new Error(`The user stopped Claude's control of page ${this.label}. Ask the user before continuing.`));
    }
    if (this.#attached) return;
    let result;
    try {
      result = await this.#bridge.call("debugger.attach", this.tabId).catch(async (error) => {
        if (!/chrome-extension:\/\/ URL of different extension/i.test(error.message) || this.openedBy === "user") throw error;
        await this.#bridge.call("guard.sweep", this.tabId).catch(() => {});
        await sleep(50);
        return this.#bridge.call("debugger.attach", this.tabId);
      });
    } catch (error) {
      if (/No tab with id/i.test(error.message)) {
        throw fatal(new Error(`Page ${this.label} (tab ${this.tabId}) is closed.`));
      } else {
        const tab = await this.#bridge.call("tabs.get", this.tabId).catch(() => null);
        throw fatal(
          new Error(
            `Cannot control page ${this.label} at ${tab?.url ?? "unknown url"}: ${error.message}. Arc blocks extensions on internal pages such as arc://, chrome://, and the Chrome Web Store.`,
          ),
        );
      }
    }
    this.#attached = true;
    const managed = this.openedBy !== "user";
    if (!result?.already) await this.#bridge.call("debugger.send", this.tabId, "Page.enable", {});
    if (managed) await this.#bridge.call("host.autoDialogs", this.tabId, true, AGENT_SHIM).catch(() => {});
    const dialog = await this.#bridge.call("host.dialog", this.tabId).catch(() => null);
    if (dialog) this.#dialog = { type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt, url: dialog.url };
  }

  async _detach() {
    if (!this.#attached) return;
    this.#attached = false;
    await this.#bridge.call("debugger.detach", this.tabId).catch(() => {});
  }

  _frame() {
    return this.#bridge
      .call("debugger.send", this.tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 1,
        clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
        optimizeForSpeed: true,
      })
      .catch(() => {});
  }

  async #pumped(send, timeout, method) {
    let done = false;
    const pending = send().finally(() => {
      done = true;
    });
    pending.catch(() => {});
    await Promise.race([pending.catch(() => {}), sleep(20)]);
    const deadline = Date.now() + timeout;
    while (!done && !this.#dialog && Date.now() < deadline) await this._frame();
    return withTimeout(pending, Math.max(0, deadline - Date.now()) + 50, `CDP ${method} timed out after ${timeout}ms`);
  }

  async cdp(method, params = {}, { timeout = 30_000, sessionId = null } = {}) {
    await this.#attach();
    const target = sessionId ? { tabId: this.tabId, sessionId } : this.tabId;
    const send = () => this.#bridge.call("debugger.send", target, method, params);
    try {
      if (method.startsWith("Input.")) return await this.#pumped(send, timeout, method);
      return await withTimeout(send(), timeout, `CDP ${method} timed out after ${timeout}ms`);
    } catch (error) {
      const detached = /not attached|Detached while handling command/i.test(error.message);
      if (detached && !method.startsWith("Input.") && !sessionId) {
        this.#attached = false;
        await this.#attach();
        return await withTimeout(send(), timeout, `CDP ${method} timed out after ${timeout}ms`);
      }
      throw error;
    }
  }

  #dialogError() {
    const dialog = this.#dialog;
    return fatal(
      new Error(
        `A JavaScript ${dialog.type} dialog is open ("${dialog.message}"). Call page.acceptDialog() or page.dismissDialog() first.`,
      ),
    );
  }

  #raceDialog(promise) {
    if (this.#dialog) {
      promise.catch(() => {});
      return Promise.reject(this.#dialogError());
    }
    let waiter;
    const dialogPromise = new Promise((_, reject) => {
      waiter = () => reject(this.#dialogError());
      this.#dialogWaiters.add(waiter);
    });
    promise.catch(() => {});
    return Promise.race([promise, dialogPromise]).finally(() => this.#dialogWaiters.delete(waiter));
  }

  async #evaluateExpression(expression, { timeout = 60_000, sessionId = null, contextId = null } = {}) {
    const response = await this.#raceDialog(
      this.cdp(
        "Runtime.evaluate",
        { expression, contextId: contextId ?? undefined, awaitPromise: true, returnByValue: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true },
        { timeout, sessionId },
      ),
    );
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      const description = details.exception?.description ?? details.exception?.value ?? details.text;
      const error = new Error(String(description).replace(/^Error: /, "").split("\n    at ")[0]);
      error.pageError = true;
      throw error;
    }
    return response.result.value;
  }

  async evaluate(fn, argument, { frame } = {}) {
    const expression =
      typeof fn === "function"
        ? `(${fn.toString()})(${argument === undefined ? "" : JSON.stringify(argument)})`
        : String(fn);
    const context = frame ? await this.#frameOf(frame) : ROOT_CONTEXT;
    return this.#evaluateExpression(expression, scopeOf(context));
  }

  async _lib(method, ...args) {
    return this.#libAt(ROOT_CONTEXT, method, ...args);
  }

  async #libAt(context, method, ...args) {
    if (CLOSED_AWARE.has(method)) return this.#libGuarded(context, method, args);
    const call = `${LIBRARY_PRELUDE}.${method}(${args.map((arg) => JSON.stringify(arg ?? null)).join(", ")})`;
    return this.#evaluateExpression(call, scopeOf(context));
  }

  async #withElement(context, ref, body) {
    const call = `((element, lib, editors) => (${body}))(${LIBRARY_PRELUDE}.element(${ref}), ${LIBRARY_PRELUDE}, ${EDITOR_PRELUDE})`;
    return this.#evaluateExpression(call, scopeOf(context));
  }

  async #libGuarded(context, method, args) {
    const list = args.map((arg) => JSON.stringify(arg ?? null)).join(", ");
    for (let round = 0; ; round++) {
      const call = `${LIBRARY_PRELUDE}.guarded(${JSON.stringify(method)}, [${list}], ${round < 4})`;
      const value = await this.#evaluateExpression(call, scopeOf(context));
      if (!value?.__arcClosedHosts) return value;
      await this.#exposeClosedRoots(context);
    }
  }

  async #exposeClosedRoots(context) {
    const options = { sessionId: context.sessionId };
    const objectGroup = "arc-closed-roots";
    try {
      const { result } = await this.cdp(
        "Runtime.evaluate",
        { expression: `${LIBRARY_PRELUDE}.takeClosedHostCandidates()`, objectGroup, returnByValue: false, contextId: context.contextId ?? undefined },
        options,
      );
      if (!result?.objectId) return;
      const { result: properties } = await this.cdp("Runtime.getProperties", { objectId: result.objectId, ownProperties: true }, options);
      const hosts = properties.filter((property) => /^\d+$/.test(property.name) && property.value?.objectId);
      await Promise.all(
        hosts.map(async ({ value }) => {
          const { node } = await this.cdp("DOM.describeNode", { objectId: value.objectId, depth: 0, pierce: true }, options);
          for (const root of node.shadowRoots ?? []) {
            if (root.shadowRootType !== "closed") continue;
            const { object } = await this.cdp("DOM.resolveNode", { backendNodeId: root.backendNodeId, objectGroup }, options);
            await this.cdp(
              "Runtime.callFunctionOn",
              { objectId: object.objectId, functionDeclaration: REGISTER_CLOSED_ROOT, arguments: [{ value: LIBRARY_KEY }], returnByValue: true },
              options,
            );
          }
        }).map((work) => work.catch(() => {})),
      );
    } finally {
      await this.cdp("Runtime.releaseObjectGroup", { objectGroup }, options).catch(() => {});
    }
  }

  async #objectIdAt(context, ref) {
    const response = await this.cdp(
      "Runtime.evaluate",
      { expression: `${LIBRARY_PRELUDE}.element(${ref})`, contextId: context.contextId ?? undefined, returnByValue: false },
      { sessionId: context.sessionId },
    );
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? "Cannot resolve element");
    return response.result.objectId;
  }

  async #childContext(context, ref) {
    const box = await this.#libAt(context, "frameBox", ref);
    const name = `@${context.prefix}${ref}`;
    if (!box.cross) throw fatal(new Error(`${name} is a same-origin frame; its elements already have plain refs in the snapshot.`));
    const objectId = await this.#objectIdAt(context, ref);
    const { node } = await this.cdp("DOM.describeNode", { objectId }, { sessionId: context.sessionId });
    await this.cdp("Runtime.releaseObject", { objectId }, { sessionId: context.sessionId }).catch(() => {});
    const scope = node.contentDocument ? await this.#inProcessScope(context.sessionId, node) : await this.#outOfProcessScope(node);
    if (!scope) throw new Error(`Frame ${name} is still loading or not reachable.`);
    const offset = { x: context.offset.x + box.x, y: context.offset.y + box.y };
    return {
      ...scope,
      input: scope.sessionId === context.sessionId ? context.input : { sessionId: scope.sessionId, ...offset },
      offset,
      prefix: `${context.prefix}${ref}.`,
      depth: context.depth + 1,
    };
  }

  async #outOfProcessScope(node) {
    const frameId = node.frameId ?? node.contentDocument?.frameId;
    const sessions = await this.#bridge.call("host.sessions", this.tabId);
    const child = sessions.find((session) => session.targetId === frameId);
    return child ? { sessionId: child.sessionId, contextId: null } : null;
  }

  async #inProcessScope(sessionId, node) {
    const { object } = await this.cdp("DOM.resolveNode", { backendNodeId: node.contentDocument.backendNodeId }, { sessionId });
    await this.cdp("Runtime.releaseObject", { objectId: object.objectId }, { sessionId }).catch(() => {});
    const mainWorld = Number(/^-?\d+\.(\d+)\.\d+$/.exec(object.objectId ?? "")?.[1]);
    if (mainWorld) return { sessionId, contextId: mainWorld };
    const { executionContextId } = await this.cdp(
      "Page.createIsolatedWorld",
      { frameId: node.frameId, worldName: "arc-browser", grantUniveralAccess: true },
      { sessionId },
    );
    return { sessionId, contextId: executionContextId };
  }

  async #frameContext(path) {
    let context = ROOT_CONTEXT;
    for (const ref of path) context = await this.#childContext(context, ref);
    return context;
  }

  async #frameOf(frame) {
    const path = String(frame).replace(/^@/, "").split(".").map(Number);
    return this.#frameContext(path);
  }

  #describeIn(context, description) {
    return prefixRefs(description, context.prefix);
  }

  async _focusForKeys() {
    if ((await this.#tab()).active) return;
    const roundTrip = () => this.#evaluateExpression("0", { timeout: 2_000 }).catch(() => {});
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await roundTrip();
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    await roundTrip();
  }

  _showCursor(x, y, label) {
    if (this.#attached) this._lib("showCursor", x, y, label ?? "").catch(() => {});
  }

  async #tab() {
    try {
      return await this.#bridge.call("tabs.get", this.tabId);
    } catch {
      throw fatal(new Error(`Page ${this.label} (tab ${this.tabId}) is closed.`));
    }
  }

  async _waitForTabLoad(timeout = 30_000) {
    await poll(
      async () => {
        const tab = await this.#tab();
        return tab.status === "complete" && tab.url && tab.url !== "about:blank";
      },
      { timeout, message: `Page ${this.label} did not finish loading within ${timeout}ms` },
    ).catch(async (error) => {
      const tab = await this.#tab();
      if (!tab.url || tab.url === "about:blank") throw error;
    });
  }

  async url() {
    return (await this.#tab()).url;
  }

  async title() {
    return (await this.#tab()).title;
  }

  async info() {
    const tab = await this.#tab();
    return {
      label: this.label,
      spaceId: this.spaceId,
      tabId: this.tabId,
      openedBy: this.openedBy,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      loading: tab.status === "loading",
      dialog: this.#dialog,
    };
  }

  #rootFrameId = null;

  async #loadRootFrameId() {
    if (this.#rootFrameId) return;
    const { frameTree } = await this.cdp("Page.getFrameTree").catch(() => ({ frameTree: null }));
    this.#rootFrameId = frameTree?.frame?.id ?? null;
  }

  #navigation(waitUntil, timeout) {
    const wanted = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
    let listener;
    let timer;
    let done = false;
    let committed = false;
    let sawContent = false;
    let loading = false;
    let withinDocument = false;
    const rootFrame = this.#rootFrameId;
    let contentTimer = null;
    const promise = new Promise((resolve, reject) => {
      listener = (message) => {
        if (message.method === "Page.frameStartedLoading" && message.params.frameId === rootFrame) loading = true;
        if (message.method === "Page.frameNavigated" && !message.params.frame?.parentId) committed = true;
        if (message.method === "Page.domContentEventFired") {
          sawContent = true;
          if (waitUntil === "load" && !contentTimer) contentTimer = setTimeout(resolve, 3_000);
        }
        if (message.method === wanted) resolve();
        if (message.method === "Page.navigatedWithinDocument" && message.params.frameId === rootFrame) {
          withinDocument = true;
          if (!loading) {
            setTimeout(() => {
              if (!loading) resolve();
            }, 50);
          }
        }
        if (message.method === "Page.frameStoppedLoading" && message.params.frameId === rootFrame && withinDocument && !committed) resolve();
      };
      this.#eventWaiters.add(listener);
      timer = setTimeout(() => {
        if (sawContent) resolve();
        else reject(new Error(`Navigation did not reach "${waitUntil}" within ${timeout}ms`));
      }, timeout);
      (async () => {
        while (!done) {
          await sleep(250);
          if (done || !committed) continue;
          const state = await this.#evaluateExpression("document.readyState", { timeout: 2_000 }).catch(() => "loading");
          if (state === "complete" || (waitUntil === "domcontentloaded" && state !== "loading")) resolve();
        }
      })();
    });
    const cancel = () => {
      done = true;
      clearTimeout(timer);
      clearTimeout(contentTimer);
      this.#eventWaiters.delete(listener);
    };
    return {
      wait: async () => {
        try {
          await promise;
        } finally {
          cancel();
        }
        if (waitUntil === "networkidle") await this.#waitForNetworkIdle(timeout);
      },
      cancel,
    };
  }

  async #waitForNetworkIdle(timeout) {
    let previous = -1;
    let stableSince = Date.now();
    await poll(
      async () => {
        const count = await this.#evaluateExpression("performance.getEntriesByType('resource').length", { timeout: 5_000 });
        if (count !== previous) {
          previous = count;
          stableSince = Date.now();
          return false;
        }
        return Date.now() - stableSince >= 500;
      },
      { timeout, interval: 100, message: `Network did not become idle within ${timeout}ms` },
    );
  }

  async #navigate(start, { waitUntil, timeout }) {
    await this.#attach();
    await this.#loadRootFrameId();
    const skip = waitUntil === "none" || waitUntil === "commit";
    const navigation = this.#navigation(waitUntil, timeout);
    try {
      const result = await start();
      if (skip || result?.sameDocument) navigation.cancel();
      else await navigation.wait();
    } catch (error) {
      navigation.cancel();
      throw error;
    }
  }

  async goto(url, { waitUntil = "load", timeout = 30_000 } = {}) {
    const target = normalizeUrl(url);
    await this.#navigate(
      async () => {
        const result = await this.cdp("Page.navigate", { url: target }, { timeout });
        if (result.errorText) throw new Error(`Navigation to ${target} failed: ${result.errorText}`);
        return { sameDocument: !result.loaderId };
      },
      { waitUntil, timeout },
    );
    const tab = await this.#tab();
    return { url: tab.url, title: tab.title };
  }

  async reload({ waitUntil = "load", timeout = 30_000 } = {}) {
    await this.#navigate(() => this.cdp("Page.reload", {}), { waitUntil, timeout });
  }

  async goBack({ waitUntil = "load", timeout = 30_000 } = {}) {
    await this.#navigate(() => this.#bridge.call("tabs.goBack", this.tabId), { waitUntil, timeout });
    return this.url();
  }

  async goForward({ waitUntil = "load", timeout = 30_000 } = {}) {
    await this.#navigate(() => this.#bridge.call("tabs.goForward", this.tabId), { waitUntil, timeout });
    return this.url();
  }

  async waitForLoadState(state = "load", { timeout = 30_000 } = {}) {
    await poll(
      async () => {
        const readyState = await this.#evaluateExpression("document.readyState", { timeout: 5_000 });
        return state === "domcontentloaded" ? readyState !== "loading" : readyState === "complete";
      },
      { timeout, message: `Page did not reach "${state}" within ${timeout}ms` },
    );
    if (state === "networkidle") await this.#waitForNetworkIdle(timeout);
  }

  async waitForURL(matcher, { timeout = 30_000, waitUntil = "load" } = {}) {
    const url = await poll(
      async () => {
        const current = await this.url();
        return urlMatches(current, matcher) ? current : false;
      },
      { timeout, message: `URL did not match ${matcher} within ${timeout}ms` },
    );
    if (waitUntil !== "none" && waitUntil !== "commit") await this.waitForLoadState(waitUntil, { timeout });
    return url;
  }

  async waitForSelector(selector, { state = "visible", timeout = 30_000 } = {}) {
    const { path, local } = splitFrameSelector(selector);
    return poll(
      async () => {
        const context = await this.#frameContext(path);
        const count = (visibleOnly) => this.#libAt(context, "count", local, { visibleOnly });
        if (state === "visible") return (await count(true)) > 0;
        if (state === "attached") return (await count(false)) > 0;
        if (state === "hidden") return (await count(true)) === 0;
        if (state === "detached") return (await count(false)) === 0;
        throw fatal(new Error(`Unknown state: ${state}`));
      },
      { timeout, message: `Selector ${selector} did not become ${state} within ${timeout}ms` },
    );
  }

  async waitForFunction(fn, argument, { timeout = 30_000, polling = 100 } = {}) {
    return poll(() => this.evaluate(fn, argument), {
      timeout,
      interval: polling,
      message: `Function did not return a truthy value within ${timeout}ms`,
    });
  }

  async waitForTimeout(ms) {
    await sleep(ms);
  }

  async waitForEvent(name, { timeout = 30_000 } = {}) {
    if (name === "popup") return this.#task._waitForPopup(this, timeout);
    if (name === "dialog") {
      if (this.#dialog) return this.#dialog;
      let waiter;
      return withTimeout(
        new Promise((resolve) => {
          waiter = resolve;
          this.#dialogWaiters.add(waiter);
        }),
        timeout,
        `No dialog within ${timeout}ms`,
      ).finally(() => this.#dialogWaiters.delete(waiter));
    }
    if (name === "load") return this.#waitForCdpEvent("Page.loadEventFired", { timeout });
    if (name === "filechooser") return this.waitForFileChooser({ timeout });
    if (name === "download") {
      throw new Error("Download events are not available through the Arc extension bridge. Use page.fetch(url, { saveAs }) instead.");
    }
    throw new Error(`Unknown event: ${name}`);
  }

  async #snapshotIn(context, options) {
    let text;
    try {
      text = await this.#libAt(context, "snapshot", options);
    } catch (error) {
      if (!TRANSIENT.test(error.message) || context.depth) throw error;
      await this.waitForLoadState("domcontentloaded", { timeout: 5_000 });
      text = await this.#libAt(context, "snapshot", options);
    }
    const lines = text.split("\n");
    const output = [prefixRefs(lines[0], context.prefix)];
    const frameLine = /^(\s*)(?:[+-] )?@(\d+) iframe .*\(cross-origin\)$/;
    const expanded = new Set();
    for (const line of lines.slice(1)) {
      output.push(prefixRefs(line, context.prefix));
      const match = line.match(frameLine);
      if (!match || line.startsWith("- ") || context.depth >= 3) continue;
      expanded.add(Number(match[2]));
      output.push(...(await this.#frameSnapshotLines(context, Number(match[2]), options, match[1] + " ")));
    }
    if (options.diff && context.depth < 3) {
      const frames = await this.#libAt(context, "crossFrames", { visibleOnly: true }).catch(() => []);
      for (const frame of frames) {
        if (expanded.has(frame.ref)) continue;
        const inner = await this.#frameSnapshotLines(context, frame.ref, options, "");
        if (inner.length) output.push(`frame @${context.prefix}${frame.ref} "${frame.name}":`, ...inner);
      }
    }
    return output.join("\n");
  }

  async #frameSnapshotLines(context, ref, options, indent) {
    try {
      const child = await this.#childContext(context, ref);
      const inner = await this.#snapshotIn(child, { ...options, root: undefined, scope: "viewport" });
      const body = inner.split("\n").slice(1).filter((line) => !/^\((no change|nothing visible)/.test(line));
      return body.map((line) => indent + line);
    } catch (error) {
      return [`${indent}(frame not readable: ${error.message})`];
    }
  }

  async snapshot(options = {}) {
    if (!options.root) return this.#snapshotIn(ROOT_CONTEXT, options);
    const { path, local } = splitFrameSelector(options.root);
    let context = await this.#frameContext(path);
    const refMatch = local.match(/^(?:@|ref=)(\d+)$/);
    if (refMatch && (await this.#libAt(context, "refIsCrossFrame", Number(refMatch[1])))) {
      context = await this.#childContext(context, Number(refMatch[1]));
      return this.#snapshotIn(context, { ...options, root: undefined, scope: "viewport" });
    }
    return this.#snapshotIn(context, { ...options, root: local });
  }

  async #findIn(context, query, options) {
    const results = [];
    const own = await this.#libAt(context, "find", query, { limit: options.limit ?? 15 });
    if (!own.startsWith("no match")) results.push(...own.split("\n").map((line) => prefixRefs(line, context.prefix)));
    if (context.depth >= 3) return results;
    const frames = await this.#libAt(context, "crossFrames").catch(() => []);
    for (const frame of frames) {
      try {
        const child = await this.#childContext(context, frame.ref);
        results.push(...(await this.#findIn(child, query, options)));
      } catch {}
    }
    return results;
  }

  async settle({ quiet = 120, max = 1_000 } = {}) {
    const deadline = Date.now() + max;
    let last = await this._lib("mutationCount").catch(() => null);
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(40);
      const count = await this._lib("mutationCount").catch(() => null);
      if (count !== last) {
        last = count;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quiet) {
        return true;
      }
    }
    return false;
  }

  async find(query, options = {}) {
    const results = await this.#findIn(ROOT_CONTEXT, query, options);
    return results.length ? results.join("\n") : `no match for "${query}"`;
  }

  async text(options = {}) {
    const { frame, ...rest } = options;
    const context = frame ? await this.#frameOf(frame) : ROOT_CONTEXT;
    const expression = `(() => {
      const body = ${LIBRARY_PRELUDE}.text(${JSON.stringify(rest)});
      try {
        return { body, editors: ${EDITOR_PRELUDE}.codeEditors() };
      } catch {
        return { body, editors: [] };
      }
    })()`;
    const { body, editors } = await this.#evaluateExpression(expression, { sessionId: context.sessionId });
    if (!editors.length) return body;
    const maxChars = rest.maxChars ?? 8_000;
    const sections = editors.map(({ kind, value }, index) => {
      const lines = value.split("\n").length;
      const shown = value.length > maxChars ? `${value.slice(0, maxChars)}\n… truncated (${value.length} chars total)` : value;
      return `--- ${kind} editor ${index + 1}/${editors.length}, ${lines} lines ---\n${shown}`;
    });
    return [body, ...sections].join("\n\n");
  }

  async #target(selector, { timeout, visibleOnly = true }) {
    const { path, local } = splitFrameSelector(selector);
    return poll(
      async () => {
        const context = await this.#frameContext(path);
        try {
          const { ref, description } = await this.#libAt(context, "resolve", local, { visibleOnly });
          return { context, ref, description: this.#describeIn(context, description) };
        } catch (error) {
          if (/matches \d+ elements|stale or unknown|Cannot parse/.test(error.message)) throw fatal(new Error(this.#describeIn(context, error.message)));
          throw error;
        }
      },
      { timeout, message: `Could not find ${selector} within ${timeout}ms` },
    );
  }

  async #pointOf(target, { force = false, timeout = 5_000 } = {}) {
    const deadline = Date.now() + Math.min(timeout, 2_000);
    const { context, ref } = target;
    let point;
    while (true) {
      point = await this.#libAt(context, "actionPoint", ref);
      if (!point.covered || force) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.#describeIn(context, point.description)} is covered by ${this.#describeIn(context, point.covered)}. Close the overlay first, or pass { force: true }.`,
        );
      }
      await sleep(150);
    }
    const fresh = context.depth ? await this.#frameContext(pathOf(context)) : context;
    return {
      ...point,
      x: point.x + fresh.offset.x,
      y: point.y + fresh.offset.y,
      description: this.#describeIn(context, point.description),
      ref,
      context,
      input: fresh.input,
    };
  }

  async #actionPoint(selector, options = {}) {
    const target = await this.#target(selector, { timeout: options.timeout ?? 5_000 });
    return this.#pointOf(target, options);
  }

  async #receipt(action, description, work) {
    const popups = [];
    const stopWatching = this.#task._watchPopups(this, (page) => popups.push({ label: page.label, tabId: page.tabId }));
    let dialog = null;
    let waiter;
    const dialogOpened = new Promise((resolve) => {
      waiter = resolve;
      this.#dialogWaiters.add(waiter);
    });
    try {
      const outcome = work();
      outcome.catch(() => {});
      const first = await Promise.race([outcome.then(() => "done"), dialogOpened.then(() => "dialog")]);
      if (first === "dialog") dialog = this.#dialog;
      else {
        await outcome;
        await sleep(30);
      }
      if (!dialog && this.#dialog) dialog = this.#dialog;
    } finally {
      this.#dialogWaiters.delete(waiter);
      stopWatching();
    }
    const { dialogs, opens } = await this._takeShim();
    let navigated = null;
    for (const open of opens) {
      if (open.kind === "form") {
        navigated = open.url;
        continue;
      }
      if (!open.url || open.url === "about:blank") continue;
      const page = await this.#task.newPage({ url: open.url });
      popups.push({ label: page.label, tabId: page.tabId, via: open.kind });
    }
    if (navigated) await this.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    return { action, target: description, popups, dialog, dialogs, navigated };
  }

  async #clickTarget(target, { button = "left", clickCount = 1, delay = 0, force = false, modifiers = [], timeout = 5_000, label } = {}) {
    const point = await this.#pointOf(target, { force, timeout });
    return this.#receipt("click", point.description, () =>
      this.mouse.click(point.x, point.y, { button, clickCount, delay, modifiers, label: label ?? `click ${point.description}`, input: point.input }),
    );
  }

  async click(selector, options = {}) {
    const target = await this.#target(selector, { timeout: options.timeout ?? 5_000 });
    return this.#clickTarget(target, options);
  }

  async dblclick(selector, options = {}) {
    return this.click(selector, { ...options, clickCount: 2 });
  }

  async hover(selector, { force = false, timeout = 5_000, label } = {}) {
    const point = await this.#actionPoint(selector, { force, timeout });
    await this.mouse.move(point.x, point.y, { steps: 3, label: label ?? `hover ${point.description}`, input: point.input });
    return { action: "hover", target: point.description };
  }

  async #focusTarget(target) {
    if (target.context.depth) {
      const point = await this.#pointOf(target, { force: true });
      await this.mouse.click(point.x, point.y, { label: false, input: point.input });
    }
    return this.#describeIn(target.context, await this.#libAt(target.context, "focus", target.ref));
  }

  async focus(selector, { timeout = 5_000 } = {}) {
    return this.#focusTarget(await this.#target(selector, { timeout }));
  }

  async fill(selector, value, { timeout = 5_000 } = {}) {
    const text = String(value);
    const target = await this.#target(selector, { timeout });
    const { context } = target;
    const valueInput = await this.#withElement(
      context,
      target.ref,
      '(element.tagName === "INPUT" && ["range", "color", "date", "time", "month", "week", "datetime-local"].includes(element.type))',
    );
    if (context.depth && !valueInput) await this.#focusTarget(target);
    const editor = await this.#withElement(
      context,
      target.ref,
      "(() => { const found = editors.prepare(element); return found && { kind: found.kind, api: found.api, x: found.x, y: found.y, description: lib.describe(found.root) }; })()",
    );
    if (editor) return this.#fillEditor(context, editor, text);
    const { kind, ref, x, y } = await this.#libAt(context, "prepareFill", target.ref);
    this._showCursor(x + context.offset.x, y + context.offset.y, `fill ${target.description}`);
    if (kind === "value") return this.#receipt("fill", target.description, () => this.#libAt(context, "fillValue", ref, text));
    return this.#receipt("fill", target.description, async () => {
      if (text === "") {
        await this.keyboard.press("Backspace");
      } else {
        await this.cdp("Input.insertText", { text });
      }
      const actual = await this.#libAt(context, "valueOf", ref);
      if (kind === "input" && actual !== text) await this.#libAt(context, "forceValue", ref, text);
    });
  }

  async #fillEditor(context, editor, text) {
    const ref = Number(/^@(\d+)/.exec(editor.description)[1]);
    const description = this.#describeIn(context, editor.description);
    const label = `${editor.kind} editor ${description}`;
    this._showCursor(editor.x + context.offset.x, editor.y + context.offset.y, `fill ${label}`);
    const receipt = await this.#receipt("fill", label, async () => {
      if (editor.api) {
        const result = await this.#withElement(context, ref, `editors.setValue(element, ${JSON.stringify(text)})`);
        if (result.ok) return;
      }
      await this.keyboard.press("Meta+a");
      if (text === "") await this.keyboard.press("Backspace");
      else await this.cdp("Input.insertText", { text });
    });
    const actual = await this.#withElement(context, ref, "editors.getValue(element)");
    const expected = text.replace(/\r\n?/g, "\n").replace(/ /g, " ");
    if (actual !== expected) {
      const shown = actual === null ? "nothing readable" : JSON.stringify(actual.length > 120 ? `${actual.slice(0, 119)}…` : actual);
      receipt.warning = `${label} holds ${shown} after fill`;
    }
    return { ...receipt, editor: editor.kind };
  }

  async press(selector, key, options = {}) {
    if (key === undefined) {
      await this.keyboard.press(selector, options);
      return { action: "press", target: null };
    }
    const target = await this.#target(selector, { timeout: options.timeout ?? 5_000 });
    const description = await this.#focusTarget(target);
    return this.#receipt("press", description, () => this.keyboard.press(key, options));
  }

  async check(selector, checked = true, options = {}) {
    const target = await this.#target(selector, { timeout: options.timeout ?? 5_000 });
    const state = () => this.#libAt(target.context, "checkedState", target.ref);
    const before = await state();
    if (before.checked === checked) return { action: "check", target: this.#describeIn(target.context, before.control), changed: false };
    const receipt = await this.#clickTarget(target, options);
    const after = await state();
    const control = this.#describeIn(target.context, after.control);
    if (after.checked !== checked) throw new Error(`${control} did not become ${checked ? "checked" : "unchecked"} after clicking ${target.description}.`);
    return { ...receipt, action: "check", target: control, changed: true };
  }

  async uncheck(selector, options = {}) {
    return this.check(selector, false, options);
  }

  async selectOption(selector, values, { timeout = 5_000 } = {}) {
    const target = await this.#target(selector, { timeout });
    return this.#libAt(target.context, "selectOption", target.ref, values);
  }

  async setInputFiles(selector, files, { timeout = 5_000 } = {}) {
    const list = (Array.isArray(files) ? files : [files]).map((file) => path.resolve(file));
    for (const file of list) await fs.access(file);
    const target = await this.#target(selector, { timeout, visibleOnly: false });
    const inputRef = await this.#libAt(target.context, "fileInput", target.ref);
    const objectId = await this.#objectIdAt(target.context, inputRef);
    await this.cdp("DOM.setFileInputFiles", { files: list, objectId }, { sessionId: target.context.sessionId });
    return { action: "setInputFiles", target: target.description, files: list };
  }

  async waitForFileChooser({ timeout = 30_000 } = {}) {
    await this.cdp("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const event = await this.#waitForCdpEvent("Page.fileChooserOpened", { timeout });
      return {
        mode: event.mode,
        setFiles: async (files) => {
          const list = (Array.isArray(files) ? files : [files]).map((file) => path.resolve(file));
          for (const file of list) await fs.access(file);
          await this.cdp("DOM.setFileInputFiles", { files: list, backendNodeId: event.backendNodeId });
          await this.cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
          return { files: list, dialog: this.#dialog };
        },
      };
    } catch (error) {
      await this.cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      throw error;
    }
  }

  async dragAndDrop(source, target, { steps = 12, force = false, timeout = 5_000 } = {}) {
    const sourceTarget = await this.#target(source, { timeout });
    await this.#pointOf(sourceTarget, { force, timeout });
    const to = await this.#actionPoint(target, { force: true, timeout });
    const from = await this.#pointOf(sourceTarget, { force: true, timeout });
    if (from.input !== ROOT_INPUT || to.input !== ROOT_INPUT) {
      await this.mouse.move(from.x, from.y, { label: `drag ${from.description}`, input: from.input });
      await this.mouse.down();
      await this.mouse.move(to.x, to.y, { steps, label: `drop on ${to.description}`, input: to.input });
      await this.mouse.up();
      return { action: "dragAndDrop", source: from.description, target: to.description, mode: "pointer" };
    }
    const draggable = await this.#withElement(
      sourceTarget.context,
      sourceTarget.ref,
      "Boolean(element.closest(\"[draggable=true]\") || (element.closest(\"a[href], img\") && !element.closest(\"[draggable=false]\")))",
    );
    const drag = await html5Drag(this, from, to, {
      steps,
      draggable,
      labels: { from: `drag ${from.description}`, to: `drop on ${to.description}` },
    });
    return { action: "dragAndDrop", source: from.description, target: to.description, mode: drag.intercepted ? "html5" : "pointer" };
  }

  async scroll(deltaY, { deltaX = 0, x, y, label } = {}) {
    if (x !== undefined && y !== undefined) await this.mouse.move(x, y, { label: false });
    await this.mouse.wheel(deltaX, deltaY, { label: label ?? "scroll" });
    return this.evaluate(() => ({ scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) }));
  }

  async seek(target, { container, max = 150, timeout = 20_000, idle = 2_000, direction = "down" } = {}) {
    const sign = direction === "up" ? -1 : 1;
    const deadline = Date.now() + timeout;
    const probe = (scroller = null, advance = 0) => this._lib("seekProbe", target, { container, scroller, advance });
    const atEdge = (state) => (sign > 0 ? state.top >= state.max - 2 : state.top <= 1);
    let state = await probe();
    let wheelMisses = 0;
    let steps = 0;
    while (!state.found) {
      if (atEdge(state)) {
        state = await this.#seekMore(state, probe, Math.min(idle, deadline - Date.now()));
        if (state.found) break;
        if (state.more) continue;
        throw new Error(`No match for ${target} in ${state.name} after ${steps} scroll steps: reached the ${sign > 0 ? "end" : "top"}.`);
      }
      if (steps >= max || Date.now() >= deadline) {
        throw new Error(`No match for ${target} in ${state.name} after ${steps} scroll steps (at y=${state.top}/${state.max}).`);
      }
      steps++;
      if (wheelMisses < 2) {
        if (this.mouse.x !== state.x || this.mouse.y !== state.y) {
          await this.mouse.move(state.x, state.y, { label: steps === 1 ? `seek ${target}` : false });
        }
        await this.mouse.wheel(0, sign * state.step);
        const next = await probe(state.scroller);
        if (next.found || next.top !== state.top) {
          state = next;
          continue;
        }
        wheelMisses++;
      }
      const next = await probe(state.scroller, sign);
      if (next.found) {
        state = next;
        break;
      }
      if (next.after === next.top) throw new Error(`Cannot scroll ${state.name} (stuck at y=${next.top}/${next.max}). Pass a container selector.`);
      await this._frame();
      state = { ...next, top: next.after };
    }
    return state.found;
  }

  async #seekMore(state, probe, wait) {
    const until = Date.now() + Math.max(0, wait);
    do {
      await this._frame();
      const next = await probe(state.scroller);
      if (next.found || next.height > state.height + 2 || next.max > state.max + 2) return { ...next, more: true };
      await sleep(80);
    } while (Date.now() < until);
    return state;
  }

  async screenshot({ path: filePath, fullPage = false, selector, scale = "css", timeout = 15_000 } = {}) {
    await this._lib("hideCursor").catch(() => {});
    const metrics = await this.cdp("Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport;
    const ratio = await this.evaluate("devicePixelRatio");
    let clip;
    if (selector) {
      const target = await this.#target(selector, { timeout: 5_000 });
      const rect = await this.#libAt(target.context, "rectOf", target.ref);
      const fresh = target.context.depth ? await this.#frameContext(pathOf(target.context)) : target.context;
      const { cssVisualViewport: current } = await this.cdp("Page.getLayoutMetrics");
      clip = { x: current.pageX + rect.x + fresh.offset.x, y: current.pageY + rect.y + fresh.offset.y, width: rect.width, height: rect.height };
    } else if (fullPage) {
      clip = { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height };
    } else {
      clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight };
    }
    clip = {
      x: Math.floor(clip.x),
      y: Math.floor(clip.y),
      width: Math.max(1, Math.floor(clip.width)),
      height: Math.max(1, Math.floor(clip.height)),
      scale: 1,
    };
    let data;
    try {
      ({ data } = await this.cdp(
        "Page.captureScreenshot",
        { format: "png", clip, captureBeyondViewport: Boolean(fullPage || selector) },
        { timeout },
      ));
    } catch (error) {
      if (/timed out/.test(error.message)) {
        throw new Error(
          `Screenshot of page ${this.label} timed out. Call await page.bringToFront() and retry.`,
        );
      }
      throw error;
    }
    const target =
      filePath ??
      path.join(STATE_DIR, "screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}-${this.label}.png`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!data) throw new Error(`Screenshot of page ${this.label} came back empty.`);
    await fs.writeFile(target, Buffer.from(data, "base64"));
    if (scale === "css" && ratio !== 1) {
      await run("sips", ["--resampleWidth", String(clip.width), target], { encoding: "utf8" }).catch(() => {});
    }
    return target;
  }

  async bringToFront() {
    await this.#bridge.call("tabs.update", this.tabId, { active: true });
    await sleep(200);
  }

  async #frameSessions() {
    const sessions = await this.#bridge.call("host.sessions", this.tabId).catch(() => []);
    return sessions.filter((session) => session.type === "iframe").map((session) => session.sessionId);
  }

  async #inProcessFrames(sessionId) {
    const { frameTree } = await this.cdp("Page.getFrameTree", {}, { sessionId, timeout: 2_000 });
    const frameIds = [];
    const visit = (tree) => {
      for (const child of tree.childFrames ?? []) {
        frameIds.push(child.frame.id);
        visit(child);
      }
    };
    visit(frameTree);
    const scopes = await Promise.all(
      frameIds.map(async (frameId) => {
        const { backendNodeId } = await this.cdp("DOM.getFrameOwner", { frameId }, { sessionId, timeout: 2_000 });
        const { node } = await this.cdp("DOM.describeNode", { backendNodeId }, { sessionId, timeout: 2_000 });
        return node.contentDocument ? this.#inProcessScope(sessionId, node) : null;
      }).map((scope) => scope.catch(() => null)),
    );
    return scopes.filter(Boolean);
  }

  async #shimScopes() {
    const sessions = [null, ...(await this.#frameSessions())];
    const nested = await Promise.all(sessions.map((sessionId) => this.#inProcessFrames(sessionId).catch(() => [])));
    return [...sessions.map((sessionId) => ({ sessionId, contextId: null })), ...nested.flat()];
  }

  async _takeShim() {
    if (this.openedBy === "user" || !this.#attached) return { dialogs: [], opens: [] };
    const expression =
      "(() => { const s = globalThis.__arcShim; if (!s) return { dialogs: [], opens: [] }; s.dialogs.policy = null; return { dialogs: s.dialogs.log.splice(0), opens: s.opens.splice(0) }; })()";
    const scopes = await this.#shimScopes();
    const results = await Promise.all(
      scopes.map((scope) => this.#evaluateExpression(expression, { timeout: 2_000, ...scope }).catch(() => ({ dialogs: [], opens: [] }))),
    );
    const native = await this.#bridge.call("host.handledDialogs", this.tabId).catch(() => []);
    return { dialogs: [...results.flatMap((result) => result.dialogs), ...native], opens: results.flatMap((result) => result.opens) };
  }

  async #handleDialog(params) {
    await this.#attach();
    if (this.#dialog) {
      await this.#bridge.call("debugger.send", this.tabId, "Page.handleJavaScriptDialog", params);
      this.#dialog = null;
      return "answered";
    }
    if (this.openedBy === "user") throw new Error(`No dialog is open on page ${this.label}.`);
    const policy = JSON.stringify({ accept: params.accept, text: params.promptText });
    const expression = `(() => { if (!globalThis.__arcShim) return false; globalThis.__arcShim.dialogs.policy = ${policy}; return true; })()`;
    const scopes = await this.#shimScopes();
    await Promise.all(scopes.map((scope) => this.#evaluateExpression(expression, { timeout: 2_000, ...scope }).catch(() => false)));
    return "armed";
  }

  async acceptDialog(promptText) {
    return this.#handleDialog({ accept: true, promptText });
  }

  async dismissDialog() {
    return this.#handleDialog({ accept: false });
  }

  async fetch(url, { method = "GET", headers, body, timeout = 30_000, saveAs } = {}) {
    const response = await this.evaluate(
      async ({ url, init, binary, timeout }) => {
        const result = await fetch(url, { ...init, credentials: "include", signal: AbortSignal.timeout(timeout) });
        let payload;
        if (binary) {
          const bytes = new Uint8Array(await result.arrayBuffer());
          let text = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          payload = btoa(text);
        } else {
          payload = await result.text();
        }
        return {
          ok: result.ok,
          status: result.status,
          statusText: result.statusText,
          url: result.url,
          headers: Object.fromEntries(result.headers),
          body: payload,
        };
      },
      { url, init: { method, headers, body }, binary: Boolean(saveAs), timeout },
    );
    if (saveAs) {
      const target = path.resolve(saveAs);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(response.body, "base64"));
      return { ...response, body: undefined, savedTo: target };
    }
    return response;
  }

  async close() {
    await this._detach();
    await this.#bridge.call("tabs.remove", this.tabId).catch(() => {});
    this.#task._forget(this.label);
  }
}
