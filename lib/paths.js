import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = path.join(os.homedir(), ".arc-bridge");
export const SOCKET_PATH = path.join(STATE_DIR, "bridge.sock");
export const LOG_PATH = path.join(STATE_DIR, "host.log");
export const TASKS_PATH = path.join(STATE_DIR, "tasks.json");
export const HOST_NAME = "com.arcforclaude.bridge";
export const EXTENSION_ID = "bfbcdjkeonepklbmjjghoddpahhhnimp";
export const NATIVE_HOSTS_DIR = path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
