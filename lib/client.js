import net from "node:net";
import { SOCKET_PATH } from "./paths.js";

export class BridgeError extends Error {}

export class Bridge {
  static connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH);
      socket.once("connect", () => resolve(new Bridge(socket)));
      socket.once("error", (error) => {
        reject(
          new BridgeError(
            error.code === "ENOENT" || error.code === "ECONNREFUSED"
              ? "Arc bridge is not running. Make sure Arc is open and the \"claude4arc\" extension is enabled. Run `claude4arc doctor` for details."
              : `Cannot connect to Arc bridge: ${error.message}`,
          ),
        );
      });
    });
  }

  constructor(socket) {
    this.socket = socket;
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
        reject(new BridgeError("Arc bridge connection closed"));
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
