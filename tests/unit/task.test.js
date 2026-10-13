import test, { mock } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "claude4arc-task-"));
process.env.HOME = home;
const stateDir = path.join(home, ".arc-bridge");
const tasksPath = path.join(stateDir, "tasks.json");
const taskUrl = new URL("../../lib/task.js", import.meta.url).href;
const commandsUrl = new URL("../../lib/commands.js", import.meta.url).href;
const { updateState, writeState, mergeRecord, Task } = await import(taskUrl);
const { runBatch } = await import(commandsUrl);

const readTasks = async () => JSON.parse(await fs.readFile(tasksPath, "utf8"));
const reset = () => fs.rm(stateDir, { recursive: true, force: true });

test.after(() => fs.rm(home, { recursive: true, force: true }));

test("concurrent processes do not lose each other's writes", async () => {
  await reset();
  const writer = `
    const { updateState } = await import(${JSON.stringify(taskUrl)});
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      updateState((state) => { state.tasks[process.argv[1] + "-" + index] = { id: index }; })));
  `;
  const run = promisify(execFile);
  await Promise.all(
    Array.from({ length: 6 }, (_, worker) =>
      run(process.execPath, ["--input-type=module", "-e", writer, `w${worker}`], { env: { ...process.env, HOME: home } }),
    ),
  );
  const state = await readTasks();
  assert.equal(Object.keys(state.tasks).length, 60);
  const leftovers = (await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock") || name.endsWith(".break"));
  assert.deepEqual(leftovers, []);
});

test("a stale lock is taken over", async () => {
  await reset();
  await fs.mkdir(stateDir, { recursive: true });
  const lock = `${tasksPath}.lock`;
  await fs.writeFile(lock, "999999");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lock, old, old);
  await updateState((state) => {
    state.tasks["1"] = { id: 1 };
  });
  assert.ok((await readTasks()).tasks["1"]);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
  await assert.rejects(fs.stat(`${lock}.break`), { code: "ENOENT" });
});

test("a stale lock is still taken over when a crashed takeover left its marker behind", async () => {
  await reset();
  await fs.mkdir(stateDir, { recursive: true });
  const lock = `${tasksPath}.lock`;
  const old = new Date(Date.now() - 60_000);
  for (const file of [lock, `${lock}.break`]) {
    await fs.writeFile(file, "999999");
    await fs.utimes(file, old, old);
  }
  await updateState((state) => {
    state.tasks["1"] = { id: 1 };
  });
  assert.ok((await readTasks()).tasks["1"]);
  const leftovers = (await fs.readdir(stateDir)).filter((name) => name.endsWith(".lock") || name.endsWith(".break"));
  assert.deepEqual(leftovers, []);
});

test("two processes that both see a stale lock do not both take it", async () => {
  await reset();
  await fs.mkdir(stateDir, { recursive: true });
  const lock = `${tasksPath}.lock`;
  await fs.writeFile(lock, "999999");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lock, old, old);
  const who = new AsyncLocalStorage();
  const realStat = fs.stat;
  let releaseLate;
  const firstInside = new Promise((resolve) => (releaseLate = resolve));
  let settle;
  const lateSettled = new Promise((resolve) => (settle = resolve));
  let lateDelayed = false;
  mock.method(fs, "stat", async (file, ...rest) => {
    const delay = file === lock && who.getStore() === "late" && !lateDelayed;
    if (delay) lateDelayed = true;
    const result = await realStat.call(fs, file, ...rest);
    if (delay) await firstInside;
    else if (file === lock && who.getStore() === "late" && Date.now() - result.mtimeMs < 5_000) settle();
    return result;
  });
  let inside = 0;
  let overlapped = false;
  const change = (name) => async (state) => {
    if (inside++) overlapped = true;
    if (name === "early") {
      releaseLate();
      await lateSettled;
    } else settle();
    state.tasks[name] = { id: name };
    inside--;
  };
  try {
    await Promise.all([
      who.run("early", () => updateState(change("early"))),
      who.run("late", () => updateState(change("late"))),
    ]);
  } finally {
    mock.restoreAll();
  }
  assert.equal(overlapped, false);
  assert.deepEqual(Object.keys((await readTasks()).tasks).sort(), ["early", "late"]);
});

test("a change that throws releases the lock and writes nothing", async () => {
  await reset();
  await assert.rejects(
    updateState(() => {
      throw new Error("nope");
    }),
    /nope/,
  );
  await assert.rejects(fs.stat(tasksPath), { code: "ENOENT" });
  await updateState((state) => {
    state.tasks["2"] = { id: 2 };
  });
  assert.ok((await readTasks()).tasks["2"]);
});

