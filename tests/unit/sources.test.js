import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { LIBRARY_PRELUDE } from "../../lib/inpage.js";
import { EDITOR_PRELUDE } from "../../lib/editors.js";
import { AGENT_SHIM } from "../../lib/shim.js";

test("the scripts injected into pages compile", () => {
  for (const source of [LIBRARY_PRELUDE, EDITOR_PRELUDE, AGENT_SHIM]) assert.doesNotThrow(() => new vm.Script(source));
});

test("the extension manifest is valid and keeps its fixed ID key", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.key.length > 100);
  for (const permission of ["debugger", "nativeMessaging", "tabs"]) assert.ok(manifest.permissions.includes(permission), permission);
});

test("package.json and the extension report the same version", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, manifest.version);
});
