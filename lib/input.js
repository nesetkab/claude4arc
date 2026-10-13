import { describeKey, parseChord, modifierMask, macCommand, shiftedText, keyEvents, typingSteps } from "./keys.js";
import { ROOT_INPUT } from "./frames.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sleep, pbcopy } from "./util.js";

const PASTEBOARD = `ObjC.import("AppKit");
function run(argv) {
  const board = $.NSPasteboard.generalPasteboard;
  if (argv[0] === "save") {
    const items = board.pasteboardItems;
    const saved = [];
    for (let i = 0; i < items.count; i++) {
      const item = items.objectAtIndex(i);
      const entry = {};
      for (let j = 0; j < item.types.count; j++) {
        const type = item.types.objectAtIndex(j);
        const data = item.dataForType(type);
        if (!data.isNil()) entry[type.js] = data.base64EncodedStringWithOptions(0).js;
      }
      saved.push(entry);
    }
    return JSON.stringify(saved);
  }
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const saved = JSON.parse($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding).js);
  board.clearContents;
  const items = saved.map((entry) => {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of Object.entries(entry)) item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(data, 0), type);
    return item;
  });
  if (items.length && !board.writeObjects($(items))) throw new Error("could not restore the clipboard");
}`;

function pasteboard(mode, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile("osascript", ["-l", "JavaScript", "-e", PASTEBOARD, mode], { encoding: "utf8", maxBuffer: 1024 ** 3 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    child.stdin.end(input);
  });
}

