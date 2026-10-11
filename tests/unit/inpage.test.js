import test from "node:test";
import assert from "node:assert/strict";
import { inPageLibrary, openLibrary, LIBRARY_KEY, LIBRARY_PRELUDE } from "../../lib/inpage.js";

const { splitSelector } = inPageLibrary();

const shape = (css) =>
  splitSelector(css).map((steps) => steps.map(({ combinator, base, tests }) => [combinator, base, ...tests.map((item) => `${item.kind}:${item.value}`)]));

test("splitSelector keeps combinators before a text pseudo", () => {
  assert.deepEqual(shape('ul > :has-text("x")'), [[[null, "ul"], [">", "*", "has-text:x"]]]);
  assert.deepEqual(shape('form :has-text("Submit")'), [[[null, "form"], [" ", "*", "has-text:Submit"]]]);
  assert.deepEqual(shape('tr:has-text("a") :text-is("b")'), [[[null, "tr", "has-text:a"], [" ", "*", "text-is:b"]]]);
  assert.deepEqual(shape('tr:has-text("Paper clips") button'), [[[null, "tr", "has-text:Paper clips"], [" ", "button"]]]);
});

test("splitSelector applies every chained text pseudo", () => {
  assert.deepEqual(shape(`div.card:has-text("a"):has-text('b')`), [[[null, "div.card", "has-text:a", "has-text:b"]]]);
});

test("splitSelector adds * after a trailing combinator", () => {
  assert.deepEqual(shape('ul:has-text("x") >'), [[[null, "ul", "has-text:x"], [">", "*"]]]);
});

test("splitSelector ignores combinators inside quotes, brackets, and parens", () => {
  assert.deepEqual(shape(`a[title="x > y"]:has-text("1 + 2, 3") ~ li:nth-child(2n+1)`), [
    [[null, `a[title="x > y"]`, "has-text:1 + 2, 3"], ["~", "li:nth-child(2n+1)"]],
  ]);
  assert.deepEqual(shape('li:has-text("a"), p'), [[[null, "li", "has-text:a"]], [[null, "p"]]]);
});

test("the page library lives behind a token on a locked property", () => {
  const view = {};
  let created = 0;
  const create = () => ({ id: ++created });
  const api = openLibrary(view, "lib", "secret", create);
  assert.equal(openLibrary(view, "lib", "secret", create), api);
  assert.equal(created, 1);
  assert.deepEqual(Object.keys(view), []);
  assert.equal(view.lib("guess"), null);
  assert.throws(() => {
    view.lib = () => api;
  }, TypeError);
  assert.throws(() => openLibrary(view, "lib", "other", create), /interfered/);
});

test("a page that defines the library slot first is refused", () => {
  const view = { lib: () => ({ snapshot: () => "spoof" }) };
  assert.throws(() => openLibrary(view, "lib", "secret", () => ({})), /interfered/);
});

test("the library slot name and token are not derived from the source alone", () => {
  assert.match(LIBRARY_KEY.name, /^__arcForClaude_[0-9a-f]{16}$/);
  assert.match(LIBRARY_KEY.token, /^[0-9a-f]{64}$/);
  assert.ok(LIBRARY_PRELUDE.includes(LIBRARY_KEY.token));
  assert.ok(!LIBRARY_PRELUDE.includes("||="));
});
