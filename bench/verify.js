#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED = {
  b1: (value) => {
    const data = JSON.parse(value);
    return data.name === "Ada Lovelace" && data.email === "ada@example.com" && data.country === "Portugal" && data.plan === "Pro" && data.terms === true;
  },
  b2: (value) => value === "ARC-42",
  b3: (value) => value === "deleted",
  b4: (value) => value === "Row 777",
  b5: (value) => value.startsWith("Date,"),
  b6: (value) => value === "opened",
  b7: (value) => value === "function add(a, b) {\n  return a + b;\n}",
  b8: (value) => value === "activated",
  b9: (value) => value === "continued",
  b10: (value) => value === "signed-out",
  h1: (value) => {
    const data = JSON.parse(value);
    return data.name === "Grace Hopper" && data.date === "2026-10-15" && data.plan === "Team";
  },
  h2: (value) => value === "LIS",
  h3: (value) => {
    const data = JSON.parse(value);
    return data.bio === "Compiler pioneer." && data.public === true;
  },
  h4: (value) => value === "Paper clips",
  h5: (value) => value === "paperless:on",
  h6: (value) => value === "Meeting moved to 3 pm.",
  h7: (value) => value === "4521",
  h8: (value) => JSON.parse(value).name === "receipt-2291.txt",
  h9: (value) => value === "dark",
  h10: (value) => {
    const data = JSON.parse(value);
    return data.volume === 75 && data.query === "kiwi" && data.results === 3;
  },
};

const files = process.argv.slice(2).filter((arg) => arg.endsWith(".jsonl"));
const runs = process.argv.slice(2).filter((arg) => !arg.endsWith(".jsonl"));
const sources = files.length ? files : [path.join(HERE, "results", "records.jsonl"), path.join(HERE, "results", "records.local.jsonl")];
const records = sources
  .filter((file) => fs.existsSync(file))
  .flatMap((file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));

const byRun = new Map();
for (const record of records) {
  if (runs.length && !runs.includes(record.run)) continue;
  const tasks = byRun.get(record.run) ?? new Map();
  tasks.set(record.task, record.value);
  byRun.set(record.run, tasks);
}

let failed = false;
for (const [run, tasks] of byRun) {
  const suite = [...tasks.keys()].some((task) => task.startsWith("h")) ? "h" : "b";
  const expected = Object.keys(EXPECTED).filter((task) => task.startsWith(suite));
  const passed = expected.filter((task) => {
    try {
      return tasks.has(task) && EXPECTED[task](tasks.get(task));
    } catch {
      return false;
    }
  });
  const missing = expected.filter((task) => !passed.includes(task));
  if (missing.length) failed = true;
  console.log(`${run.padEnd(14)} ${passed.length}/${expected.length}${missing.length ? `  failed: ${missing.join(", ")}` : ""}`);
}
if (runs.some((run) => !byRun.has(run))) {
  console.log(`no records for: ${runs.filter((run) => !byRun.has(run)).join(", ")}`);
  failed = true;
}
process.exitCode = failed ? 1 : 0;
