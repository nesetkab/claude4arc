import fs from "node:fs/promises";
import { blockedBy, blockedError, readBlocklist } from "./blocklist.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { Page } from "./page.js";
import { normalizeUrl } from "./util.js";
import { TASKS_PATH } from "./paths.js";

const LOCK_PATH = `${TASKS_PATH}.lock`;
const BREAK_PATH = `${LOCK_PATH}.break`;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadState() {
  let text;
  try {
    text = await fs.readFile(TASKS_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { nextId: 1, tasks: {} };
    throw error;
  }
  try {
    const state = JSON.parse(text);
    if (state && typeof state.tasks === "object" && state.tasks) return { nextId: 1, ...state };
  } catch {}
  const backup = `${TASKS_PATH}.bad-${Date.now()}`;
  await fs.rename(TASKS_PATH, backup).catch(() => {});
  process.stderr.write(`claude4arc: ${TASKS_PATH} was unreadable; moved it to ${backup} and started a fresh task list.\n`);
  return { nextId: 1, tasks: {} };
}

export async function writeState(state) {
  await fs.mkdir(path.dirname(TASKS_PATH), { recursive: true, mode: 0o700 });
  const temp = `${TASKS_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(state, null, 2));
    await fs.rename(temp, TASKS_PATH);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function isStale(file) {
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(stat) && Date.now() - stat.mtimeMs > LOCK_STALE_MS;
}

async function breakStaleLock() {
  try {
    await fs.writeFile(BREAK_PATH, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await isStale(BREAK_PATH)) await fs.rm(BREAK_PATH, { force: true });
    else await sleep(5 + Math.random() * 20);
    return;
  }
  try {
    if (await isStale(LOCK_PATH)) await fs.rm(LOCK_PATH, { force: true });
  } finally {
    await fs.rm(BREAK_PATH, { force: true });
  }
}

async function withLock(work) {
  await fs.mkdir(path.dirname(TASKS_PATH), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.writeFile(LOCK_PATH, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (await isStale(LOCK_PATH)) await breakStaleLock();
    else if (Date.now() > deadline) throw new Error(`Timed out waiting for ${LOCK_PATH}. If no claude4arc command is running, delete that file.`);
    else await sleep(5 + Math.random() * 20);
  }
  try {
    return await work();
  } finally {
    await fs.rm(LOCK_PATH, { force: true });
  }
}

export function updateState(change) {
  return withLock(async () => {
    const state = await loadState();
    if ((await change(state)) !== false) await writeState(state);
  });
}

function saveRecord(id, record) {
  return updateState((state) => {
    if (record) state.tasks[String(id)] = record;
    else delete state.tasks[String(id)];
    state.nextId = Math.max(state.nextId, Number(id) + 1);
  });
}

export function mergeRecord(latest, base, local) {
  const pages = { ...latest.pages };
  for (const label of Object.keys(base.pages)) {
    if (!(label in local.pages)) delete pages[label];
  }
  for (const [label, entry] of Object.entries(local.pages)) {
    if (base.pages[label]?.tabId !== entry.tabId) pages[label] = entry;
  }
  return {
    ...latest,
    pages,
    nextLabel: Math.max(latest.nextLabel ?? 1, local.nextLabel ?? 1),
    current: local.current !== base.current ? local.current : latest.current,
  };
}

const snapshot = (record) => structuredClone({ pages: record.pages, current: record.current });

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

export async function browserOfTask(id) {
  const state = await loadState();
  return state.tasks[String(id)]?.browser ?? null;
}

export class Task {
  static open(bridge, nameOrId, options = {}) {
    if (typeof nameOrId === "number" || /^\d+$/.test(String(nameOrId))) return Task.resume(bridge, Number(nameOrId));
    return Task.create(bridge, nameOrId, options);
  }

  static async resume(bridge, id) {
    const state = await loadState();
    const record = state.tasks[String(id)];
    if (!record) throw new Error(`Task ${id} does not exist. Use the id printed by \`claude4arc new\`, or run \`claude4arc status\`.`);
    if (record.owner && OWNER && record.owner !== OWNER && !process.env.CLAUDE4ARC_ANY_TASK && !process.env.ARC_BROWSER_ANY_TASK) {
      throw new Error(`Task ${id} belongs to another Claude session. Use the id printed by your own \`claude4arc new\`.`);
    }
    if (record.browser && bridge.browser && record.browser !== bridge.browser) {
      throw new Error(`Task ${id} runs in ${record.browser}, but this command is connected to ${bridge.browser}.`);
    }
    const task = new Task(bridge, state, record);
    task.#base = snapshot(record);
    await task.#prune();
    return task;
  }

  static async create(bridge, name, { active = false, url } = {}) {
    const state = await loadState();
    const record = {
      id: await allocateId(),
      name: String(name ?? "task"),
      createdAt: new Date().toISOString(),
      owner: OWNER,
      browser: bridge.browser,
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
  #base = null;

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

  #save(change) {
    this.#saving = this.#saving
      .catch(() => {})
      .then(() => {
        if (this.#finished) return;
        return updateState((state) => this.#sync(state, change));
      });
    return this.#saving;
  }

  #sync(state, change) {
    const id = String(this.#record.id);
    const latest = state.tasks[id];
    if (!latest && this.#base) {
      this.#finished = true;
      if (change) throw new Error(`Task ${id} was finished by another command.`);
      return false;
    }
    const record = latest && this.#base ? mergeRecord(latest, this.#base, this.#record) : this.#record;
    change?.(record);
    state.tasks[id] = record;
    state.nextId = Math.max(state.nextId, Number(id) + 1);
    this.#record = record;
    this.#base = snapshot(record);
  }

  async #addPage(tab, openedBy, as) {
    let label;
    await this.#save((record) => {
      label = as ?? `p${record.nextLabel++}`;
      if (record.pages[label]) throw new Error(`Label ${label} is already in use.`);
      record.pages[label] = { tabId: tab.id, openedBy };
      record.current = label;
    });
    return label;
  }

  flush() {
    return this.#saving.catch(() => {});
  }

  get finished() {
    return this.#finished;
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
    const label = await this.#addPage(tab, openedBy, as);
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

  async newPage({ url, active = false, timeout = 30_000, opener = null, openerTabId = null } = {}) {
    const pattern = url ? blockedBy(normalizeUrl(url), readBlocklist()) : null;
    if (pattern) throw blockedError(normalizeUrl(url), pattern);
    if (opener && url) {
      const tab = await this.bridge.call("tabs.create", { url: "about:blank", active });
      await this.bridge.call("guard.enable", tab.id).catch(() => {});
      this.bridge.call("tabs.update", tab.id, { muted: true }).catch(() => {});
      const page = await this.#registerOnce(tab);
      await this.bridge.call("host.linkPopup", tab.id, opener);
      await page.goto(url, { waitUntil: "commit", timeout }).catch(() => {});
      await page._waitForTabLoad(Math.min(timeout, 10_000)).catch(() => {});
      return page;
    }
    const parent = openerTabId ? await this.bridge.call("tabs.get", openerTabId).catch(() => null) : null;
    const placement = parent ? { openerTabId: parent.id, windowId: parent.windowId } : {};
    const tab = await this.bridge.call("tabs.create", { url: url ? normalizeUrl(url) : "about:blank", active, ...placement });
    this.bridge.call("guard.enable", tab.id).catch(() => {});
    this.bridge.call("tabs.update", tab.id, { muted: true }).catch(() => {});
    const page = await this.#registerOnce(tab);
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
    const pattern = blockedBy(tab.url, readBlocklist());
    if (pattern) throw blockedError(tab.url, pattern);
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
    return this.#save().catch(() => {});
  }

  #registering = new Map();

  #registerOnce(tab) {
    const existing = this.#labelForTab(tab.id);
    if (existing) return Promise.resolve(this.page(existing));
    if (!this.#registering.has(tab.id)) {
      this.#registering.set(tab.id, this.#register(tab, "agent").finally(() => this.#registering.delete(tab.id)));
    }
    return this.#registering.get(tab.id);
  }

  _watchPopups(opener, onPopup) {
    const watcher = (tab) => {
      if (tab.openerTabId !== opener.tabId) return;
      this.#registerOnce(tab).then(onPopup, () => {});
    };
    this.#popupWatchers.add(watcher);
    return () => this.#popupWatchers.delete(watcher);
  }

  _announcePopup(opener, page) {
    for (const watcher of this.#popupWatchers) watcher({ id: page.tabId, openerTabId: opener.tabId });
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
