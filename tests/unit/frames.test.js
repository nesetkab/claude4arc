import test from "node:test";
import assert from "node:assert/strict";
import { splitFrameSelector, pathOf, prefixRefs, REGISTER_CLOSED_ROOT } from "../../lib/frames.js";
import { openLibrary } from "../../lib/inpage.js";

test("splitFrameSelector separates a frame path from the inner selector", () => {
  assert.deepEqual(splitFrameSelector("@24 >> text=Submit"), { path: [24], local: "text=Submit" });
  assert.deepEqual(splitFrameSelector("@24.1"), { path: [24], local: "@1" });
  assert.deepEqual(splitFrameSelector("text=Save"), { path: [], local: "text=Save" });
});

test("pathOf and prefixRefs agree on nested frame refs", () => {
  assert.deepEqual(pathOf({ prefix: "24.3." }), [24, 3]);
  assert.equal(prefixRefs('@1 button "Verify"', "24."), '@24.1 button "Verify"');
  assert.equal(prefixRefs("@1", ""), "@1");
});

test("registerClosedRoot reaches the page library only with its token", () => {
  const registered = [];
  const view = {};
  view.parent = view;
  openLibrary(view, "lib", "token", () => ({ registerClosedRoot: (root) => registered.push(root) }));
  const register = new Function("window", "key", `return (${REGISTER_CLOSED_ROOT}).call(this, key)`);
  const root = { host: {} };
  register.call(root, view, { name: "lib", token: "wrong" });
  assert.deepEqual(registered, []);
  register.call(root, view, { name: "lib", token: "token" });
  assert.deepEqual(registered, [root]);
});
