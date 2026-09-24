const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const NAMED_KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Escape: { code: "Escape", keyCode: 27 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Insert: { code: "Insert", keyCode: 45 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Meta: { code: "MetaLeft", keyCode: 91 },
  CapsLock: { code: "CapsLock", keyCode: 20 },
};

for (let index = 1; index <= 12; index++) {
  NAMED_KEYS[`F${index}`] = { code: `F${index}`, keyCode: 111 + index };
}

const PUNCTUATION = {
  "-": ["Minus", 189, "_"],
  "=": ["Equal", 187, "+"],
  "[": ["BracketLeft", 219, "{"],
  "]": ["BracketRight", 221, "}"],
  "\\": ["Backslash", 220, "|"],
  ";": ["Semicolon", 186, ":"],
  "'": ["Quote", 222, '"'],
  ",": ["Comma", 188, "<"],
  ".": ["Period", 190, ">"],
  "/": ["Slash", 191, "?"],
  "`": ["Backquote", 192, "~"],
};

const DIGIT_SHIFTED = ")!@#$%^&*(";

const MAC_COMMANDS = {
  "Meta+a": "selectAll",
  "Meta+c": "copy",
  "Meta+x": "cut",
  "Meta+v": "paste",
  "Meta+z": "undo",
  "Meta+Shift+z": "redo",
  "Meta+Backspace": "deleteToBeginningOfLine",
  "Alt+Backspace": "deleteWordBackward",
  "Meta+ArrowLeft": "moveToBeginningOfLine",
  "Meta+ArrowRight": "moveToEndOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Alt+ArrowLeft": "moveWordLeft",
  "Alt+ArrowRight": "moveWordRight",
  "Meta+Shift+ArrowLeft": "moveToBeginningOfLineAndModifySelection",
  "Meta+Shift+ArrowRight": "moveToEndOfLineAndModifySelection",
  "Shift+ArrowLeft": "moveLeftAndModifySelection",
  "Shift+ArrowRight": "moveRightAndModifySelection",
};

export function describeKey(key) {
  if (NAMED_KEYS[key]) {
    const entry = NAMED_KEYS[key];
    return { key: entry.key ?? key, code: entry.code, keyCode: entry.keyCode, text: entry.text };
  }
  if (key.length !== 1) throw new Error(`Unknown key: ${key}`);
  if (/[a-z]/.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
  if (/[A-Z]/.test(key)) return { key, code: `Key${key}`, keyCode: key.charCodeAt(0), text: key, shift: true };
  if (/[0-9]/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  const shiftedDigit = DIGIT_SHIFTED.indexOf(key);
  if (shiftedDigit >= 0) return { key, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: key, shift: true };
  if (PUNCTUATION[key]) {
    const [code, keyCode] = PUNCTUATION[key];
    return { key, code, keyCode, text: key };
  }
  for (const [code, keyCode, shifted] of Object.values(PUNCTUATION)) {
    if (shifted === key) return { key, code, keyCode, text: key, shift: true };
  }
  if (key === " ") return { key, code: "Space", keyCode: 32, text: key };
  return { key, code: "", keyCode: 0, text: key };
}

export function parseChord(chord) {
  const parts = chord === "+" ? ["+"] : chord.split(/\+(?!$)/);
  const key = parts.pop();
  const modifiers = parts.map((part) => (part === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : part));
  for (const modifier of modifiers) {
    if (!(modifier in MODIFIER_BITS)) throw new Error(`Unknown modifier: ${modifier}`);
  }
  return { modifiers, key };
}

export function modifierMask(modifiers) {
  return modifiers.reduce((mask, modifier) => mask | MODIFIER_BITS[modifier], 0);
}

export function macCommand(modifiers, key) {
  if (process.platform !== "darwin") return null;
  const order = ["Meta", "Alt", "Control", "Shift"];
  const sorted = order.filter((modifier) => modifiers.includes(modifier));
  const normalized = [...sorted, key.length === 1 ? key.toLowerCase() : key].join("+");
  return MAC_COMMANDS[normalized] ?? null;
}
