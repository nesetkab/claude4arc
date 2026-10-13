import test from "node:test";
import assert from "node:assert/strict";
import { Keyboard } from "../../lib/input.js";
import { Page } from "../../lib/page.js";
import { sleep } from "../../lib/util.js";

function fakePage({ failOn } = {}) {
  const sent = [];
  return {
    sent,
    async _focusForKeys() {},
    async cdp(method, params) {
      sent.push({ method, ...params });
      if (failOn?.(method, params)) throw new Error("Detached while handling command.");
    },
    async _dispatchBatch(method, list) {
      for (const params of list) sent.push({ method, ...params });
    },
  };
}

const downs = (page) => page.sent.filter((event) => event.type === "keyDown" || event.type === "rawKeyDown");

test("press checks the whole chord before sending anything", async () => {
  const page = fakePage();
  const keyboard = new Keyboard(page);
  await assert.rejects(keyboard.press("Meta+Foo"), /Unknown key: Foo/);
  await assert.rejects(keyboard.press("Hyper+a"), /Unknown modifier/);
  assert.equal(page.sent.length, 0);
});

test("press releases held modifiers when the key fails", async () => {
  const page = fakePage({ failOn: (method, params) => params.key === "a" && params.type !== "keyUp" });
  const keyboard = new Keyboard(page);
  await assert.rejects(keyboard.press("Meta+Shift+a"), /Detached/);
  const ups = page.sent.filter((event) => event.type === "keyUp").map((event) => event.key);
  assert.deepEqual(ups, ["Shift", "Meta"]);
  page.sent.length = 0;
  await keyboard.press("b");
  assert.equal(page.sent[0].modifiers, 0);
});

test("Shift+key sends the shifted character", async () => {
  const page = fakePage();
  const keyboard = new Keyboard(page);
  await keyboard.press("Shift+a");
  await keyboard.press("Shift+1");
  await keyboard.press("Shift+/");
  const typed = downs(page).filter((event) => event.text).map((event) => [event.key, event.text, event.code]);
  assert.deepEqual(typed, [["A", "A", "KeyA"], ["!", "!", "Digit1"], ["?", "?", "Slash"]]);
});

test("Meta+Shift+z still sends no text", async () => {
  const page = fakePage();
  await new Keyboard(page).press("Meta+Shift+z");
  const key = downs(page).find((event) => event.code === "KeyZ");
  assert.equal(key.type, "rawKeyDown");
  assert.equal(key.text, undefined);
});

test("type inserts emoji, CJK, and accented text instead of throwing", async () => {
  for (const delay of [0, 1]) {
    const page = fakePage();
    const keyboard = new Keyboard(page);
    await keyboard.type("Hi 👋 日本 café", { delay });
    const inserted = page.sent.filter((event) => event.method === "Input.insertText").map((event) => event.text).join("");
    const keyed = downs(page).map((event) => event.text).join("");
    assert.equal(inserted, "👋日本é");
    assert.equal(keyed, "Hi   caf");
    assert.ok(keyboard.sent > 0);
  }
});

test("paste inserts the text directly off macOS", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const page = fakePage();
    const keyboard = new Keyboard(page);
    await keyboard.paste("line one\nline two");
    await keyboard.paste({ text: "rich" });
    assert.deepEqual(page.sent, [
      { method: "Input.insertText", text: "line one\nline two" },
      { method: "Input.insertText", text: "rich" },
    ]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

const turn = () => new Promise(setImmediate);

function hiddenTab({ ack, frame }) {
  const frames = [];
  const bridge = {
    async call(api, target, method) {
      if (api === "tabs.get") return { id: 1, active: false };
      if (api !== "debugger.send") return null;
      if (method === "Runtime.evaluate") return { result: { value: [1280, 800] } };
      if (method === "Page.captureScreenshot") {
        frames.push(method);
        return frame();
      }
      if (method.startsWith("Input.")) return ack(frames);
      return {};
    },
  };
  return { page: new Page({ bridge, spaceId: null }, "p1", 1, "agent"), frames };
}

const afterNextFrame = async (frames) => {
  const seen = frames.length;
  while (frames.length === seen) await turn();
};

test("a key press in a hidden tab returns on the ack instead of waiting out the frame", async (t) => {
  const { page } = hiddenTab({ ack: afterNextFrame, frame: () => new Promise(() => {}) });
  await page.cdp("Runtime.evaluate", {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let done = false;
  const typing = (async () => {
    await page.keyboard.press("Shift+a");
    await page.keyboard.type("ab");
    done = true;
  })();
  for (let elapsed = 0; elapsed < 200 && !done; elapsed += 10) {
    t.mock.timers.tick(10);
    for (let i = 0; i < 20; i++) await turn();
  }
  assert.ok(done, "the keys waited on a frame that never finished");
  await typing;
});

test("a hidden tab still gets frames until input that waits on one is acked", async () => {
  const { page, frames } = hiddenTab({ ack: afterNextFrame, frame: () => sleep(300) });
  await page.keyboard.press("a");
  await page.keyboard.type("bc");
  assert.ok(frames.length >= 2);
});
