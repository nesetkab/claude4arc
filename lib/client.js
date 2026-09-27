import fs from "node:fs";
import net from "node:net";
import { browserByKey, browserOfSocket, socketCandidates } from "./browsers.js";

export class BridgeError extends Error {}

function connectTo(file) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export class Bridge {
  static async connect({ browser } = {}) {
    const preferred = browser ?? process.env.CLAUDE4ARC_BROWSER ?? null;
    const candidates = socketCandidates(preferred).filter((file) => fs.existsSync(file));
    let lastError = null;
    for (const file of candidates) {
      try {
        return new Bridge(await connectTo(file), browserOfSocket(file));
      } catch (error) {
        lastError = error;
      }
    }
    const name = preferred ? browserByKey(preferred).name : "Arc or another supported browser";
    if (!lastError || lastError.code === "ENOENT" || lastError.code === "ECONNREFUSED") {
      throw new BridgeError(
        `The claude4arc bridge is not running. Make sure ${name} is open and the "claude4arc" extension is enabled. Run \`claude4arc doctor\` for details.`,
      );
    }
    throw new BridgeError(`Cannot connect to the claude4arc bridge: ${lastError.message}`);
  }

  constructor(socket, browser = "arc") {
    this.socket = socket;
    this.browser = browser;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, index);
        text = text.slice(index + 1);
        if (line.trim()) this.#dispatch(JSON.parse(line));
      }
    });
    socket.on("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new BridgeError("The claude4arc bridge connection closed"));
      }
      this.pending.clear();
    });
  }

  #dispatch(message) {
    if (message.type) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new BridgeError(message.error));
    else entry.resolve(message.result);
  }

  call(api, ...args) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, api, args }) + "\n");
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.end();
  }
}
