import { createHash } from "node:crypto";

export function editorLibrary() {
  const KINDS = [
    { kind: "monaco", selector: ".monaco-editor" },
    { kind: "codemirror6", selector: ".cm-editor, .cm-content" },
    { kind: "codemirror5", selector: ".CodeMirror" },
    { kind: "ace", selector: ".ace_editor" },
    { kind: "ckeditor5", selector: ".ck-editor__editable, .ck-editor" },
    { kind: "lexical", selector: "[data-lexical-editor]" },
    { kind: "quill", selector: ".ql-container, .ql-editor" },
    { kind: "prosemirror", selector: ".ProseMirror" },
    { kind: "tinymce", selector: ".tox-tinymce, .mce-tinymce, .mce-content-body" },
    { kind: "draft", selector: ".DraftEditor-root, [data-contents=\"true\"]" },
    { kind: "slate", selector: "[data-slate-editor]" },
  ];

  const CODE_KINDS = new Set(["monaco", "codemirror6", "codemirror5", "ace"]);

  const EDITOR_INPUTS = "textarea.inputarea, textarea.ime-text-area, textarea.ace_text-input, .CodeMirror > div > textarea";

  const matchKind = (node) => KINDS.find((entry) => node.matches(entry.selector)) ?? null;

  const isForeignInput = (element) =>
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(element.tagName) && !element.matches(EDITOR_INPUTS);

  const locate = (element) => {
    if (!element || isForeignInput(element)) return null;
    for (let node = element; node; node = node.parentElement) {
      const entry = matchKind(node);
      if (entry) return { kind: entry.kind, root: node };
    }
    if (element.tagName === "IFRAME") {
      try {
        const body = element.contentDocument?.body;
        if (body?.matches(".mce-content-body")) return { kind: "tinymce", root: body };
      } catch {}
    }
    const found = KINDS.map((entry) => ({ kind: entry.kind, root: element.querySelector?.(entry.selector) }))
      .filter((entry) => entry.root)
      .sort((a, b) => (a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return found[0] ?? null;
  };

  const windowOf = (node) => node.ownerDocument.defaultView;

  const related = (a, b) => Boolean(a && b && (a === b || a.contains(b) || b.contains(a)));

  const normalize = (text) => String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");

  const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const textToHtml = (text, emptyBlock) =>
    normalize(text)
      .split("\n")
      .map((line) => {
        if (!line) return `<p>${emptyBlock}</p>`;
        const kept = line.replace(/^ +| +$| {2,}/g, (run) => "\u00a0".repeat(run.length));
        return `<p>${escapeHtml(kept).replace(/\u00a0/g, "&nbsp;")}</p>`;
      })
      .join("");

  const inlineText = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.getAttribute("data-mce-bogus")) return "";
    if (node.tagName === "BR") return node.nextSibling ? "\n" : "";
    return [...node.childNodes].map(inlineText).join("");
  };

  const blockText = (container) => {
    const blocks = [...container.children].filter((child) => !child.getAttribute("data-mce-bogus"));
    if (!blocks.length) return normalize(container.textContent);
    return normalize(blocks.map(inlineText).join("\n"));
  };

  const monacoApi = (win) => {
    if (win.monaco?.editor?.getEditors) return win.monaco;
    try {
      const loaded = win.require?.("vs/editor/editor.main");
      if (loaded?.editor?.getEditors) return loaded;
    } catch {}
    return null;
  };

  const monacoEditor = (root) => {
    const api = monacoApi(windowOf(root));
    if (!api) return null;
    const editors = api.editor.getEditors();
    return editors.find((editor) => editor.getDomNode()?.contains(root)) ?? editors.find((editor) => related(editor.getDomNode(), root)) ?? null;
  };

  const codeMirror6View = (root) => {
    const content = root.matches(".cm-content") ? root : root.querySelector(".cm-content");
    if (!content) return null;
    const holder = content.cmView ?? content.cmTile;
    const view = holder?.view ?? holder?.rootView?.view ?? holder?.root?.view ?? null;
    return view?.state && view.dispatch ? view : null;
  };

  const codeMirror5 = (root) => root.CodeMirror ?? null;

  const aceEditor = (root) => {
    if (root.env?.editor) return root.env.editor;
    try {
      return windowOf(root).ace?.edit(root) ?? null;
    } catch {
      return null;
    }
  };

  const quillEditor = (root) => {
    const container = root.closest(".ql-container") ?? root.querySelector(".ql-container") ?? root;
    if (container.__quill) return container.__quill;
    try {
      return windowOf(root).Quill?.find(container) || null;
    } catch {
      return null;
    }
  };

  const proseMirrorView = (root) => {
    const dom = root.matches(".ProseMirror") ? root : root.querySelector(".ProseMirror");
    if (!dom) return null;
    const candidates = [dom.editor?.view, dom.pmViewDesc?.view, windowOf(dom).view, windowOf(dom).editor?.view];
    return candidates.find((view) => view?.state && view.dispatch && view.dom === dom) ?? null;
  };

  const lexicalEditor = (root) => {
    const dom = root.matches("[data-lexical-editor]") ? root : root.querySelector("[data-lexical-editor]");
    return dom?.__lexicalEditor ?? null;
  };

  const ckEditor = (root) => {
    for (let node = root; node; node = node.parentElement?.closest(".ck-editor__editable")) {
      if (node.ckeditorInstance) return node.ckeditorInstance;
    }
    return [...root.querySelectorAll(".ck-editor__editable")].find((node) => node.ckeditorInstance)?.ckeditorInstance ?? null;
  };

  const tinyEditor = (root) => {
    const windows = [windowOf(root)];
    try {
      if (windowOf(root).parent !== windowOf(root)) windows.push(windowOf(root).parent);
    } catch {}
    for (const win of windows) {
      let editors = [];
      try {
        const all = win.tinymce?.get?.();
        editors = Array.isArray(all) ? all : Object.values(win.tinymce?.editors ?? {});
      } catch {}
      const match = editors.find(
        (editor) =>
          editor?.getBody &&
          (editor.getBody() === root || related(editor.getContainer?.(), root) || related(editor.getElement?.(), root)),
      );
      if (match) return match;
    }
    return null;
  };

  const lexicalText = (node) => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "linebreak") return "\n";
    if (node.type === "tab") return "\t";
    return (node.children ?? []).map(lexicalText).join("");
  };

  const lexicalState = (text) => ({
    root: {
      type: "root",
      version: 1,
      direction: null,
      format: "",
      indent: 0,
      children: normalize(text)
        .split("\n")
        .map((line) => ({
          type: "paragraph",
          version: 1,
          direction: null,
          format: "",
          indent: 0,
          textFormat: 0,
          textStyle: "",
          children: line ? [{ type: "text", version: 1, text: line, detail: 0, format: 0, mode: "normal", style: "" }] : [],
        })),
    },
  });

  const ckText = (node) => {
    if (typeof node.data === "string") return node.data;
    if (node.name === "softBreak") return "\n";
    return node.getChildren ? [...node.getChildren()].map(ckText).join("") : "";
  };

  const proseMirrorText = (view) => {
    const doc = view.state.doc;
    return doc.textBetween(0, doc.content.size, "\n", "\n");
  };

  const HANDLERS = {
    monaco: {
      find: monacoEditor,
      focus: (editor) => editor.focus(),
      get: (editor) => editor.getValue(),
      set: (editor, text) => {
        const model = editor.getModel();
        editor.pushUndoStop();
        const applied = editor.executeEdits("claude4arc", [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
        if (!applied) model.setValue(text);
        editor.pushUndoStop();
      },
    },
    codemirror6: {
      find: codeMirror6View,
      focus: (view) => view.focus(),
      get: (view) => view.state.doc.toString(),
      set: (view, text) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          userEvent: "input.paste",
        });
      },
    },
    codemirror5: {
      find: codeMirror5,
      focus: (editor) => editor.focus(),
      get: (editor) => editor.getValue(),
      set: (editor, text) => {
        editor.setValue(text);
        editor.setCursor(editor.lineCount(), 0);
      },
    },
    ace: {
      find: aceEditor,
      focus: (editor) => editor.focus(),
      get: (editor) => editor.getValue(),
      set: (editor, text) => editor.setValue(text, 1),
    },
    quill: {
      find: quillEditor,
      focus: (editor) => editor.focus(),
      get: (editor) => editor.getText().replace(/\n$/, ""),
      set: (editor, text) => editor.setText(normalize(text), "user"),
    },
    prosemirror: {
      find: proseMirrorView,
      focus: (view) => view.focus(),
      get: proseMirrorText,
      set: (view, text) => {
        const { state } = view;
        const schema = state.schema;
        const type = schema.nodes.paragraph ?? schema.topNodeType.contentMatch.defaultType;
        const blocks = normalize(text)
          .split("\n")
          .map((line) => type.create(null, line ? schema.text(line) : null));
        view.dispatch(state.tr.replaceWith(0, state.doc.content.size, blocks).scrollIntoView());
      },
    },
    lexical: {
      find: lexicalEditor,
      focus: (editor) => editor.getRootElement()?.focus(),
      get: (editor) => normalize((editor.getEditorState().toJSON().root.children ?? []).map(lexicalText).join("\n")),
      set: (editor, text) => {
        editor.setEditorState(editor.parseEditorState(JSON.stringify(lexicalState(text))));
      },
    },
    ckeditor5: {
      find: ckEditor,
      focus: (editor) => editor.editing.view.focus(),
      get: (editor) => normalize([...editor.model.document.getRoot().getChildren()].map(ckText).join("\n")),
      set: (editor, text) => editor.setData(textToHtml(text, "")),
    },
    tinymce: {
      find: tinyEditor,
      focus: (editor) => editor.focus(),
      get: (editor) => blockText(editor.getBody()),
      set: (editor, text) => {
        const html = textToHtml(text, "<br>");
        if (editor.undoManager?.transact) editor.undoManager.transact(() => editor.setContent(html));
        else editor.setContent(html);
        editor.save?.();
      },
    },
  };

  const instanceFor = (element) => {
    const located = locate(element);
    if (!located) return { kind: null, instance: null };
    const handler = HANDLERS[located.kind];
    let instance = null;
    try {
      instance = handler?.find(located.root) ?? null;
    } catch {}
    return { kind: located.kind, root: located.root, handler, instance };
  };

  const detect = (element) => locate(element)?.kind ?? null;

  const editableOf = (root) => {
    if (root.isContentEditable) return root;
    return root.querySelector(`${EDITOR_INPUTS}, [contenteditable=true], [contenteditable=""]`);
  };

  const prepare = (element) => {
    const { kind, root, handler, instance } = instanceFor(element);
    if (!kind) return null;
    const view = windowOf(root);
    let box = root.getBoundingClientRect();
    if (box.bottom < 0 || box.top > view.innerHeight || box.right < 0 || box.left > view.innerWidth) {
      root.scrollIntoView({ block: "center", behavior: "instant" });
      box = root.getBoundingClientRect();
    }
    try {
      if (instance) handler.focus(instance);
      else editableOf(root)?.focus();
    } catch {}
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, view.innerHeight);
    return {
      kind,
      api: Boolean(instance),
      root,
      x: Math.round(box.left + Math.min(box.width / 2, 40)),
      y: Math.round(top + Math.min((bottom - top) / 2, 20)),
    };
  };

  const codeEditors = () => {
    const results = [];
    for (const node of document.querySelectorAll(".monaco-editor, .cm-editor, .CodeMirror, .ace_editor")) {
      if (!node.getClientRects().length) continue;
      const { kind, handler, instance } = instanceFor(node);
      if (!CODE_KINDS.has(kind) || !instance) continue;
      try {
        results.push({ kind, value: normalize(handler.get(instance)) });
      } catch {}
    }
    return results;
  };

  const getValue = (element) => {
    const { kind, root, handler, instance } = instanceFor(element);
    if (!kind) return null;
    if (instance) return normalize(handler.get(instance));
    if (kind === "monaco") return normalize(root.querySelector(".view-lines")?.innerText ?? "").replace(/\n$/, "");
    const editable = root.isContentEditable ? root : root.querySelector("[contenteditable=true]") ?? root;
    return blockText(editable);
  };

  const setValue = (element, text) => {
    const value = String(text ?? "");
    const { kind, handler, instance } = instanceFor(element);
    if (!kind || !instance) return { kind, ok: false };
    try {
      handler.set(instance, value);
    } catch (error) {
      return { kind, ok: false, error: String(error?.message ?? error) };
    }
    const result = normalize(handler.get(instance));
    return { kind, ok: result === normalize(value), value: result };
  };

  return { detect, prepare, setValue, getValue, codeEditors };
}

const SOURCE = editorLibrary.toString();

export const EDITOR_KEY = `__arcForClaudeEditors_${createHash("sha1").update(SOURCE).digest("hex").slice(0, 10)}`;

export const EDITOR_PRELUDE = `(globalThis[${JSON.stringify(EDITOR_KEY)}] ||= (${SOURCE})())`;
