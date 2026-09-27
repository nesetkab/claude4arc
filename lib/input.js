import { describeKey, parseChord, modifierMask, macCommand } from "./keys.js";
import { ROOT_INPUT } from "./frames.js";
import { run, sleep, pbcopy } from "./util.js";

export class Mouse {
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
    const buttons = this.#buttons();
    const button = this.#pressed.size ? [...this.#pressed][0] : "none";
    const moves = [];
    for (let step = 1; step <= steps; step++) {
      const nextX = startX + ((x - startX) * step) / steps;
      const nextY = startY + ((y - startY) * step) / steps;
      moves.push({ type: "mouseMoved", x: nextX - input.x, y: nextY - input.y, buttons, button });
    }
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

  #keyEvents(char) {
    const named = char === "\n" ? "Enter" : char === "\t" ? "Tab" : null;
    const description = describeKey(named ?? char);
    const text = named === "Enter" ? "\r" : named === "Tab" ? undefined : char;
    const params = {
      key: description.key,
      code: description.code,
      windowsVirtualKeyCode: description.keyCode,
      nativeVirtualKeyCode: description.keyCode,
      modifiers: description.shift ? 8 : 0,
    };
    return [
      { type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}), ...params },
      { type: "keyUp", ...params },
    ];
  }

  async type(text, { delay = 0 } = {}) {
    await this.#page._focusForKeys();
    if (!delay) {
      await this.#page._dispatchBatch("Input.dispatchKeyEvent", [...text].flatMap((char) => this.#keyEvents(char)));
      return;
    }
    for (const char of text) {
      await this.#page._dispatchBatch("Input.dispatchKeyEvent", this.#keyEvents(char));
      await sleep(delay);
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
