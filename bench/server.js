#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(HERE, "pages");
const RECORDS = process.env.BENCH_RECORDS ?? path.join(HERE, "results", "records.local.jsonl");
const BASE = Number(process.env.BENCH_PORT ?? 8900);
const PORTS = [BASE, BASE + 1];

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (url.pathname === "/record") {
    const entry = {
      time: new Date().toISOString(),
      run: url.searchParams.get("run") ?? "unknown",
      task: url.searchParams.get("task"),
      value: url.searchParams.get("value"),
    };
    await fs.appendFile(RECORDS, JSON.stringify(entry) + "\n");
    response.writeHead(204, headers);
    response.end();
    return;
  }
  const relative = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.join(PAGES, path.normalize(relative));
  if (!file.startsWith(PAGES)) {
    response.writeHead(403, headers);
    response.end();
    return;
  }
  try {
    let data = await fs.readFile(file, "utf8");
    data = data.replaceAll("__CROSS__", `http://localhost:${PORTS[1]}`);
    response.writeHead(200, { ...headers, "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" });
    response.end(data);
  } catch {
    response.writeHead(404, headers);
    response.end("not found");
  }
}

for (const port of PORTS) {
  http.createServer((request, response) => handle(request, response).catch(() => response.end())).listen(port, "127.0.0.1");
}
console.log(`bench on http://127.0.0.1:${PORTS[0]} and http://localhost:${PORTS[1]}`);
