import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Page, normalizeUrl } from "./page.js";
import { TASKS_PATH } from "./paths.js";

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(TASKS_PATH, "utf8"));
  } catch {
    return { nextId: 1, tasks: {} };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(TASKS_PATH), { recursive: true, mode: 0o700 });
  const temp = `${TASKS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, TASKS_PATH);
}

async function saveRecord(id, record) {
  const state = await loadState();
  if (record) state.tasks[String(id)] = record;
  else delete state.tasks[String(id)];
  state.nextId = Math.max(state.nextId, Number(id) + 1);
  await writeState(state);
}

async function allocateId() {
  const directory = path.join(path.dirname(TASKS_PATH), "task-ids");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const state = await loadState();
  const used = new Set(await fs.readdir(directory));
  let id = state.nextId;
  while (true) {
    if (!used.has(String(id))) {
      try {
        await fs.writeFile(path.join(directory, String(id)), "", { flag: "wx" });
        return id;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    id++;
  }
}

const OWNER_SOURCE = process.env.CLAUDE_JOB_DIR ?? process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null;
const OWNER = OWNER_SOURCE ? createHash("sha1").update(OWNER_SOURCE).digest("hex").slice(0, 12) : null;

function summarizeTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    pinned: tab.pinned,
  };
}

export class Task {
  static async open(bridge, nameOrId, { active = false, url } = {}) {
    const state = await loadState();
    if (typeof nameOrId === "number" || /^\d+$/.test(String(nameOrId))) {
      const record = state.tasks[String(nameOrId)];
      if (!record) throw new Error(`Task ${nameOrId} does not exist. Use the id printed by \`arc-browser new\`, or run \`arc-browser status\`.`);
      if (record.owner && OWNER && record.owner !== OWNER && !process.env.ARC_BROWSER_ANY_TASK) {
        throw new Error(`Task ${nameOrId} belongs to another Claude session. Use the id printed by your own \`arc-browser new\`.`);
      }
      const task = new Task(bridge, state, record);
      await task.#prune();
      return task;
    }
    const record = {
      id: await allocateId(),
      name: String(nameOrId ?? "task"),
      createdAt: new Date().toISOString(),
      owner: OWNER,
      nextLabel: 1,
      pages: {},
    };
    state.tasks[String(record.id)] = record;
    const task = new Task(bridge, state, record);
    await task.newPage({ active, url });
    return task;
  }

  #state;
  #record;
  #pages = new Map();
  #popupWatchers = new Set();
  #finished = false;
  #saving = Promise.resolve();

  constructor(bridge, state, record) {
    this.bridge = bridge;
    this.#state = state;
    this.#record = record;
    bridge.on((message) => this.#dispatch(message));
  }

  get spaceId() {
    return this.#record.id;
  }

  get name() {
    return this.#record.name;
  }

  #dispatch(message) {
    if (message.type === "tabCreated") {
      for (const watcher of this.#popupWatchers) watcher(message.tab);
      return;
    }
    if (message.type === "tabRemoved") {
      const label = this.#labelForTab(message.tabId);
      if (label) this._forget(label);
      return;
    }
    const page = this.#pageForTab(message.tabId);
    page?._onEvent(message);
  }

  #labelForTab(tabId) {
    return Object.entries(this.#record.pages).find(([, entry]) => entry.tabId === tabId)?.[0];
  }

  #pageForTab(tabId) {
    const label = this.#labelForTab(tabId);
    return label ? this.page(label) : null;
  }

  #save() {
    this.#saving = this.#saving
      .catch(() => {})
      .then(() => {
        if (this.#finished) return;
        return saveRecord(this.#record.id, this.#record);
      });
    return this.#saving;
  }

  async #prune() {
    const tabs = await this.bridge.call("tabs.query", {});
    const alive = new Set(tabs.map((tab) => tab.id));
    let changed = false;
    for (const [label, entry] of Object.entries(this.#record.pages)) {
      if (!alive.has(entry.tabId)) {
        delete this.#record.pages[label];
        changed = true;
      }
    }
    if (changed) await this.#save();
  }

  async #register(tab, openedBy, as) {
    const label = as ?? `p${this.#record.nextLabel++}`;
    if (this.#record.pages[label]) throw new Error(`Label ${label} is already in use.`);
    this.#record.pages[label] = { tabId: tab.id, openedBy };
    this.#record.current = label;
    await this.#save();
    return this.page(label);
  }

  get current() {
    return this.#record.pages[this.#record.current] ? this.#record.current : Object.keys(this.#record.pages).at(-1) ?? null;
  }

  async use(label) {
    this.page(label);
    if (this.#record.current !== label) {
      this.#record.current = label;
      await this.#save();
    }
    return this.page(label);
  }

  page(label = this.current) {
    const entry = this.#record.pages[label];
    if (!entry) {
      const known = Object.keys(this.#record.pages).join(", ") || "none";
      throw new Error(`Task ${this.spaceId} has no page ${label}. Known pages: ${known}.`);
    }
    let page = this.#pages.get(label);
    if (!page || page.tabId !== entry.tabId) {
      page = new Page(this, label, entry.tabId, entry.openedBy);
      this.#pages.set(label, page);
    }
    return page;
  }

  async pages() {
    await this.#prune();
    return Object.keys(this.#record.pages).map((label) => this.page(label));
  }

  async tabs() {
    const tabs = await this.bridge.call("tabs.query", {});
    return tabs.map((tab) => {
      const label = this.#labelForTab(tab.id);
      return {
        label: label ?? null,
        openedBy: label ? this.#record.pages[label].openedBy : "unknown",
        ...summarizeTab(tab),
      };
    });
  }

  async userTab() {
    const [tab] = await this.bridge.call("tabs.query", { active: true, lastFocusedWindow: true });
    if (!tab) return null;
    const label = this.#labelForTab(tab.id);
    return { label: label ?? null, ...summarizeTab(tab) };
  }

  async newPage({ url, active = false, timeout = 30_000 } = {}) {
    const tab = await this.bridge.call("tabs.create", { url: url ? normalizeUrl(url) : "about:blank", active });
    this.bridge.call("guard.enable", tab.id).catch(() => {});
    const page = await this.#register(tab, "agent");
    if (url && url !== "about:blank") {
      await page._waitForTabLoad(timeout);
      await page.settle({ quiet: 100, max: 1_000 }).catch(() => {});
    }
    return page;
  }

  async adopt(target, { as } = {}) {
    const tabId = typeof target === "number" ? target : target?.tabId ?? target?.id;
    if (typeof tabId !== "number") throw new Error("adopt() needs a tab id or a tab object from tabs() or userTab().");
    const existing = this.#labelForTab(tabId);
    if (existing) return this.page(existing);
    const tab = await this.bridge.call("tabs.get", tabId);
    return this.#register(tab, "user", as);
  }

  async release(label) {
    const page = this.page(label);
    await page._detach();
    this._forget(label);
    await this.#save();
  }

  _forget(label) {
    delete this.#record.pages[label];
    this.#pages.delete(label);
    this.#save().catch(() => {});
  }

  _watchPopups(opener, onPopup) {
    const watcher = async (tab) => {
      if (tab.openerTabId !== opener.tabId) return;
      const page = await this.#register(tab, "agent");
      onPopup(page);
    };
    this.#popupWatchers.add(watcher);
    return () => this.#popupWatchers.delete(watcher);
  }

  _waitForPopup(opener, timeout) {
    return new Promise((resolve, reject) => {
      const stop = this._watchPopups(opener, (page) => {
        clearTimeout(timer);
        stop();
        resolve(page);
      });
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`No popup from page ${opener.label} within ${timeout}ms`));
      }, timeout);
    });
  }

  async finish({ keep = [] } = {}) {
    const kept = [];
    const closed = [];
    const released = [];
    const work = [];
    for (const [label, entry] of Object.entries({ ...this.#record.pages })) {
      if (keep.includes(label)) {
        kept.push(label);
        work.push(this.page(label)._detach());
      } else if (entry.openedBy === "agent") {
        closed.push(label);
        work.push(this.bridge.call("tabs.remove", entry.tabId).catch(() => {}));
      } else {
        released.push(label);
        work.push(this.page(label)._detach());
      }
    }
    await Promise.all(work);
    this.#finished = true;
    await this.#saving.catch(() => {});
    await saveRecord(this.#record.id, null);
    this.#record.pages = {};
    return { spaceId: this.spaceId, closed, kept, released };
  }

  async _settleDialogs() {
    const notes = [];
    for (const page of this.#pages.values()) {
      const dialog = page.dialog;
      if (!dialog) continue;
      await page.dismissDialog().catch(() => {});
      notes.push(`${page.label}: ${dialog.type} "${dialog.message}" was dismissed. Chain "-- accept [text]" after the action to accept it.`);
    }
    return notes;
  }

  toJSON() {
    return { spaceId: this.spaceId, name: this.name, pages: Object.keys(this.#record.pages) };
  }
}

export async function listTasks() {
  const state = await loadState();
  return Object.values(state.tasks).map((record) => ({
    spaceId: record.id,
    name: record.name,
    createdAt: record.createdAt,
    pages: Object.fromEntries(Object.entries(record.pages).map(([label, entry]) => [label, entry.tabId])),
  }));
}
