import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.js";

export const CONFIG_PATH = path.join(STATE_DIR, "config.json");

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function updateConfig(changes) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const config = { ...readConfig(), ...changes };
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, CONFIG_PATH);
  return config;
}
