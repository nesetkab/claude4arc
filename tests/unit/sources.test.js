import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "claude4arc-home-"));
const { libraryPrelude } = await import("../../lib/inpage.js");
const { editorPrelude } = await import("../../lib/editors.js");
const { AGENT_SHIM } = await import("../../lib/shim.js");

test("the scripts injected into pages compile", () => {
  for (const source of [libraryPrelude(), editorPrelude(), AGENT_SHIM]) assert.doesNotThrow(() => new vm.Script(source));
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