function watchPaste(key) {
  let doc = document;
  let element = doc.activeElement;
  for (;;) {
    if (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    else if (element?.contentDocument?.activeElement) {
      doc = element.contentDocument;
      element = doc.activeElement;
    } else break;
  }
  if (!element || element.tagName === "IFRAME" || element.tagName === "FRAME") return false;
  const mark = () => (element.isContentEditable ? element.innerHTML : typeof element.value === "string" ? element.value : null);
  const state = { before: mark(), mark, events: [], inputs: 0 };
  const listeners = {
    paste: (event) => {
      state.events.push(event);
      if (!event.clipboardData?.getData("text/plain")) state.empty = true;
    },
    beforeinput: (event) => state.events.push(event),
    input: () => state.inputs++,
  };
  for (const [type, listener] of Object.entries(listeners)) doc.addEventListener(type, listener, true);
  state.stop = () => {
    for (const [type, listener] of Object.entries(listeners)) doc.removeEventListener(type, listener, true);
  };
  Object.defineProperty(window, key, { value: state, configurable: true });
  return true;
}

function pasteOutcome(key) {
  const state = window[key];
  delete window[key];
  if (!state) return "unknown";
  state.stop();
  if (state.empty) return "dropped";
  if (state.inputs || state.events.some((event) => event.defaultPrevented) || state.mark() !== state.before) return "inserted";
  return "dropped";
}

export class Mouse {
  #page;
  #pressed = new Set();
  #input = ROOT_INPUT;

  constructor(page) {
    this.#page = page;
    this.x = null;
    this.y = null;
    this.sent = 0;
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
    this.sent++;
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
    const buttons = this.#buttons();
    const button = this.#pressed.size ? [...this.#pressed][0] : "none";
    const moves = [];
    for (let step = 1; step <= steps; step++) {
      const nextX = startX + ((x - startX) * step) / steps;
      const nextY = startY + ((y - startY) * step) / steps;
      moves.push({ type: "mouseMoved", x: nextX - input.x, y: nextY - input.y, buttons, button });
    }
    this.sent++;
    if (moves.length === 1) await this.#dispatch({ type: "mouseMoved", x, y, buttons, button });
    else await this.#page._dispatchBatch("Input.dispatchMouseEvent", moves, { sessionId: input.sessionId });
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

  async click(x, y, { button = "left", clickCount = 1, delay = 0, modifiers = [], label, input = ROOT_INPUT } = {}) {
    if (!delay && !this.#pressed.size) {
      await this.#ensurePosition();
      this.#input = input;
      const mask = modifierMask(modifiers);
      const bit = button === "right" ? 2 : button === "middle" ? 4 : 1;
      const local = { x: x - input.x, y: y - input.y };
      const events = [{ type: "mouseMoved", ...local, buttons: 0, button: "none", modifiers: mask }];
      for (let count = 1; count <= clickCount; count++) {
        events.push({ type: "mousePressed", ...local, button, buttons: bit, clickCount: count, modifiers: mask });
        events.push({ type: "mouseReleased", ...local, button, buttons: 0, clickCount: count, modifiers: mask });
      }
      this.sent++;
      await this.#page._dispatchBatch("Input.dispatchMouseEvent", events, { sessionId: input.sessionId });
      this.x = x;
      this.y = y;
      if (label !== false) this.#page._showCursor(x, y, label);
      return;
    }
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

export class Keyboard {
  #page;
  #modifiers = new Set();

  constructor(page) {
    this.#page = page;
    this.sent = 0;
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
    const shifted = sendText && mask & 8 ? shiftedText(description.text) : description.text;
    this.sent++;
    await this.#page.cdp("Input.dispatchKeyEvent", {
      type: sendText ? "keyDown" : "rawKeyDown",
      modifiers: mask,
      key: shifted === description.text ? description.key : shifted,
      code: description.code,
      windowsVirtualKeyCode: description.keyCode,
      nativeVirtualKeyCode: description.keyCode,
      text: sendText ? shifted : undefined,
      unmodifiedText: sendText ? shifted : undefined,
      commands,
    });
  }

  async up(key) {
    const description = describeKey(key);
    if (["Shift", "Control", "Alt", "Meta"].includes(key)) this.#modifiers.delete(key);
    this.sent++;
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
    describeKey(key);
    const command = macCommand(modifiers, key);
    await this.#page._focusForKeys();
    const held = [];
    try {
      for (const modifier of modifiers) {
        held.push(modifier);
        await this.#down(modifier);
      }
      await this.#down(key, { commands: command ? [command] : undefined });
      if (delay) await sleep(delay);
      await this.up(key);
    } finally {
      for (const modifier of held.reverse()) await this.up(modifier).catch(() => {});
    }
  }

  async #send(step) {
    if (step.text !== undefined) return this.insertText(step.text);
    this.sent++;
    await this.#page._dispatchBatch("Input.dispatchKeyEvent", step.events);
  }

  async type(text, { delay = 0 } = {}) {
    await this.#page._focusForKeys();
    if (!delay) {
      for (const step of typingSteps(text)) await this.#send(step);
      return;
    }
    for (const char of text) {
      const events = keyEvents(char);
      await this.#send(events ? { events } : { text: char });
      await sleep(delay);
    }
  }

  async insertText(text) {
    this.sent++;
    await this.#page.cdp("Input.insertText", { text });
  }

  async paste(content) {
    const text = typeof content === "string" ? content : content.text;
    if (process.platform !== "darwin") {
      await this.insertText(text);
      return;
    }
    let saved;
    try {
      saved = await pasteboard("save");
    } catch {
      await this.insertText(text);
      return;
    }
    try {
      await pbcopy(text);
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await this.#pasteOnce();
        if (outcome === "inserted") return;
        if (outcome === "unknown") {
          await sleep(150);
          return;
        }
      }
      await this.insertText(text);
    } finally {
      await pasteboard("restore", saved);
    }
  }

  async #pasteOnce() {
    const key = `__arcPaste_${randomUUID().replaceAll("-", "")}`;
    const watching = await this.#page.evaluate(watchPaste, key).catch(() => false);
    await this.press("Meta+v");
    if (!watching) return "unknown";
    return this.#page.evaluate(pasteOutcome, key).catch(() => "unknown");
  }
}
