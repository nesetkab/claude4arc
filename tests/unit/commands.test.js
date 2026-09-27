import test from "node:test";
import assert from "node:assert/strict";
import { shellWords, splitChain, parseBatchLine, batchLabel } from "../../lib/commands.js";

test("shellWords follows shell quoting", () => {
  assert.deepEqual(shellWords(`fill "text=Full name" Ada`), ["fill", "text=Full name", "Ada"]);
  assert.deepEqual(shellWords(`click 'role=button[name="Save"]'`), ["click", 'role=button[name="Save"]']);
  assert.deepEqual(shellWords(`type $'a\\n  b'`), ["type", "a\n  b"]);
  assert.deepEqual(shellWords(`x "\\"quoted\\"" ""`), ["x", '"quoted"', ""]);
  assert.deepEqual(shellWords(`a\\ b c`), ["a b", "c"]);
});

test("shellWords rejects unclosed quotes", () => {
  assert.throws(() => shellWords(`fill "text=Name`), /Unclosed "/);
  assert.throws(() => shellWords(`fill 'text=Name`), /Unclosed '/);
});

test("splitChain splits on -- and drops empty steps", () => {
  assert.deepEqual(splitChain(["goto", "a", "--", "click", "b", "--"]), [["goto", "a"], ["click", "b"]]);
});

test("parseBatchLine reads the label, the chain, and -s", () => {
  const line = `form: goto https://a.test -- fill "text=Name" Ada -- click text=Save -s`;
  assert.equal(batchLabel(line, 0), "form");
  assert.deepEqual(parseBatchLine(line), {
    steps: [["goto", "https://a.test"], ["fill", "text=Name", "Ada"], ["click", "text=Save"]],
    snapAfter: true,
  });
  assert.equal(batchLabel("goto https://a.test", 4), "5");
  assert.deepEqual(parseBatchLine("goto https://a.test").steps, [["goto", "https://a.test"]]);
});

test("a URL with a port is not read as a label", () => {
  assert.equal(batchLabel("goto http://127.0.0.1:8900/b1.html", 0), "1");
});
