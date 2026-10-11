import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Bridge, BridgeError } from "../../lib/client.js";

async function fakeServer(onLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c4a-"));
  const file = path.join(dir, "s.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, index);
        text = text.slice(index + 1);
        onLine(socket, JSON.parse(line));
      }
    });
  });
  await new Promise((resolve) => server.listen(file, resolve));
  const socket = await new Promise((resolve, reject) => {
    const client = net.createConnection(file, () => resolve(client));
    client.once("error", reject);
  });
  return { bridge: new Bridge(socket), server, cleanup: () => new Promise((resolve) => server.close(resolve)).then(() => fs.rmSync(dir, { recursive: true, force: true })) };
}

test("calls resolve with the server's result", async () => {
  const { bridge, cleanup } = await fakeServer((socket, { id, api }) => socket.write(JSON.stringify({ id, result: api }) + "\n"));
  assert.equal(await bridge.call("tabs.query"), "tabs.query");
  bridge.close();
  await cleanup();
});

test("a closed bridge rejects pending and later calls instead of hanging", async () => {
  const { bridge, cleanup } = await fakeServer((socket) => socket.destroy());
  await assert.rejects(bridge.call("tabs.query"), BridgeError);
  await assert.rejects(bridge.call("tabs.query"), /connection closed/);
  await cleanup();
});

test("calls after close() reject at once", async () => {
  const { bridge, cleanup } = await fakeServer(() => {});
  bridge.close();
  await assert.rejects(bridge.call("tabs.query"), /connection closed/);
  await cleanup();
});

test("a socket error does not crash the process", async () => {
  const { bridge, cleanup } = await fakeServer(() => {});
  bridge.socket.destroy(new Error("boom"));
  await assert.rejects(bridge.call("tabs.query"), /connection closed/);
  await cleanup();
});
