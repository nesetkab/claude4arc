#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const BASE_PORT = Number(process.env.ARC_TEST_PORT ?? 8811);
export const PORTS = [BASE_PORT, BASE_PORT + 1];
export const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseFields(body, contentType = "") {
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (boundary) {
    const fields = {};
    for (const part of body.split(`--${boundary[1] ?? boundary[2]}`)) {
      const match = /name="([^"]+)"(?:; filename="([^"]*)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/.exec(part);
      if (match) fields[match[1]] = match[2] !== undefined ? `file:${match[2]}` : match[3];
    }
    return fields;
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function echoPage(method, fields) {
  const json = JSON.stringify(fields);
  const rows = Object.entries(fields)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Echo</title></head>
<body>
<main>
<h1>Echo ${method}</h1>
<table>${rows}</table>
<pre id="result">${escapeHtml(json)}</pre>
</main>
</body>
</html>`;
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const headers = { "cache-control": "no-store" };
  if (url.pathname === "/health") {
    response.writeHead(200, { ...headers, "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (url.pathname === "/download") {
    const name = url.searchParams.get("name") ?? "report.txt";
    response.writeHead(200, { ...headers, "content-type": "text/plain", "content-disposition": `attachment; filename="${name}"` });
    response.end(`arc-browser download test ${name}\n`);
    return;
  }
  if (url.pathname === "/echo") {
    const fields =
      request.method === "POST"
        ? parseFields(await readBody(request), request.headers["content-type"])
        : Object.fromEntries(url.searchParams);
    response.writeHead(200, { ...headers, "content-type": TYPES[".html"] });
    response.end(echoPage(request.method, fields));
    return;
  }
  let relative = decodeURIComponent(url.pathname);
  if (relative === "/") relative = "/index.html";
  if (relative === "/spa" || relative.startsWith("/spa/")) relative = "/spa.html";
  const file = path.join(FIXTURES, path.normalize(relative));
  if (!file.startsWith(FIXTURES)) {
    response.writeHead(403, headers);
    response.end("forbidden");
    return;
  }
  try {
    let data = await fs.readFile(file);
    if (path.extname(file) === ".html") data = data.toString("utf8").replaceAll("8811", String(PORTS[0])).replaceAll("8812", String(PORTS[1]));
    response.writeHead(200, { ...headers, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404, { ...headers, "content-type": "text/plain" });
    response.end("not found");
  }
}

export async function startServer({ ports = PORTS, host = HOST } = {}) {
  const servers = await Promise.all(
    ports.map(
      (port) =>
        new Promise((resolve, reject) => {
          const server = http.createServer((request, response) => {
            handle(request, response).catch((error) => {
              response.writeHead(500, { "content-type": "text/plain" });
              response.end(error.message);
            });
          });
          server.once("error", reject);
          server.listen(port, host, () => resolve(server));
        }),
    ),
  );
  return {
    ports,
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.close(resolve);
              server.closeAllConnections();
            }),
        ),
      ),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  console.log(`Serving ${FIXTURES} on ${server.ports.map((port) => `http://${HOST}:${port}`).join(" and ")}`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
