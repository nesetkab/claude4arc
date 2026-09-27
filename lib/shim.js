import { createHash } from "node:crypto";

function agentShim(version) {
  if (window.__arcShim?.version === version) return;
  const state = { log: [], policy: null };
  const opens = [];
  const stubs = new Map();
  const shim = {
    version,
    dialogs: state,
    opens,
    deliver(id, data, origin) {
      const stub = stubs.get(id);
      const event = new MessageEvent("message", { data, origin });
      if (stub) Object.defineProperty(event, "source", { value: stub });
      window.dispatchEvent(event);
      return Boolean(stub);
    },
    closeStub(id) {
      const stub = stubs.get(id);
      if (stub) stub.closed = true;
    },
    setStubUrl(id, url) {
      const entry = stubs.get(id)?.entry;
      if (entry) entry.url = url;
    },
  };
  Object.defineProperty(window, "__arcShim", { value: shim, configurable: true, writable: true });
  const current = () => window.__arcShim === shim;
  const events = [];
  shim.events = events;
  const note = (kind, detail) => {
    events.push({ kind, detail: String(detail ?? "").slice(0, 160) });
  };
  const answer = (type, message, fallback) => {
    const policy = state.policy;
    state.policy = null;
    const accepted = type === "alert" ? true : Boolean(policy?.accept);
    state.log.push({ type, message: String(message ?? ""), accepted });
    if (type === "confirm") return accepted;
    if (type === "prompt") return accepted ? String(policy.text ?? fallback ?? "") : null;
  };
  window.alert = function alert(message) {
    answer("alert", message);
  };
  window.confirm = function confirm(message) {
    return answer("confirm", message);
  };
  window.prompt = function prompt(message, fallback) {
    return answer("prompt", message, fallback);
  };
  const absolute = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  };
  const namedFrameExists = (name) => {
    const selector = `iframe[name="${CSS.escape(name)}"], frame[name="${CSS.escape(name)}"]`;
    if (document.querySelector(selector)) return true;
    try {
      if (window.top.document.querySelector(selector)) return true;
    } catch {}
    let view = window;
    try {
      while (view) {
        if (view.name === name) return true;
        if (view === view.parent) break;
        view = view.parent;
      }
    } catch {}
    return false;
  };
  const opensWindow = (target) => {
    const name = String(target || "");
    const lower = name.toLowerCase();
    if (!name || lower === "_self" || lower === "_parent" || lower === "_top") return false;
    if (lower === "_blank") return true;
    return !namedFrameExists(name);
  };
  const nativeOpen = window.open;
  window.open = function open(url, target) {
    if (!current() || (target && !opensWindow(target))) return nativeOpen.apply(window, arguments);
    const entry = { kind: "window.open", url: url ? absolute(url) : "about:blank", id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` };
    opens.push(entry);
    const setUrl = (value) => {
      entry.url = absolute(value);
    };
    const place = { assign: setUrl, replace: setUrl, reload() {} };
    Object.defineProperty(place, "href", { get: () => entry.url, set: setUrl });
    const stub = { closed: false, opener: window, entry, focus() {}, blur() {}, postMessage() {}, close() { stub.closed = true; } };
    Object.defineProperty(stub, "location", { get: () => place, set: setUrl });
    stubs.set(entry.id, stub);
    return stub;
  };
  const retarget = (form, submitter) => {
    if (!current()) return;
    const target = submitter?.getAttribute?.("formtarget") || form.getAttribute("target");
    if (!opensWindow(target)) return;
    const url = new URL(absolute(form.getAttribute("action") || location.href));
    if ((form.method || "get").toLowerCase() === "get") url.search = new URLSearchParams(new FormData(form, submitter ?? null)).toString();
    opens.push({ kind: "form", url: url.href, method: (form.method || "get").toLowerCase() });
    form.setAttribute("target", "_top");
    if (submitter?.hasAttribute?.("formtarget")) submitter.setAttribute("formtarget", "_top");
  };
  addEventListener("submit", (event) => retarget(event.target, event.submitter), true);
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function submit() {
    retarget(this);
    return nativeSubmit.call(this);
  };
  addEventListener("click", (event) => {
    if (!current() || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.composedPath().find((node) => node instanceof Element && node.matches("a[href], area[href]"));
    if (!anchor || !anchor.href || anchor.href.startsWith("javascript:")) return;
    if (!/^(https?|blob|data|about):/i.test(anchor.href)) {
      event.preventDefault();
      note("external link", anchor.href);
      return;
    }
    if (anchor.hasAttribute("download") || !opensWindow(anchor.getAttribute("target"))) return;
    event.preventDefault();
    opens.push({ kind: "link", url: anchor.href });
  });
  const clipboard = { text: "" };
  shim.clipboard = clipboard;
  const fakeClipboard = {
    writeText: async (text) => {
      clipboard.text = String(text);
      note("clipboard", clipboard.text);
    },
    write: async () => {
      note("clipboard", "(rich content)");
    },
    readText: async () => clipboard.text,
    read: async () => [],
  };
  try {
    Object.defineProperty(navigator, "clipboard", { value: fakeClipboard, configurable: true });
  } catch {}
  const nativeExec = document.execCommand.bind(document);
  document.execCommand = function execCommand(command, ...rest) {
    if (current() && /^(copy|cut)$/i.test(command)) {
      clipboard.text = String(document.getSelection() ?? "");
      note("clipboard", clipboard.text);
      return true;
    }
    return nativeExec(command, ...rest);
  };
  window.print = function print() {
    note("print dialog", location.href);
  };
  const blockFullscreen = function () {
    note("fullscreen", this?.tagName ?? "document");
    return Promise.resolve();
  };
  for (const name of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]) {
    if (Element.prototype[name]) Element.prototype[name] = blockFullscreen;
  }
  if (navigator.share) navigator.share = async (data) => note("share sheet", JSON.stringify(data ?? {}));
  if (window.Notification) window.Notification.requestPermission = async () => {
    note("permission", "notifications denied");
    return "denied";
  };
  if (navigator.geolocation) {
    const deny = (success, failure) => {
      note("permission", "location denied");
      failure?.({ code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1 });
      return 0;
    };
    navigator.geolocation.getCurrentPosition = deny;
    navigator.geolocation.watchPosition = deny;
  }
  if (navigator.mediaDevices?.getUserMedia) {
    navigator.mediaDevices.getUserMedia = async () => {
      note("permission", "camera/microphone denied");
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  }
}

const SHIM_SOURCE = agentShim.toString();

export const AGENT_SHIM = `(${SHIM_SOURCE})(${JSON.stringify(createHash("sha1").update(SHIM_SOURCE).digest("hex").slice(0, 10))});`;
