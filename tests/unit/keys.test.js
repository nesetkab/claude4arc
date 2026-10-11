import test from "node:test";
import assert from "node:assert/strict";
import { describeKey, parseChord, modifierMask, keyEvents, typingSteps, shiftedText } from "../../lib/keys.js";

test("describeKey maps characters and named keys", () => {
  assert.equal(describeKey("a").code, "KeyA");
  assert.equal(describeKey("A").shift, true);
  assert.equal(describeKey("7").code, "Digit7");
  assert.equal(describeKey("Enter").key, "Enter");
  assert.throws(() => describeKey("Nope"), /Unknown key/);
});

test("parseChord splits modifiers from the key, including a literal +", () => {
  assert.deepEqual(parseChord("Shift+Tab"), { modifiers: ["Shift"], key: "Tab" });
  assert.deepEqual(parseChord("+"), { modifiers: [], key: "+" });
  assert.deepEqual(parseChord("Meta++"), { modifiers: ["Meta"], key: "+" });
  assert.throws(() => parseChord("Hyper+a"), /Unknown modifier/);
});

test("modifierMask uses the DevTools bit values", () => {
  assert.equal(modifierMask(["Alt"]), 1);
  assert.equal(modifierMask(["Control"]), 2);
  assert.equal(modifierMask(["Meta"]), 4);
  assert.equal(modifierMask(["Shift"]), 8);
  assert.equal(modifierMask(["Meta", "Shift"]), 12);
});

test("describeKey accepts any single character, including astral ones", () => {
  assert.deepEqual(describeKey("👋"), { key: "👋", code: "", keyCode: 0, text: "👋" });
  assert.equal(describeKey("é").text, "é");
  assert.throws(() => describeKey("👋👋"), /Unknown key/);
});

test("keyEvents has no key events for characters off the US layout", () => {
  for (const char of ["👋", "日", "é", "ß"]) assert.equal(keyEvents(char), null);
  assert.equal(keyEvents("a")[0].text, "a");
  assert.equal(keyEvents("\n")[0].key, "Enter");
  assert.equal(keyEvents("\t")[0].type, "rawKeyDown");
});

test("typingSteps sends keys where it can and inserts the rest as text", () => {
  const steps = typingSteps("hi 👋🏽 日本 é!");
  assert.deepEqual(
    steps.map((step) => step.text ?? step.events.filter((event) => event.type !== "keyUp").map((event) => event.key).join("")),
    ["hi ", "👋🏽", " ", "日本", " ", "é", "!"],
  );
  assert.equal(steps.filter((step) => step.text !== undefined).map((step) => step.text).join(""), "👋🏽日本é");
});

test("shiftedText follows the US layout", () => {
  assert.equal(shiftedText("a"), "A");
  assert.equal(shiftedText("1"), "!");
  assert.equal(shiftedText("0"), ")");
  assert.equal(shiftedText("/"), "?");
  assert.equal(shiftedText("A"), "A");
  assert.equal(shiftedText("\r"), "\r");
});