test("an unreadable tasks.json is backed up, not wiped", async () => {
  await reset();
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(tasksPath, '{"nextId": 3, "tasks": {"1": ');
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await updateState((state) => {
      state.tasks["5"] = { id: 5 };
    });
  } finally {
    process.stderr.write = stderr;
  }
  const backups = (await fs.readdir(stateDir)).filter((name) => name.startsWith("tasks.json.bad-"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(stateDir, backups[0]), "utf8"), '{"nextId": 3, "tasks": {"1": ');
  assert.deepEqual(Object.keys((await readTasks()).tasks), ["5"]);
});

test("writeState removes its temp file when the rename fails", async () => {
  await reset();
  await fs.mkdir(tasksPath, { recursive: true });
  await fs.writeFile(path.join(tasksPath, "keep"), "");
  await assert.rejects(writeState({ nextId: 1, tasks: {} }));
  const temps = (await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(temps, []);
});

test("mergeRecord keeps other processes' pages and applies only local changes", () => {
  const base = { pages: { p1: { tabId: 1 }, p2: { tabId: 2 } }, current: "p1" };
  const latest = { id: 7, nextLabel: 4, pages: { p1: { tabId: 1 }, p2: { tabId: 2 }, p3: { tabId: 3 } }, current: "p3" };
  const local = { id: 7, nextLabel: 3, pages: { p1: { tabId: 1 } }, current: "p1" };
  assert.deepEqual(mergeRecord(latest, base, local), {
    id: 7,
    nextLabel: 4,
    pages: { p1: { tabId: 1 }, p3: { tabId: 3 } },
    current: "p3",
  });
  const removedElsewhere = { ...latest, pages: { p2: { tabId: 2 } } };
  assert.deepEqual(Object.keys(mergeRecord(removedElsewhere, base, { ...base, pages: { ...base.pages, p9: { tabId: 9 } } }).pages), ["p2", "p9"]);
});

function fakeBridge() {
  const calls = [];
  let nextTab = 100;
  const tabs = new Map();
  return {
    calls,
    browser: "arc",
    on() {},
    async call(method, ...args) {
      calls.push([method, ...args]);
      if (method === "tabs.create") {
        const tab = { id: nextTab++, windowId: 1, url: args[0].url, title: "" };
        tabs.set(tab.id, tab);
        return tab;
      }
      if (method === "tabs.remove") return tabs.delete(args[0]);
      if (method === "tabs.query") return [...tabs.values()];
      if (method === "tabs.get") return tabs.get(args[0]);
      if (method === "debugger.attach") throw new Error(`No tab with id: ${args[0]}`);
      return null;
    },
  };
}

test("a name made of digits creates a task instead of resuming one", async () => {
  await reset();
  const bridge = fakeBridge();
  const task = await Task.create(bridge, "3");
  assert.equal(task.name, "3");
  await task.flush();
  const state = await readTasks();
  assert.equal(state.tasks[String(task.spaceId)].name, "3");
  await assert.rejects(Task.resume(bridge, 4242), /does not exist/);
});

test("a finished task is not written back by a stale process", async () => {
  await reset();
  const bridge = fakeBridge();
  const task = await Task.create(bridge, "stale");
  const id = task.spaceId;
  const other = await Task.resume(bridge, id);
  await task.finish();
  assert.equal((await readTasks()).tasks[String(id)], undefined);
  await other._forget("p1");
  assert.equal((await readTasks()).tasks[String(id)], undefined);
  assert.equal(other.finished, true);
});

test("batch finishes the task when a line with finish fails before reaching it", async () => {
  await reset();
  const bridge = fakeBridge();
  const output = [];
  const failures = await runBatch(bridge, "click #missing -- finish", { write: (text) => output.push(text) });
  assert.equal(failures, 1);
  assert.match(output.at(-1), /^== finish\nclosed p1/);
  assert.ok(bridge.calls.some(([method]) => method === "tabs.remove"));
  assert.deepEqual((await readTasks()).tasks, {});
});

test("wait with no argument prints usage instead of crashing", async () => {
  await reset();
  const output = [];
  const failures = await runBatch(fakeBridge(), "wait", { write: (text) => output.push(text) });
  assert.equal(failures, 1);
  assert.match(output[1], /FAILED[^\n]*\nError: Usage: wait/);
});

test("two commands on one task get different labels and keep both pages", async () => {
  await reset();
  const bridge = fakeBridge();
  const task = await Task.create(bridge, "shared");
  const first = await Task.resume(bridge, task.spaceId);
  const second = await Task.resume(bridge, task.spaceId);
  const tabA = await bridge.call("tabs.create", { url: "https://a.test" });
  const tabB = await bridge.call("tabs.create", { url: "https://b.test" });
  const [pageA, pageB] = await Promise.all([first.adopt(tabA.id), second.adopt(tabB.id)]);
  assert.notEqual(pageA.label, pageB.label);
  const pages = (await readTasks()).tasks[String(task.spaceId)].pages;
  assert.deepEqual(Object.keys(pages).sort(), ["p1", pageA.label, pageB.label].sort());
});
