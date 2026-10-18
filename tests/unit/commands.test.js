import test from "node:test";
import assert from "node:assert/strict";
import { shellWords, splitChain, parseBatchLine, batchLabel, retryDecision, receiptText, stepLimit } from "../../lib/commands.js";

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

test("only commands that have not sent input are retried after a detach", () => {
  const detached = new Error("Detached while handling command.");
  const stale = new Error("Cannot find context with specified id");
  assert.equal(retryDecision("click", new Error("Could not find #x"), false), "throw");
  assert.equal(retryDecision("click", stale, false), "retry");
  assert.equal(retryDecision("click", detached, true), "stop");
  assert.equal(retryDecision("type", detached, true), "stop");
  assert.equal(retryDecision("press", stale, true), "stop");
  assert.equal(retryDecision("fill", detached, true), "retry");
  assert.equal(retryDecision("text", detached, false), "retry");
  assert.equal(retryDecision("reload", detached, false), "stop");
  assert.equal(retryDecision("eval", stale, false), "retry");
});

test("receiptText prints a warning once", () => {
  assert.equal(receiptText({ warning: "#x holds nothing readable after fill" }), "warning: #x holds nothing readable after fill");
});

test("each step has a time limit that waits can stretch", () => {
  assert.equal(stepLimit("click", ["#x"], 45_000), 45_000);
  assert.equal(stepLimit("wait", ["#x"], 45_000), 45_000);
  assert.equal(stepLimit("wait", ["#x", "90000"], 45_000), 95_000);
  assert.equal(stepLimit("wait", ["70000"], 45_000), 75_000);
  assert.equal(stepLimit("wait", ["download"], 45_000), 65_000);
  assert.equal(stepLimit("click", ["#x"], 5_000), 5_000);
});
