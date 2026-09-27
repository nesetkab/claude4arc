import test from "node:test";
import assert from "node:assert/strict";
import { describeKey, parseChord, modifierMask } from "../../lib/keys.js";

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
