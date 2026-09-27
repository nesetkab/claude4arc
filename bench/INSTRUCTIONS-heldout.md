# Browser tool benchmark: held-out tasks

You are benchmarking ONE browser automation tool. Use only that tool for all
browser work. Do not use curl, WebFetch, WebSearch, or any other way to read
pages. Do not read or modify any files in the claude4arc repository (no
source, tests, or bench files), except that task H8 names a file to upload.
Do not look at other tools' code. Work in the background or agent tabs the
tool gives you; never touch the user's own tabs.

## Timing

For every task, run `perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'`
in Bash immediately before your first action for the task and again
immediately after you have finished and verified it. Report both numbers.
Give each task at most 4 minutes; if you are stuck, stop, mark it failed, and
move on. Do the tasks in order.

Replace `RUN` in URLs with your run id.

## Tasks

H1. Open http://127.0.0.1:8900/h1.html?run=RUN and book a workspace for
"Grace Hopper" starting on 2026-10-15 on the "Team" plan. Confirm the booking.

H2. Open http://127.0.0.1:8900/h2.html?run=RUN . Choose Lisbon (LIS) as the
destination from the suggestions and search for flights.

H3. Open http://127.0.0.1:8900/h3.html?run=RUN . Edit the profile: set the bio
to "Compiler pioneer." and make the profile public. Save the changes.

H4. Open http://127.0.0.1:8900/h4.html?run=RUN . Add the cheapest product to
the cart, and report its name.

H5. Open http://127.0.0.1:8900/h5.html?run=RUN . Turn on paperless billing and
save the billing settings.

H6. Open http://127.0.0.1:8900/h6.html?run=RUN . Replace the note's text with
exactly "Meeting moved to 3 pm." and publish it.

H7. Open http://127.0.0.1:8900/h7.html?run=RUN . Find Order #4521, open it,
and report its status.

H8. Open http://127.0.0.1:8900/h8.html?run=RUN . Attach the receipt file
BENCH/files/receipt-2291.txt and submit the expense. (BENCH is given below.)

H9. Open http://127.0.0.1:8900/h9.html?run=RUN . Turn on dark mode in the
embedded appearance settings and apply it.

H10. Open http://127.0.0.1:8900/h10.html?run=RUN . Set the volume to 75. Then
search the catalog for "kiwi" and report how many results there are.

W5. On Wikipedia's "Python (programming language)" article, report who
designed Python, as listed in the infobox.

W6. On MDN, find the reference page for the HTTP status code 418, and report
the status code's name.

W7. On https://github.com/expressjs/express , report the license shown in the
repository's About sidebar.

W8. Open https://news.ycombinator.com/item?id=8863 and report that item's
title.

## When done

Close any tabs you opened (finish or close the session per your tool's docs).
Then reply with ONLY a JSON array, one object per task, in order:

    {"task": "H1", "start_ms": 0, "end_ms": 0, "success": true, "answer": "", "notes": ""}

`answer` is required for H4, H7, H10, and W5–W8 (empty string otherwise).
`notes` is at most 20 words about problems you hit.
