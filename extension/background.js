const HOST_NAME = "com.arcforclaude.bridge";
const PROTOCOL_VERSION = "1.3";

let port = null;
let reconnectTimer = null;

const debuggee = (target) => (typeof target === "number" ? { tabId: target } : target);

const handlers = {
  "tabs.query": (query) => chrome.tabs.query(query ?? {}),
  "tabs.get": (tabId) => chrome.tabs.get(tabId),
  "tabs.create": (props) => chrome.tabs.create(props ?? {}),
  "tabs.update": (tabId, props) => chrome.tabs.update(tabId, props),
  "tabs.remove": (tabId) => chrome.tabs.remove(tabId),
  "tabs.goBack": (tabId) => chrome.tabs.goBack(tabId),
  "tabs.goForward": (tabId) => chrome.tabs.goForward(tabId),
  "windows.getAll": (query) => chrome.windows.getAll(query ?? {}),
  "windows.getLastFocused": () => chrome.windows.getLastFocused(),
  "windows.update": (windowId, props) => chrome.windows.update(windowId, props),
  "debugger.attach": (target) => chrome.debugger.attach(debuggee(target), PROTOCOL_VERSION),
  "debugger.detach": (target) => chrome.debugger.detach(debuggee(target)),
  "debugger.send": (target, method, params) => chrome.debugger.sendCommand(debuggee(target), method, params ?? {}),
  "debugger.getTargets": () => chrome.debugger.getTargets(),
  "extension.info": () => ({
    version: chrome.runtime.getManifest().version,
    id: chrome.runtime.id,
    userAgent: navigator.userAgent,
    features: ["sessions", "reload"],
  }),
  "extension.reload": () => {
    setTimeout(() => chrome.runtime.reload(), 50);
    return true;
  },
};

function post(message) {
  try {
    port?.postMessage(message);
  } catch {
    port = null;
  }
}

async function handle({ id, api, args = [] }) {
  const handler = handlers[api];
  if (!handler) {
    post({ id, error: `Unknown api: ${api}` });
    return;
  }
  try {
    const result = await handler(...args);
    post({ id, result: result ?? null });
  } catch (error) {
    post({ id, error: String(error?.message ?? error) });
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 1000);
}

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    port = null;
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    scheduleReconnect();
  });
  post({ type: "hello", version: chrome.runtime.getManifest().version });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  post({ type: "event", tabId: source.tabId, sessionId: source.sessionId, method, params: params ?? {} });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  post({ type: "detached", tabId: source.tabId, reason });
});

chrome.tabs.onCreated.addListener((tab) => {
  post({ type: "tabCreated", tab });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  post({ type: "tabRemoved", tabId });
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
