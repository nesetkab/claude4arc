#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
const { key, ...storeManifest } = manifest;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "claude4arc-extension-"));
for (const name of fs.readdirSync(source)) {
  if (name === "manifest.json" || name.startsWith(".")) continue;
  fs.cpSync(path.join(source, name), path.join(staging, name), { recursive: true });
}
fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(storeManifest, null, 2) + "\n");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const output = path.join(dist, `claude4arc-extension-${manifest.version}.zip`);
fs.rmSync(output, { force: true });
execFileSync("zip", ["-q", "-r", "-X", output, "."], { cwd: staging });
fs.rmSync(staging, { recursive: true, force: true });
console.log(`${output}${key ? " (the manifest key was removed for the Chrome Web Store)" : ""}`);
