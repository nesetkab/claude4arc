import { createHash } from "node:crypto";

export function inPageLibrary() {
  const refs = new Map();
  const elementRefs = new WeakMap();
  let nextRef = 1;

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "TITLE", "BASE"]);
  const LEAF_TAGS = new Set(["SVG", "svg", "CANVAS", "VIDEO", "AUDIO", "IMG", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "FRAME"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "combobox", "listbox",
    "option", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "treeitem", "gridcell", "columnheader", "rowheader",
  ]);
  const STRUCTURE_ROLES = new Set([
    "heading", "img", "navigation", "main", "banner", "contentinfo", "complementary", "form",
    "dialog", "alertdialog", "alert", "list", "listitem", "table", "row", "cell", "region",
    "tablist", "tabpanel", "menu", "menubar", "tree", "grid", "search", "iframe", "figure", "status",
  ]);
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
    "treeitem", "cell", "gridcell", "columnheader", "rowheader", "checkbox", "radio", "switch",
  ]);

  const clean = (text, max = 100) => {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    return value.length > max ? value.slice(0, max - 1) + "…" : value;
  };

  const refFor = (element) => {
    let ref = elementRefs.get(element);
    if (!ref) {
      ref = nextRef++;
      elementRefs.set(element, ref);
      refs.set(ref, new WeakRef(element));
    }
    return ref;
  };

  const elementForRef = (ref) => {
    const element = refs.get(Number(ref))?.deref();
    if (!element || !element.isConnected) {
      throw new Error(`Ref @${ref} is stale or unknown. Take a new snapshot.`);
    }
    return element;
  };

  const inputRole = (element) => {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return element.getAttribute("role") === "switch" ? "switch" : "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return element.hasAttribute("list") ? "combobox" : "searchbox";
    if (type === "hidden") return null;
    if (type === "file") return "button";
    if (["color", "date", "datetime-local", "month", "time", "week"].includes(type)) return "textbox";
    return element.hasAttribute("list") ? "combobox" : "textbox";
  };

  const roleOf = (element) => {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit && explicit !== "none" && explicit !== "presentation" && explicit !== "generic") return explicit;
    if (explicit === "none" || explicit === "presentation") return null;
    const tag = element.tagName.toUpperCase();
    switch (tag) {
      case "A":
      case "AREA":
        return element.hasAttribute("href") ? "link" : null;
      case "BUTTON":
      case "SUMMARY":
        return "button";
      case "INPUT":
        return inputRole(element);
      case "SELECT":
        return element.multiple || element.size > 1 ? "listbox" : "combobox";
      case "TEXTAREA":
        return "textbox";
      case "OPTION":
        return "option";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
        return "heading";
      case "IMG":
        return element.getAttribute("alt") === "" ? null : "img";
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "HEADER":
        return element.closest("article, aside, main, nav, section") ? null : "banner";
      case "FOOTER":
        return element.closest("article, aside, main, nav, section") ? null : "contentinfo";
      case "ASIDE":
        return "complementary";
      case "FORM":
        return element.hasAttribute("name") || element.hasAttribute("aria-label") ? "form" : null;
      case "DIALOG":
        return "dialog";
      case "UL": case "OL": case "MENU":
        return "list";
      case "LI":
        return "listitem";
      case "TABLE":
        return "table";
      case "TR":
        return "row";
      case "TD":
        return "cell";
      case "TH":
        return "columnheader";
      case "IFRAME": case "FRAME":
        return "iframe";
      case "FIGURE":
        return "figure";
      case "SECTION":
        return element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby") ? "region" : null;
      case "SVG":
        return element.getAttribute("aria-label") || element.querySelector(":scope > title") ? "img" : null;
    }
    if (element.isContentEditable && !element.parentElement?.isContentEditable) return "textbox";
    return null;
  };

  const nameOf = (element, role) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.innerText ?? "")
        .join(" ");
      if (clean(text)) return clean(text);
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel && clean(ariaLabel)) return clean(ariaLabel);
    const tag = element.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      const type = (element.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return clean(element.value || type);
      if (type === "image") return clean(element.alt || element.value || "image");
      const label = [...(element.labels ?? [])].map((node) => node.innerText).join(" ");
      if (clean(label)) return clean(label);
      if (element.placeholder) return clean(element.placeholder);
      if (element.title) return clean(element.title);
      if (type === "file") return "Choose file";
      return "";
    }
    if (tag === "IMG") return clean(element.alt || element.title);
    if (tag === "SVG") return clean(element.querySelector(":scope > title")?.textContent);
    if (tag === "IFRAME" || tag === "FRAME") return clean(element.title || element.name || element.src, 80);
    if (NAME_FROM_CONTENT.has(role)) {
      const text = clean(element.innerText || element.textContent);
      if (text) return text;
      const image = element.querySelector("img[alt], svg[aria-label], [aria-label]");
      if (image) return clean(image.getAttribute("alt") || image.getAttribute("aria-label"));
    }
    return clean(element.title);
  };

  const frameOffset = (element) => {
    let x = 0;
    let y = 0;
    let view = element.ownerDocument.defaultView;
    while (view && view !== window) {
      const frame = view.frameElement;
      if (!frame) break;
      const rect = frame.getBoundingClientRect();
      const style = view.parent.getComputedStyle(frame);
      x += rect.left + frame.clientLeft + parseFloat(style.paddingLeft);
      y += rect.top + frame.clientTop + parseFloat(style.paddingTop);
      view = view.parent;
    }
    return { x, y };
  };

  const viewportRect = (element) => {
    const rect = element.getBoundingClientRect();
    const offset = frameOffset(element);
    return { x: rect.left + offset.x, y: rect.top + offset.y, width: rect.width, height: rect.height };
  };

  const inViewport = (rect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x < window.innerWidth &&
    rect.y < window.innerHeight &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0;

  const isVisible = (element) => {
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  const closedRoots = new WeakMap();
  const probedHosts = new WeakSet();

  const shadowOf = (element) => element.shadowRoot ?? closedRoots.get(element) ?? null;

  const childNodesOf = (node) => {
    if (node.tagName === "SLOT") {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length ? assigned : [...node.childNodes];
    }
    const shadow = node.nodeType === Node.ELEMENT_NODE ? shadowOf(node) : null;
    if (shadow) return [...shadow.childNodes];
    return [...node.childNodes];
  };

  const compactHref = (element) => {
    const raw = element.getAttribute("href");
    if (!raw || raw.startsWith("javascript:") || raw === "#") return null;
    let url;
    try {
      url = new URL(element.href);
    } catch {
      return clean(raw, 50);
    }
    const text = url.origin === location.origin ? url.pathname + url.search + url.hash : url.host + (url.pathname === "/" ? "" : url.pathname);
    return clean(text, 50);
  };

  const stateOf = (element, role) => {
    const flags = [];
    let value = null;
    const tag = element.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const type = (element.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (element.checked) flags.push("checked");
      } else if (type === "file") {
        if (element.files?.length) flags.push(`${element.files.length} file${element.files.length > 1 ? "s" : ""}`);
      } else if (!["button", "submit", "reset", "image"].includes(type) && element.value) {
        value = type === "password" ? "••••" : clean(element.value, 60);
      }
    }
    if (tag === "SELECT") value = [...element.selectedOptions].map((option) => clean(option.label, 30)).join(", ");
    if (role === "textbox" && element.isContentEditable && element.innerText.trim()) value = clean(element.innerText, 60);
    const checked = element.getAttribute("aria-checked");
    if (checked === "true" && tag !== "INPUT") flags.push("checked");
    if (checked === "mixed") flags.push("mixed");
    const expanded = element.getAttribute("aria-expanded");
    if (expanded) flags.push(expanded === "true" ? "expanded" : "collapsed");
    if (element.getAttribute("aria-selected") === "true") flags.push("selected");
    if (element.getAttribute("aria-pressed") === "true") flags.push("pressed");
    if (element.disabled || element.getAttribute("aria-disabled") === "true") flags.push("disabled");
    if (element === element.ownerDocument.activeElement && element !== element.ownerDocument.body) flags.push("focused");
    let text = flags.length ? ` [${flags.join(",")}]` : "";
    if (value !== null) text += ` ="${value.replace(/"/g, "'")}"`;
    if (role === "link") {
      const href = compactHref(element);
      if (href) text += ` →${href}`;
    }
    return text;
  };

  const isInteractive = (element, role, style) => {
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (element.hasAttribute("onclick")) return true;
    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && Number(tabIndex) >= 0) return true;
    if (style && style.cursor === "pointer" && !role) {
      const parent = element.parentElement;
      const parentCursor = parent ? parent.ownerDocument.defaultView.getComputedStyle(parent).cursor : "auto";
      if (parentCursor !== "pointer") return true;
    }
    return false;
  };

  const QUIET_ROLES = new Set(["list", "listitem", "row", "cell", "figure", "region", "table", "status", "menu", "tree", "grid", "tabpanel"]);

  const collect = ({ scope = "viewport", root } = {}) => {
    const entries = [];
    const displays = new Map();
    const displayOf = (element) => {
      let display = displays.get(element);
      if (display === undefined) {
        display = element.ownerDocument.defaultView.getComputedStyle(element).display;
        displays.set(element, display);
      }
      return display;
    };
    const blockOf = (element) => {
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE) {
        const display = displayOf(node);
        if (!display.startsWith("inline") && display !== "contents") return node;
        node = node.parentElement ?? node.getRootNode()?.host ?? null;
      }
      return node;
    };
    const viewportOnly = scope === "viewport";
    const start = root ? elementForRef(String(root).replace(/^@|^ref=/, "")) : document.body;

    const walk = (node, depth, insideNamed) => {
      if (entries.length > 20_000) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (insideNamed) return;
        const text = clean(node.textContent, 160);
        if (!text) return;
        const parent = node.parentElement;
        if (viewportOnly && parent && !inViewport(viewportRect(parent))) return;
        const previous = entries.at(-1);
        if (previous && !previous.element && previous.text === text) return;
        entries.push({ depth, text, element: null, parent, inline: true, block: parent ? blockOf(parent) : null });
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const child of node.childNodes) walk(child, depth, insideNamed);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node;
      const tag = element.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (element.getAttribute("aria-hidden") === "true") return;
      if (element.hasAttribute("data-arc-for-claude")) return;
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      const isContents = style.display === "contents";
      if (!isContents && !isVisible(element)) return;

      const role = roleOf(element);
      const interactive = isInteractive(element, role, style);
      const rect = isContents ? null : viewportRect(element);
      const visibleHere = !viewportOnly || !rect || inViewport(rect);

      if (tag === "IFRAME" || tag === "FRAME") {
        if (!visibleHere) return;
        let inner = null;
        try {
          inner = element.contentDocument?.body ?? null;
        } catch {}
        const name = nameOf(element, "iframe");
        entries.push({ depth, element, text: `iframe "${name}"${inner ? "" : " (cross-origin)"}` });
        if (inner) walk(inner, depth + 1, false);
        return;
      }

      let childDepth = depth;
      let named = insideNamed || (tag === "LABEL" && Boolean(element.control) && isVisible(element.control));
      const structural = role && STRUCTURE_ROLES.has(role);
      if ((interactive || structural) && visibleHere) {
        const name = nameOf(element, role || "generic");
        const quiet = !interactive && !name && QUIET_ROLES.has(role);
        const bareImage = role === "img" && !name && !interactive;
        if (!quiet && !bareImage) {
          let label = role || "clickable";
          if (role === "heading") label = `h${element.getAttribute("aria-level") || tag.match(/^H(\d)$/)?.[1] || ""}`;
          entries.push({
            depth,
            element,
            role,
            name,
            text: `${label}${name ? ` "${name.replace(/"/g, "'")}"` : ""}${stateOf(element, role)}`,
            inline: style.display.startsWith("inline"),
            block: element.parentElement ? blockOf(element.parentElement) : null,
          });
          childDepth = depth + 1;
          if (name && (NAME_FROM_CONTENT.has(role) || interactive)) named = true;
        }
      }
      if (LEAF_TAGS.has(element.tagName)) return;
      for (const child of childNodesOf(element)) walk(child, childDepth, named);
    };

    walk(start, 0, false);
    return entries;
  };

  const formatEntry = (entry) => " ".repeat(entry.depth) + (entry.element ? `@${refFor(entry.element)} ${entry.text}` : entry.text);

  const isInlineLeaf = (entries, index) => {
    const entry = entries[index];
    if (!entry.inline) return false;
    if (!entry.element) return true;
    if (entry.role !== "link" && entry.role !== "button") return false;
    const next = entries[index + 1];
    return !next || next.depth <= entry.depth;
  };

  const formatEntries = (entries) => {
    const lines = [];
    let index = 0;
    while (index < entries.length) {
      const first = entries[index];
      let end = index;
      while (
        end < entries.length &&
        entries[end].depth === first.depth &&
        entries[end].block === first.block &&
        isInlineLeaf(entries, end)
      ) {
        end++;
      }
      const run = entries.slice(index, end);
      if (run.length >= 2 && run.some((entry) => !entry.element)) {
        const text = run
          .map((entry) => (entry.element ? `[${entry.name || entry.role}](@${refFor(entry.element)})` : entry.text))
          .join(" ")
          .replace(/ ([,.;:!?)\]])/g, "$1")
          .replace(/([(\[]) /g, "$1");
        lines.push(" ".repeat(first.depth) + (text.length > 300 ? text.slice(0, 299) + "…" : text));
        index = end;
      } else {
        lines.push(formatEntry(first));
        index++;
      }
    }
    return lines;
  };

  const header = () =>
    `${document.title || "(untitled)"} | ${location.href} | ${window.innerWidth}x${window.innerHeight} y=${Math.round(window.scrollY)}/${document.documentElement.scrollHeight}`;

  const previousSnapshots = new Map();

  const snapshot = ({ scope = "viewport", root, maxLines = 300, diff = false } = {}) => {
    const lines = formatEntries(collect({ scope, root }));
    const key = `${scope}:${root ?? ""}`;
    const previous = previousSnapshots.get(key);
    previousSnapshots.set(key, lines);
    const head = header() + (root ? ` | subtree ${root}` : scope !== "viewport" ? ` | ${scope}` : "");
    if (diff && previous) {
      const counts = new Map();
      for (const line of previous) counts.set(line, (counts.get(line) ?? 0) + 1);
      const added = [];
      for (const line of lines) {
        const count = counts.get(line) ?? 0;
        if (count > 0) counts.set(line, count - 1);
        else added.push(line);
      }
      let removed = [...counts.entries()].flatMap(([line, count]) => Array(count).fill(line));
      if (!added.length && !removed.length) return `${head}\n(no change since last snapshot)`;
      if (added.length < lines.length * 0.6) {
        const refOf = (line) => line.trimStart().match(/^@(\d+) /)?.[1];
        const removedRefs = new Set(removed.map(refOf).filter(Boolean));
        const changedRefs = new Set(added.map(refOf).filter((ref) => ref && removedRefs.has(ref)));
        removed = removed.filter((line) => !changedRefs.has(refOf(line)));
        const body = [
          ...added.slice(0, maxLines).map((line) => (changedRefs.has(refOf(line)) ? "~ " : "+ ") + line.trimStart()),
          ...removed.slice(0, 20).map((line) => "- " + line.trimStart()),
        ];
        if (removed.length > 20) body.push(`- … ${removed.length - 20} more removed`);
        return `${head}\n(diff: ${changedRefs.size} changed, ${added.length - changedRefs.size} new, ${removed.length} gone)\n${body.join("\n")}`;
      }
    }
    const shown = lines.slice(0, maxLines);
    if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines. Use find(), scroll, or { root: "@N" }.`);
    if (!shown.length) shown.push("(nothing visible)");
    return `${head}\n${shown.join("\n")}`;
  };

  const find = (query, { limit = 15 } = {}) => {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];
    const seen = new Set();
    for (const entry of collect({ scope: "full_page" })) {
      const haystack = entry.text.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      const element = entry.element ?? entry.parent;
      if (!element || seen.has(element)) continue;
      seen.add(element);
      const off = inViewport(viewportRect(element)) ? "" : " (offscreen)";
      if (entry.element) {
        matches.push(`@${refFor(element)} ${entry.text}${off}`);
        continue;
      }
      const at = haystack.indexOf(words[0]);
      const from = Math.max(0, at - 30);
      const excerpt = (from > 0 ? "…" : "") + entry.text.slice(from, from + 90) + (from + 90 < entry.text.length ? "…" : "");
      matches.push(`@${refFor(element)} ${element.tagName.toLowerCase()}: ${excerpt}${off}`);
    }
    if (!matches.length) return `no match for "${query}"`;
    const shown = matches.slice(0, limit);
    if (matches.length > limit) shown.push(`… ${matches.length - limit} more`);
    return shown.join("\n");
  };

  const allRoots = () => {
    const roots = [];
    const visit = (root) => {
      roots.push(root);
      const walker = (root.ownerDocument ?? root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        const shadow = shadowOf(node);
        if (shadow) visit(shadow);
        if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
          try {
            if (node.contentDocument) visit(node.contentDocument);
          } catch {}
        }
        node = walker.nextNode();
      }
    };
    visit(document);
    return roots;
  };

  const deepQuery = (css) => allRoots().flatMap((root) => [...root.querySelectorAll(css)]);

  const composedParent = (node) => node.parentElement ?? node.parentNode?.host ?? null;

  const composedContains = (ancestor, node) => {
    for (let current = node; current; current = composedParent(current)) {
      if (current === ancestor) return true;
    }
    return false;
  };

  const closedHostCandidates = (limit) => {
    const found = [];
    for (const root of allRoots()) {
      for (const element of root.querySelectorAll("*")) {
        if (!element.localName.includes("-") || element.shadowRoot || closedRoots.has(element) || probedHosts.has(element)) continue;
        if (!element.getClientRects().length) continue;
        if ([...element.children].some((child) => child.getClientRects().length)) continue;
        found.push(element);
        if (found.length >= limit) return found;
      }
    }
    return found;
  };

  const takeClosedHostCandidates = () => {
    const hosts = closedHostCandidates(50);
    for (const host of hosts) probedHosts.add(host);
    return hosts.length ? hosts : null;
  };

  const registerClosedRoot = (root) => {
    if (!root?.host) return false;
    closedRoots.set(root.host, root);
    return true;
  };

  const textOf = (element) => {
    const tag = element.tagName.toUpperCase();
    if (tag === "INPUT" && ["button", "submit", "reset"].includes(element.type)) return element.value;
    return element.innerText ?? element.textContent ?? "";
  };

  const parseQuoted = (raw) => {
    const value = raw.trim();
    const match = value.match(/^(["'])([\s\S]*)\1$/);
    return match ? { text: match[2], exact: true } : { text: value, exact: false };
  };

  const textMatcher = (raw) => {
    const { text, exact } = parseQuoted(raw);
    const needle = exact ? text : clean(text, 10_000).toLowerCase();
    return (value) => {
      const hay = exact ? clean(value, 10_000) : clean(value, 10_000).toLowerCase();
      return exact ? hay === clean(needle, 10_000) : hay.includes(needle);
    };
  };

  const deepest = (elements) => {
    const hasMatchingDescendant = new Set();
    for (const element of elements) {
      let node = element.parentNode;
      while (node) {
        if (hasMatchingDescendant.has(node)) break;
        hasMatchingDescendant.add(node);
        node = node.parentNode ?? node.host ?? null;
      }
    }
    return elements.filter((element) => !hasMatchingDescendant.has(element));
  };

  const byText = (raw) => {
    const matches = textMatcher(raw);
    const candidates = deepQuery("*").filter((element) => {
      const tag = element.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag) || tag === "HTML") return false;
      return matches(textOf(element)) || matches(element.getAttribute("aria-label") ?? "");
    });
    return deepest(candidates);
  };

  const ROLE_FAMILIES = {
    textbox: ["textbox", "searchbox", "combobox"],
    searchbox: ["textbox", "searchbox", "combobox"],
    combobox: ["textbox", "searchbox", "combobox"],
  };

  const byRole = (raw) => {
    const match = raw.match(/^([a-z]+)\s*(?:\[\s*name\s*(\*?=)\s*(["'])([\s\S]*?)\3\s*\])?\s*$/i);
    if (!match) throw new Error(`Cannot parse role selector: ${raw}`);
    const [, role, operator, , name] = match;
    const family = ROLE_FAMILIES[role.toLowerCase()] ?? [role.toLowerCase()];
    return deepQuery("*").filter((element) => {
      if (!family.includes(roleOf(element))) return false;
      if (name === undefined) return true;
      const actual = nameOf(element, role.toLowerCase());
      return operator === "*=" ? actual.toLowerCase().includes(name.toLowerCase()) : actual === name;
    });
  };

  const byXPath = (expression) => {
    const result = document.evaluate(expression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const nodes = [];
    for (let index = 0; index < result.snapshotLength; index++) {
      const node = result.snapshotItem(index);
      if (node.nodeType === Node.ELEMENT_NODE) nodes.push(node);
    }
    return nodes;
  };

  const queryAll = (selector) => {
    let source = String(selector).trim();
    let nth = null;
    const nthMatch = source.match(/\s*>>\s*nth=(-?\d+)\s*$/);
    if (nthMatch) {
      nth = Number(nthMatch[1]);
      source = source.slice(0, nthMatch.index);
    }
    let elements;
    const refMatch = source.match(/^(?:@|ref=)(\d+)$/);
    if (refMatch) elements = [elementForRef(refMatch[1])];
    else if (source.startsWith("text=")) elements = byText(source.slice(5));
    else if (source.startsWith("loc=role:")) elements = byRole(source.slice(9));
    else if (source.startsWith("role=")) elements = byRole(source.slice(5));
    else if (source.startsWith("loc=href:")) {
      const needle = parseQuoted(source.slice(9)).text;
      elements = deepQuery("a[href], area[href]").filter((element) => element.getAttribute("href").includes(needle) || element.href.includes(needle));
    } else if (source.startsWith("xpath=")) elements = byXPath(source.slice(6));
    else {
      let css = source.replace(/^loc=css:|^css=/, "");
      let filter = null;
      const hasText = css.match(/:has-text\((["'])([\s\S]*?)\1\)\s*$/);
      const textIs = css.match(/:text-is\((["'])([\s\S]*?)\1\)\s*$/);
      if (hasText) {
        css = css.slice(0, hasText.index);
        const matches = textMatcher(hasText[2]);
        filter = (element) => matches(textOf(element));
      } else if (textIs) {
        css = css.slice(0, textIs.index);
        filter = (element) => clean(textOf(element), 10_000) === clean(textIs[2], 10_000);
      }
      elements = deepQuery(css || "*");
      if (filter) elements = elements.filter(filter);
    }
    if (nth !== null) {
      const picked = nth < 0 ? elements.at(nth) : elements[nth];
      elements = picked ? [picked] : [];
    }
    return elements;
  };

  const describe = (element) => {
    const role = roleOf(element);
    const name = nameOf(element, role || "generic");
    const tag = element.tagName.toLowerCase();
    return `@${refFor(element)} ${role || tag}${name ? ` "${name}"` : ""}`;
  };

  const resolve = (selector, { visibleOnly = true } = {}) => {
    const all = queryAll(selector);
    const refDirect = /^(?:@|ref=)\d+$/.test(String(selector).trim());
    const visible = refDirect ? all : all.filter(isVisible);
    const pool = visibleOnly ? visible : all;
    if (pool.length === 1) return { ref: refFor(pool[0]), description: describe(pool[0]) };
    if (pool.length === 0) {
      const hidden = all.length - visible.length;
      throw new Error(
        hidden > 0 && visibleOnly
          ? `Selector ${selector} matches ${hidden} hidden element(s) and no visible one.`
          : `Selector ${selector} matches no element.`,
      );
    }
    const list = pool.slice(0, 8).map((element) => "  " + describe(element)).join("\n");
    throw new Error(`Selector ${selector} matches ${pool.length} elements. Use a ref or a narrower selector:\n${list}`);
  };

  const count = (selector, { visibleOnly = true } = {}) => {
    const all = queryAll(selector);
    return visibleOnly ? all.filter(isVisible).length : all.length;
  };

  const actionPoint = (ref) => {
    const element = elementForRef(ref);
    let rect = viewportRect(element);
    if (!inViewport(rect) || rect.y < 0 || rect.y + rect.height > window.innerHeight) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      rect = viewportRect(element);
    }
    if (rect.width === 0 || rect.height === 0) throw new Error(`${describe(element)} has no size and cannot receive pointer input.`);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const offset = frameOffset(element);
    const root = element.getRootNode();
    const hit = (typeof root.elementFromPoint === "function" ? root : element.ownerDocument).elementFromPoint(x - offset.x, y - offset.y);
    const reachable =
      hit && (hit === element || element.contains(hit) || hit.contains(element) || (hit.shadowRoot && hit.contains(element)) || composedContains(hit, element));
    let covered = null;
    if (!reachable) {
      const labelFor = hit?.closest?.("label");
      if (!(labelFor && labelFor.control === element)) covered = hit ? describe(hit) : "nothing (outside viewport)";
    }
    return { x, y, covered, description: describe(element) };
  };

  const prepareFill = (ref) => {
    const element = elementForRef(ref);
    const tag = element.tagName.toUpperCase();
    if (tag === "SELECT") throw new Error(`${describe(element)} is a select. Use selectOption().`);
    if (tag === "INPUT" && ["checkbox", "radio", "file", "button", "submit", "reset", "image", "range", "color"].includes(element.type)) {
      throw new Error(`${describe(element)} is an input of type ${element.type} and cannot be filled with text.`);
    }
    const rect = viewportRect(element);
    if (!inViewport(rect) || rect.y < 0 || rect.y + rect.height > window.innerHeight) element.scrollIntoView({ block: "center", behavior: "instant" });
    element.focus();
    const box = viewportRect(element);
    const point = { x: Math.round(box.x + Math.min(box.width / 2, 40)), y: Math.round(box.y + box.height / 2) };
    if (tag === "INPUT" || tag === "TEXTAREA") {
      element.select();
      return { kind: "input", ref: refFor(element), ...point };
    }
    if (element.isContentEditable) {
      const selection = element.ownerDocument.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      return { kind: "contenteditable", ref: refFor(element), ...point };
    }
    const editable = element.querySelectorAll("input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true]");
    if (editable.length === 1) return prepareFill(refFor(editable[0]));
    throw new Error(`${describe(element)} is not editable.`);
  };

  const fileInput = (ref) => {
    const element = elementForRef(ref);
    if (element.tagName === "INPUT" && element.type === "file") return ref;
    const inputs = element.querySelectorAll("input[type=file]");
    if (inputs.length !== 1) throw new Error(`${describe(element)} is not a file input and contains ${inputs.length} file inputs.`);
    return refFor(inputs[0]);
  };

  const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

  const checkedState = (ref) => {
    const element = elementForRef(ref);
    const isCheckable = (node) => CHECKABLE_ROLES.has(roleOf(node) ?? "");
    let control = isCheckable(element) ? element : null;
    if (!control && element.tagName === "LABEL" && element.control && isCheckable(element.control)) control = element.control;
    if (!control) {
      const inner = [...element.querySelectorAll("input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch]")];
      if (inner.length === 1) control = inner[0];
    }
    if (!control) {
      const label = element.closest("label");
      if (label?.control && isCheckable(label.control)) control = label.control;
    }
    if (!control) throw new Error(`${describe(element)} is not a checkbox, radio, or switch.`);
    const checked = control.tagName === "INPUT" ? control.checked : control.getAttribute("aria-checked") === "true";
    return { checked, control: describe(control) };
  };

  const valueOf = (ref) => {
    const element = elementForRef(ref);
    if (element.isContentEditable) return element.innerText;
    return element.value ?? null;
  };

  const forceValue = (ref, value) => {
    const element = elementForRef(ref);
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const selectOption = (ref, wanted) => {
    const element = elementForRef(ref);
    if (element.tagName !== "SELECT") throw new Error(`${describe(element)} is not a select element.`);
    const list = wanted === null ? [] : Array.isArray(wanted) ? wanted : [wanted];
    const options = [...element.options];
    const picked = list.map((item) => {
      const found = options.find((option, index) => {
        if (typeof item === "number") return index === item;
        if (typeof item === "string") return option.value === item || clean(option.label) === clean(item);
        if (item.value !== undefined) return option.value === item.value;
        if (item.label !== undefined) return clean(option.label) === clean(item.label);
        if (item.index !== undefined) return index === item.index;
        return false;
      });
      if (!found) throw new Error(`No option matches ${JSON.stringify(item)} in ${describe(element)}.`);
      return found;
    });
    if (!element.multiple && picked.length > 1) throw new Error(`${describe(element)} allows one option only.`);
    element.focus();
    for (const option of options) option.selected = picked.includes(option);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return picked.map((option) => option.value);
  };

  const focus = (ref) => {
    const element = elementForRef(ref);
    element.focus();
    if (element.ownerDocument.activeElement !== element) {
      const inner = element.querySelector("input, textarea, select, button, [contenteditable], [tabindex], a[href]");
      inner?.focus();
    }
    return describe(element.ownerDocument.activeElement);
  };

  const text = ({ maxChars = 8_000, all = false } = {}) => {
    const root = all ? document.body : document.querySelector("main, [role=main]") ?? document.querySelector("article") ?? document.body;
    const value = (root?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return value.length > maxChars ? value.slice(0, maxChars) + `\n… truncated (${value.length} chars total)` : value;
  };

  let cursor = null;
  const showCursor = (x, y, label) => {
    if (!document.body) return;
    if (!cursor || !cursor.isConnected) {
      cursor = document.createElement("div");
      cursor.setAttribute("data-arc-for-claude", "");
      const shadow = cursor.attachShadow({ mode: "closed" });
      shadow.innerHTML = `<style>
        :host{all:initial;position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .18s ease,opacity .4s ease;opacity:0}
        .dot{width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#FF5C35;box-shadow:0 0 0 3px rgba(255,92,53,.25)}
        .tag{position:absolute;left:12px;top:6px;white-space:nowrap;font:500 11px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:#1F1F1F;padding:3px 7px;border-radius:5px}
      </style><div class="dot"></div><div class="tag"></div>`;
      cursor._tag = shadow.querySelector(".tag");
      document.documentElement.appendChild(cursor);
    }
    cursor.style.transition = "";
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.style.opacity = "1";
    cursor._tag.textContent = label || "Claude";
    clearTimeout(cursor._timer);
    cursor._timer = setTimeout(() => {
      if (cursor) cursor.style.opacity = "0";
    }, 2500);
  };

  const hideCursor = () => {
    if (!cursor) return;
    clearTimeout(cursor._timer);
    cursor.style.transition = "none";
    cursor.style.opacity = "0";
  };

  const isCrossFrame = (element) => {
    if (element.tagName !== "IFRAME" && element.tagName !== "FRAME") return false;
    try {
      return !element.contentDocument;
    } catch {
      return true;
    }
  };

  const frameBox = (ref) => {
    const element = elementForRef(ref);
    if (element.tagName !== "IFRAME" && element.tagName !== "FRAME") throw new Error(`${describe(element)} is not a frame.`);
    let rect = viewportRect(element);
    if (!inViewport(rect)) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      rect = viewportRect(element);
    }
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      x: rect.x + element.clientLeft + parseFloat(style.paddingLeft),
      y: rect.y + element.clientTop + parseFloat(style.paddingTop),
      cross: isCrossFrame(element),
    };
  };

  let mutations = 0;
  let observer = null;
  const mutationCount = () => {
    if (!observer) {
      observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    return mutations;
  };

  const rectOf = (ref) => {
    const element = elementForRef(ref);
    let rect = viewportRect(element);
    if (!inViewport(rect) || rect.y < 0 || rect.y + rect.height > window.innerHeight) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      rect = viewportRect(element);
    }
    return rect;
  };

  const crossFrames = ({ visibleOnly = false } = {}) =>
    deepQuery("iframe, frame")
      .filter((element) => isCrossFrame(element) && isVisible(element) && (!visibleOnly || inViewport(viewportRect(element))))
      .map((element) => ({ ref: refFor(element), name: nameOf(element, "iframe") }));

  const refIsCrossFrame = (ref) => isCrossFrame(elementForRef(ref));

  const SELECTOR_PREFIX = /^(?:@|ref=|text=|role=|css=|xpath=|loc=)/;

  const seekSelector = (raw) => {
    const value = String(raw).trim();
    if (SELECTOR_PREFIX.test(value)) return value;
    if (/[#.[\]:>*=]/.test(value)) {
      try {
        document.querySelector(value.replace(/:has-text\([\s\S]*\)$|:text-is\([\s\S]*\)$/, "") || "*");
        return value;
      } catch {}
    }
    return `text=${value}`;
  };

  const blocksScroll = (style) => style.overflowY === "hidden" || style.overflowY === "clip";

  const scrollsY = (element) => {
    if (element.scrollHeight <= element.clientHeight + 4) return false;
    const overflow = element.ownerDocument.defaultView.getComputedStyle(element).overflowY;
    return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
  };

  const pageScroller = () => document.scrollingElement ?? document.documentElement;

  const pageScrolls = () => {
    if (pageScroller().scrollHeight <= window.innerHeight + 4) return false;
    const html = getComputedStyle(document.documentElement);
    if (blocksScroll(html)) return false;
    return !(document.body && html.overflowY === "visible" && blocksScroll(getComputedStyle(document.body)));
  };

  const isPageElement = (element) => element === document.documentElement || element === document.body || element === pageScroller();

  const scrollParentOf = (element) => {
    for (let node = composedParent(element); node && !isPageElement(node); node = composedParent(node)) {
      if (scrollsY(node)) return node;
    }
    return null;
  };

  const scrollOwnerOf = (element) => (isPageElement(element) ? null : scrollsY(element) ? element : scrollParentOf(element));

  const ITEM_SELECTOR =
    "li, tr, article, [role=listitem], [role=row], [role=option], [role=article], [role=treeitem], [role=gridcell], [role=feed] > *";

  const visibleArea = (rect) =>
    Math.max(0, Math.min(rect.x + rect.width, window.innerWidth) - Math.max(rect.x, 0)) *
    Math.max(0, Math.min(rect.y + rect.height, window.innerHeight) - Math.max(rect.y, 0));

  const pickScroller = () => {
    const scores = new Map();
    const pageOk = pageScrolls();
    let counted = 0;
    for (const item of deepQuery(ITEM_SELECTOR)) {
      if (item.ownerDocument !== document) continue;
      const area = visibleArea(item.getBoundingClientRect());
      if (!area) continue;
      const owner = scrollParentOf(item) ?? (pageOk ? "page" : null);
      if (owner) scores.set(owner, (scores.get(owner) ?? 0) + area);
      if (++counted >= 400) break;
    }
    if (scores.size) return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (pageOk) return "page";
    let best = null;
    let bestArea = 0;
    for (const element of deepQuery("*")) {
      if (element.ownerDocument !== document || element.scrollHeight <= element.clientHeight + 4 || !scrollsY(element)) continue;
      const area = visibleArea(element.getBoundingClientRect());
      if (area > bestArea) {
        best = element;
        bestArea = area;
      }
    }
    if (!best) throw new Error("Found no scrollable list or page to seek in. Pass a container selector.");
    return best;
  };

  const scrollerFor = (container) => {
    if (!container) return pickScroller();
    const { ref } = resolve(container);
    const element = elementForRef(ref);
    if (isPageElement(element)) return "page";
    return scrollOwnerOf(element) ?? "page";
  };

  const deepHit = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit) {
      const shadow = shadowOf(hit);
      const inner = shadow?.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  const wheelPoint = (scroller) => {
    const bounds = scroller === "page" ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } : scroller.getBoundingClientRect();
    const left = Math.max(bounds.x, 0);
    const top = Math.max(bounds.y, 0);
    const width = Math.min(bounds.x + bounds.width, window.innerWidth) - left;
    const height = Math.min(bounds.y + bounds.height, window.innerHeight) - top;
    const fractions = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5], [0.25, 0.25], [0.75, 0.75]];
    const points = fractions.map(([fx, fy]) => ({ x: Math.round(left + width * fx), y: Math.round(top + height * fy) }));
    const wanted = scroller === "page" ? null : scroller;
    return points.find((point) => {
      const hit = deepHit(point.x, point.y);
      return hit && scrollOwnerOf(hit) === wanted;
    }) ?? points[0];
  };

  const seekLine = (element) => {
    const role = roleOf(element);
    const ref = refFor(element);
    const off = inViewport(viewportRect(element)) ? "" : " (offscreen)";
    if (!role) return `@${ref} ${element.tagName.toLowerCase()}: ${clean(textOf(element), 90)}${off}`;
    const name = nameOf(element, role);
    return `@${ref} ${role}${name ? ` "${name.replace(/"/g, "'")}"` : ""}${stateOf(element, role)}${off}`;
  };

  const seekProbe = (raw, { container = null, scroller: scrollerRef = null, advance = 0 } = {}) => {
    const scroller = scrollerRef === null ? scrollerFor(container) : scrollerRef === 0 ? "page" : elementForRef(scrollerRef);
    const within = container && scroller !== "page" ? scroller : null;
    const matches = queryAll(seekSelector(raw)).filter((element) => isVisible(element) && (!within || composedContains(within, element)));
    const box = scroller === "page" ? pageScroller() : scroller;
    const client = scroller === "page" ? window.innerHeight : box.clientHeight;
    const top = Math.round(box.scrollTop);
    const max = Math.max(0, Math.round(box.scrollHeight - client));
    const step = Math.max(40, Math.round(client * 0.9));
    const found = matches.length ? seekLine(matches[0]) + (matches.length > 1 ? ` (+${matches.length - 1} more)` : "") : null;
    let after = top;
    if (advance && !found) {
      box.scrollTo({ top: Math.min(max, Math.max(0, top + advance * step)), behavior: "instant" });
      after = Math.round(box.scrollTop);
    }
    return {
      found,
      scroller: scroller === "page" ? 0 : refFor(scroller),
      name: scroller === "page" ? "the page" : describe(scroller),
      top,
      after,
      max,
      height: Math.round(box.scrollHeight),
      step,
      ...wheelPoint(scroller),
    };
  };

  const api = {
    snapshot, find, resolve, count, actionPoint, prepareFill, fileInput, checkedState, valueOf, forceValue, selectOption, focus,
    text, element: elementForRef, describe, showCursor, hideCursor, frameBox, rectOf, crossFrames, refIsCrossFrame, mutationCount,
    seekProbe, takeClosedHostCandidates, registerClosedRoot,
  };

  api.guarded = (method, args, check) => (check && closedHostCandidates(1).length ? { __arcClosedHosts: true } : api[method](...args));

  return api;
}

const SOURCE = inPageLibrary.toString();

export const LIBRARY_KEY = `__arcForClaude_${createHash("sha1").update(SOURCE).digest("hex").slice(0, 10)}`;

export const LIBRARY_PRELUDE = `(globalThis[${JSON.stringify(LIBRARY_KEY)}] ||= (${SOURCE})())`;
