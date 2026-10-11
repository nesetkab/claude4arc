import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "host", "host.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "c4a-"));
const SOCKET = path.join(home, ".arc-bridge", "chromium.sock");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startHost(reply = () => {}) {
  const child = spawn(process.execPath, [HOST], { env: { ...process.env, HOME: home, CLAUDE4ARC_HOST_BROWSER: "chromium" }, stdio: ["pipe", "pipe", "inherit"] });
  child.toExtension = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      child.toExtension.push(message);
      const answer = reply(message);
      if (answer) {
        const body = Buffer.from(JSON.stringify({ id: message.id, ...answer }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length, 0);
        child.stdin.write(Buffer.concat([header, body]));
      }
    }
  });
  child.exited = new Promise((resolve) => child.once("exit", resolve));
  return child;
}

async function connect() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const client = net.createConnection(SOCKET, () => resolve(client));
        client.once("error", reject);
      });
      socket.setEncoding("utf8");
      let text = "";
      const waiting = [];
      socket.on("data", (chunk) => {
        text += chunk;
        let index;
        while ((index = text.indexOf("\n")) >= 0) {
          const line = text.slice(0, index);
          text = text.slice(index + 1);
          waiting.shift()?.(JSON.parse(line));
        }
      });
      socket.ask = (line) => new Promise((resolve) => {
        waiting.push(resolve);
        socket.write(line + "\n");
      });
      return socket;
    } catch {
      await sleep(50);
    }
  }
  throw new Error("host never listened");
}

async function stop(child) {
  child.stdin.end();
  await child.exited;
}

test("the host survives malformed requests and refuses oversized messages", async () => {
  const host = startHost();
  const client = await connect();
  assert.match((await client.ask("null")).error, /Bad request/);
  assert.match((await client.ask("5")).error, /Bad request/);
  assert.match((await client.ask(JSON.stringify({ id: 3, api: "tabs.get", args: 7 }))).error, /args must be an array/);
  const huge = JSON.stringify({ id: 4, api: "debugger.send", args: [1, "Runtime.evaluate", { expression: "x".repeat(1_100_000) }] });
  const answer = await client.ask(huge);
  assert.equal(answer.id, 4);
  assert.match(answer.error, /1 MB limit/);
  assert.equal(host.toExtension.length, 0);
  assert.equal((await client.ask(JSON.stringify({ id: 5, api: "host.status" }))).result.host.pid, host.pid);
  client.destroy();
  await stop(host);
  assert.ok(!fs.existsSync(SOCKET));
});

test("a second host for the same browser waits instead of stealing the socket, then takes over", async () => {
  const first = startHost();
  const firstClient = await connect();
  const inode = fs.statSync(SOCKET).ino;
  const second = startHost();
  await sleep(1500);
  assert.equal(fs.statSync(SOCKET).ino, inode);
  assert.equal((await firstClient.ask(JSON.stringify({ id: 1, api: "host.status" }))).result.host.pid, first.pid);
  firstClient.destroy();
  await stop(first);
  await sleep(1500);
  const secondClient = await connect();
  assert.equal((await secondClient.ask(JSON.stringify({ id: 1, api: "host.status" }))).result.host.pid, second.pid);
  secondClient.destroy();
  await stop(second);
  assert.match(fs.readFileSync(path.join(home, ".arc-bridge", "host.log"), "utf8"), /waiting/);
});

test("attach tells our own leftover attachment apart from another debugger", async () => {
  let ours = false;
  const host = startHost((message) => {
    if (message.api === "debugger.attach") return { error: "Another debugger is already attached to the tab with id: 9." };
    if (message.api === "debugger.send" && message.args[1] === "Runtime.evaluate") return ours ? { result: {} } : { error: "Debugger is not attached to the tab with id: 9." };
    return { result: {} };
  });
  const client = await connect();
  assert.match((await client.ask(JSON.stringify({ id: 1, api: "debugger.attach", args: [9] }))).error, /Another debugger \(DevTools or another extension\)/);
  ours = true;
  assert.deepEqual((await client.ask(JSON.stringify({ id: 2, api: "debugger.attach", args: [9] }))).result, { already: true });
  client.destroy();
  await stop(host);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
