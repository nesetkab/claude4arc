const OWN_PREFIX = `chrome-extension://${chrome.runtime.id}/`;
const watched = new WeakSet();
let enabled = false;

const isForeign = (frame) => {
  const source = frame.getAttribute("src") || "";
  return /^chrome-extension:\/\//i.test(source) && !source.startsWith(OWN_PREFIX);
};

const isFrame = (node) => node.tagName === "IFRAME" || node.tagName === "FRAME";

function inspect(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (isFrame(node)) {
    if (isForeign(node)) node.remove();
    return;
  }
  const shadow = chrome.dom.openOrClosedShadowRoot(node);
  if (shadow) watch(shadow);
  for (const child of node.children) inspect(child);
}

function onMutations(records) {
  if (!enabled) return;
  for (const record of records) {
    if (record.type === "attributes") {
      if (isFrame(record.target) && isForeign(record.target)) record.target.remove();
      continue;
    }
    for (const node of record.addedNodes) {
      inspect(node);
      queueMicrotask(() => inspect(node));
    }
  }
}

function watch(root) {
  if (watched.has(root)) return;
  watched.add(root);
  new MutationObserver(onMutations).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  if (enabled) for (const child of root.children) inspect(child);
}

function enable() {
  if (enabled) return;
  enabled = true;
  sweep();
}

function sweep() {
  if (document.documentElement) inspect(document.documentElement);
}

function foreignFrames(root = document) {
  const found = [];
  for (const frame of root.querySelectorAll("iframe, frame")) if (isForeign(frame)) found.push(frame);
  for (const element of root.querySelectorAll("*")) {
    const shadow = chrome.dom.openOrClosedShadowRoot(element);
    if (shadow) found.push(...foreignFrames(shadow));
  }
  return found;
}

watch(document);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "arc-guard") enable();
  if (message?.type === "arc-sweep") {
    enable();
    sweep();
  }
  if (message?.type === "arc-sweep-once") for (const frame of foreignFrames()) frame.remove();
  if (message?.type === "arc-foreign?") sendResponse(foreignFrames().map((frame) => frame.getAttribute("src")));
});

chrome.runtime.sendMessage({ type: "arc-guard?" }).then((agent) => {
  if (agent) enable();
}).catch(() => {});
