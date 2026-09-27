# Browser tool benchmark

You are benchmarking ONE browser automation tool. Use only that tool for all
browser work. Do not use curl, WebFetch, WebSearch, or any other way to read
pages. Do not read or modify files under `bench/` or `tests/`, and do not look
at other tools' code. Work in background/agent tabs the tool gives you; never
touch the user's own tabs.

## Timing

For every task, run `perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'`
(milliseconds; macOS `date` has no `%N`) in Bash immediately before your first
action for the task and again immediately after you have finished and
verified it. Report both numbers. Give each task at most 4 minutes; if you are
stuck, stop, mark it failed, and move on. Do the tasks in order.

Replace `RUN` in URLs with your run id.

## Tasks

B1. Open http://127.0.0.1:8900/b1.html?run=RUN and create an account:
Full name "Ada Lovelace", Email "ada@example.com", Country "Portugal",
plan "Pro", accept the terms, then submit.

B2. Open http://127.0.0.1:8900/b2.html?run=RUN . In the embedded
verification widget, enter the code ARC-42 and press Verify.

B3. Open http://127.0.0.1:8900/b3.html?run=RUN and delete the project
(confirm the deletion).

B4. Open http://127.0.0.1:8900/b4.html?run=RUN and click the entry
"Row 777" in the directory.

B5. Open http://127.0.0.1:8900/b5.html?run=RUN . Drag "Date" to the top of
the list, then press Save.

B6. Open http://127.0.0.1:8900/b6.html?run=RUN , open the report, and
report the access code shown in the report.

B7. Open http://127.0.0.1:8900/b7.html?run=RUN . Replace the editor's
entire content with exactly these three lines, then press "Save snippet":

    function add(a, b) {
      return a + b;
    }

B8. Open http://127.0.0.1:8900/b8.html?run=RUN and activate the engine.

B9. Open http://127.0.0.1:8900/b9.html?run=RUN , load the results, then
continue to booking.

B10. Open http://127.0.0.1:8900/b10.html?run=RUN and sign out using the
Account menu.

W1. On Wikipedia's "List of chemical elements" article, find the atomic
weight of iron as listed in the table.

W2. On https://github.com/octocat/Hello-World , report the exact text of the
README.

W3. Open https://news.ycombinator.com/item?id=1 and report that item's title.

W4. On MDN's page for JavaScript `Array.prototype.at()`, report the text of
the "Return value" section.

## When done

Close any tabs you opened (finish/close the session per your tool's docs).
Then reply with ONLY a JSON array, one object per task, in order:

    {"task": "B1", "start_ms": 0, "end_ms": 0, "success": true, "answer": "", "notes": ""}

`answer` is required for B6 and W1–W4 (empty string otherwise). `notes` is at
most 20 words about problems you hit.
