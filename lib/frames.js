export const ROOT_INPUT = { sessionId: null, x: 0, y: 0 };

export const ROOT_CONTEXT = { sessionId: null, contextId: null, input: ROOT_INPUT, offset: { x: 0, y: 0 }, prefix: "", depth: 0 };

export const scopeOf = (context) => ({ sessionId: context.sessionId, contextId: context.contextId });

export const CLOSED_AWARE = new Set(["snapshot", "find", "resolve", "count", "seekProbe"]);

function registerClosedRoot(key) {
  let view = window;
  while (view) {
    try {
      view[key]?.registerClosedRoot(this);
    } catch {}
    let parent = view.parent === view ? null : view.parent;
    try {
      void parent?.[key];
    } catch {
      parent = null;
    }
    view = parent;
  }
  return true;
}

export const REGISTER_CLOSED_ROOT = registerClosedRoot.toString();

export function splitFrameSelector(selector) {
  const text = String(selector).trim();
  const match = text.match(/^@(\d+(?:\.\d+)*)(?:\s*>>\s*(?!nth=)([\s\S]+))?$/);
  if (!match) return { path: [], local: text };
  const parts = match[1].split(".").map(Number);
  if (match[2] !== undefined) return { path: parts, local: match[2].trim() };
  return { path: parts.slice(0, -1), local: `@${parts.at(-1)}` };
}

export const pathOf = (context) => context.prefix.split(".").filter(Boolean).map(Number);

export const prefixRefs = (text, prefix) => (prefix ? text.replace(/@(\d+)/g, `@${prefix}$1`) : text);
