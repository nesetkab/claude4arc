# Benchmark

This folder compares three browser tools for Claude Code on the same tasks:
claude4arc, ego-lite, and Claude for Chrome. The tool was named `arc-browser`
during the early runs; the results use the current name.

![Benchmark figure](figures/benchmark.png)

| Tool | Tasks passed | Time | Tool calls | Input tokens read |
|---|---|---|---|---|
| claude4arc | 14 / 14 | 50.5 s (mean of 49.4 and 51.7) | 3 | 0.19 M |
| ego-lite | 14 / 14 | 195.0 s | 33 | 1.93 M |
| Claude for Chrome | 14 / 14 | 319.8 s | 84 | 4.95 M |

## Method

- Each run is a fresh Claude Code subagent on the same model. It gets only
  its tool's skill or tools and [INSTRUCTIONS.md](INSTRUCTIONS.md).
- There are 14 tasks: 10 local fixture pages (a form, a cross-origin iframe,
  a confirm dialog, a virtual list, drag and drop, a popup window, a code
  editor, a closed shadow root, delayed content, and a hover menu) and 4
  lookups on real sites (Wikipedia, GitHub, Hacker News, MDN).
- Each fixture page reports its result to the benchmark server, which appends
  it to `results/records.jsonl`. A task counts as passed only when the server
  recorded the expected value, not when the agent says so.
- Time, tool calls, and context size come from the Claude Code harness.
  "Input tokens read" is the sum of the input tokens of every model turn, from
  the agent transcripts. Each turn reads the whole conversation again, so this
  number follows cost.

## Limits

- claude4arc was improved against these same tasks over eleven runs
  (`results/arc*.json`). ego-lite and Claude for Chrome ran once each with
  their standard setup. Treat the gap as an upper bound.
- ego-lite and Claude for Chrome each have one run, and claude4arc two final
  runs, so the numbers show the size of the difference, not a precise value.
- Claude for Chrome passed every task, but its agent used workarounds: it
  replaced `window.confirm` in JavaScript, opened the popup's URL in a new tab,
  and used the Tab key inside the cross-origin iframe.

## Run it yourself

Start the fixture server (ports 8900 and 8901):

```bash
node bench/server.js
```

Then give a fresh Claude Code agent the instructions in
[INSTRUCTIONS.md](INSTRUCTIONS.md), with a unique run id and one tool. Check
the results:

```bash
grep '"run":"<run id>"' bench/results/records.jsonl
```

The scripted runs measure the tools without a model in the loop:

```bash
claude4arc run < bench/scripted-arc.js
```

`scripted-ego.js` is the same script for ego-lite's script runner.

To draw the figure again (needs matplotlib):

```bash
python3 bench/figures/make_figure.py
```

## Files

| Path | Contents |
|---|---|
| `INSTRUCTIONS.md` | the task list every agent received |
| `pages/` | the fixture pages |
| `server.js` | the fixture server and result recorder |
| `results/*.json` | each agent's own report, with per-task timestamps |
| `results/*.meta.json` | harness figures for each run |
| `results/records.jsonl` | results recorded by the fixture pages |
| `results/scripted*.json*` | scripted runs without a model |
| `report.html` | an interactive report of all runs |
| `figures/` | the figure above and the script that draws it |
