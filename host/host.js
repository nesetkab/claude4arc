import net from "node:net";
import fs from "node:fs";
import { SOCKET_PATH, STATE_DIR, LOG_PATH } from "../lib/paths.js";

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

function log(...parts) {
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${parts.join(" ")}\n`);
}

let extensionInfo = null;
let nextId = 1;
const pending = new Map();
const clients = new Set();
const attached = new Set();
const dialogs = new Map();
const autoDialogTabs = new Set();
const handledDialogs = new Map();
const sessions = new Map();
const shims = new Map();
const autoAttached = new Set();
const shimScripts = new Map();

const debuggee = (tabId, sessionId) => (sessionId ? { tabId, sessionId } : tabId);
const send = (tabId, sessionId, method, params = {}) => callExtension("debugger.send", [debuggee(tabId, sessionId), method, params]);

const popupLinks = new Map();

const POPUP_SHIM = `(() => {
  if (Object.prototype.hasOwnProperty.call(window, "__arcOpenerLink")) return;
  Object.defineProperty(window, "__arcOpenerLink", { value: true });
  const send = (payload) => {
    try {
      window.__arcOpener(JSON.stringify(payload));
    } catch {}
  };
  const opener = {
    closed: false,
    focus() {},
    blur() {},
    postMessage(data, targetOrigin) {
      send({ type: "message", data, targetOrigin: String(targetOrigin ?? "*"), origin: location.origin });
    },
  };
  Object.defineProperty(window, "opener", { get: () => opener, set() {}, configurable: true });
  window.close = function close() {
    send({ type: "close" });
  };
})();`;

const OPENER_CALL = `function (action, id, data, origin) {
  const shim = globalThis.__arcShim;
  if (!shim) return false;
  if (action === "deliver") return shim.deliver(id, data, origin);
  if (action === "close") return shim.closeStub(id);
  if (action === "url") return shim.setStubUrl(id, data);
  return false;
}`;

async function linkPopup(popupTabId, link) {
  await attach(popupTabId);
  popupLinks.set(popupTabId, link);
  await send(popupTabId, null, "Page.enable").catch(() => {});
  await send(popupTabId, null, "Runtime.enable").catch(() => {});
  await send(popupTabId, null, "Runtime.addBinding", { name: "__arcOpener" });
  await send(popupTabId, null, "Page.addScriptToEvaluateOnNewDocument", { source: POPUP_SHIM, runImmediately: true });
  return true;
}

async function callOpener(link, action, data = null, origin = null) {
  const global = await send(link.tabId, null, "Runtime.evaluate", { expression: "globalThis" }).catch(() => null);
  const objectId = global?.result?.objectId;
  if (!objectId) return;
  await send(link.tabId, null, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: OPENER_CALL,
    arguments: [{ value: action }, { value: link.stubId }, { value: data }, { value: origin }],
    returnByValue: true,
  }).catch(() => {});
  await send(link.tabId, null, "Runtime.releaseObject", { objectId }).catch(() => {});
}

function onPopupEvent(message) {
  const link = popupLinks.get(message.tabId);
  if (!link || message.sessionId) return;
  if (message.method === "Runtime.bindingCalled" && message.params.name === "__arcOpener") {
    let payload;
    try {
      payload = JSON.parse(message.params.payload);
    } catch {
      return;
    }
    if (payload.type === "message") callOpener(link, "deliver", payload.data, payload.origin);
    if (payload.type === "close") {
      callOpener(link, "close");
      callExtension("tabs.remove", [message.tabId]).catch(() => {});
    }
  }
  if (message.method === "Page.frameNavigated" && !message.params.frame?.parentId) callOpener(link, "url", message.params.frame.url);
}

async function injectShim(tabId, sessionId) {
  const shim = shims.get(tabId);
  if (!shim) return;
  if (!sessionId) await send(tabId, null, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
  const key = `${tabId}:${sessionId ?? "root"}`;
  const previous = shimScripts.get(key);
  if (previous?.source === shim) return;
  if (previous) await send(tabId, sessionId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: previous.identifier }).catch(() => {});
  await send(tabId, sessionId, "Page.enable").catch(() => {});
  const result = await send(tabId, sessionId, "Page.addScriptToEvaluateOnNewDocument", { source: shim, runImmediately: true }).catch(() => null);
  if (result?.identifier) shimScripts.set(key, { source: shim, identifier: result.identifier });
}

async function prepareSession(tabId, sessionId) {
  await send(tabId, sessionId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  await injectShim(tabId, sessionId);
}

async function enableAutoAttach(tabId, refresh) {
  if (autoAttached.has(tabId) && !refresh) return;
  autoAttached.add(tabId);
  if (refresh) {
    sessions.delete(tabId);
    await send(tabId, null, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  }
  await send(tabId, null, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
}

function forgetTab(tabId) {
  attached.delete(tabId);
  dialogs.delete(tabId);
  autoDialogTabs.delete(tabId);
  handledDialogs.delete(tabId);
  sessions.delete(tabId);
  shims.delete(tabId);
  autoAttached.delete(tabId);
  for (const key of shimScripts.keys()) if (key.startsWith(`${tabId}:`)) shimScripts.delete(key);
  popupLinks.delete(tabId);
}

function sendToExtension(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sendToClient(client, message) {
  if (!client.destroyed) client.write(JSON.stringify(message) + "\n");
}

function callExtension(api, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    sendToExtension({ id, api, args });
  });
}

function onExtensionMessage(message) {
  if (message.type === "hello") {
    extensionInfo = { version: message.version, connectedAt: new Date().toISOString() };
    log("extension hello", message.version);
    return;
  }
  if (message.type) {
    if (message.type === "tabRemoved" && popupLinks.has(message.tabId)) callOpener(popupLinks.get(message.tabId), "close");
    if (message.type === "detached" || message.type === "tabRemoved") forgetTab(message.tabId);
    if (message.type === "event") onPopupEvent(message);
    if (message.method === "Target.attachedToTarget") {
      const info = message.params.targetInfo;
      const tabSessions = sessions.get(message.tabId) ?? new Map();
      tabSessions.set(message.params.sessionId, { sessionId: message.params.sessionId, targetId: info.targetId, type: info.type, url: info.url, parent: message.sessionId ?? null });
      sessions.set(message.tabId, tabSessions);
      if (info.type === "iframe") prepareSession(message.tabId, message.params.sessionId);
    }
    if (message.method === "Target.detachedFromTarget") {
      sessions.get(message.tabId)?.delete(message.params.sessionId);
      shimScripts.delete(`${message.tabId}:${message.params.sessionId}`);
    }
    if (message.method === "Page.javascriptDialogOpening") {
      if (autoDialogTabs.has(message.tabId)) {
        const accept = message.params.type === "beforeunload";
        send(message.tabId, message.sessionId, "Page.handleJavaScriptDialog", { accept }).catch(() => {});
        const log = handledDialogs.get(message.tabId) ?? [];
        log.push({ type: message.params.type, message: message.params.message, accepted: accept, native: true });
        handledDialogs.set(message.tabId, log.slice(-20));
      } else {
        dialogs.set(message.tabId, message.params);
      }
    }
    if (message.method === "Page.javascriptDialogClosed") dialogs.delete(message.tabId);
    if (message.method === "Page.fileChooserOpened" && autoDialogTabs.has(message.tabId)) {
      const log = handledDialogs.get(message.tabId) ?? [];
      log.push({ type: "filechooser", message: "", accepted: false, native: true });
      handledDialogs.set(message.tabId, log.slice(-20));
    }
    for (const client of clients) sendToClient(client, message);
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error));
  else entry.resolve(message.result);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const body = buffer.subarray(4, 4 + length).toString("utf8");
    buffer = buffer.subarray(4 + length);
    try {
      onExtensionMessage(JSON.parse(body));
    } catch (error) {
      log("bad message from extension", error.message);
    }
  }
});

process.stdin.on("end", () => {
  log("extension disconnected");
  shutdown();
});

async function attach(tabId) {
  if (attached.has(tabId)) {
    await enableAutoAttach(tabId, false);
    return { already: true };
  }
  try {
    await callExtension("debugger.attach", [tabId]);
    attached.add(tabId);
    await enableAutoAttach(tabId, false);
    return { already: false };
  } catch (error) {
    if (!/already attached/i.test(error.message)) throw error;
    attached.add(tabId);
    await enableAutoAttach(tabId, true);
    return { already: true };
  }
}

async function onClientRequest(client, request) {
  const { id, api, args = [] } = request;
  try {
    let result;
    if (api === "host.status") {
      result = { host: { pid: process.pid, node: process.version }, extension: extensionInfo, attached: [...attached] };
    } else if (api === "host.dialog") {
      result = dialogs.get(args[0]) ?? null;
    } else if (api === "host.autoDialogs") {
      if (args[1]) {
        autoDialogTabs.add(args[0]);
        if (args[2]) shims.set(args[0], args[2]);
        await injectShim(args[0], null);
        for (const sessionId of sessions.get(args[0])?.keys() ?? []) await injectShim(args[0], sessionId);
      } else {
        autoDialogTabs.delete(args[0]);
        shims.delete(args[0]);
      }
      result = true;
    } else if (api === "host.linkPopup") {
      result = await linkPopup(args[0], args[1]);
    } else if (api === "host.sessions") {
      result = [...(sessions.get(args[0])?.values() ?? [])];
    } else if (api === "host.handledDialogs") {
      result = handledDialogs.get(args[0]) ?? [];
      handledDialogs.delete(args[0]);
    } else if (api === "debugger.attach") {
      result = await attach(args[0]);
    } else {
      if (api === "debugger.detach") forgetTab(args[0]);
      result = await callExtension(api, args);
      if (api === "debugger.send" && args[1] === "Page.handleJavaScriptDialog") dialogs.delete(args[0]);
    }
    sendToClient(client, { id, result });
  } catch (error) {
    sendToClient(client, { id, error: error.message });
  }
}

function onClientClose(client) {
  clients.delete(client);
}

try {
  fs.unlinkSync(SOCKET_PATH);
} catch {}

const server = net.createServer((client) => {
  clients.add(client);
  let text = "";
  client.setEncoding("utf8");
  client.on("data", (chunk) => {
    text += chunk;
    let index;
    while ((index = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, index);
      text = text.slice(index + 1);
      if (!line.trim()) continue;
      try {
        onClientRequest(client, JSON.parse(line));
      } catch (error) {
        log("bad message from client", error.message);
      }
    }
  });
  client.on("close", () => onClientClose(client));
  client.on("error", () => {});
});

let socketInode = null;

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600);
  socketInode = fs.statSync(SOCKET_PATH).ino;
  log("host listening", process.pid);
});

function shutdown() {
  server.close();
  try {
    if (fs.statSync(SOCKET_PATH).ino === socketInode) fs.unlinkSync(SOCKET_PATH);
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
