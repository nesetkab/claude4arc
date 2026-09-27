import test from "node:test";
import assert from "node:assert/strict";
import { splitFrameSelector, pathOf, prefixRefs } from "../../lib/frames.js";

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
