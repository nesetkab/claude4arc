---
name: claude4arc
description: Control the user's real Arc browser (their logged-in sessions, cookies, and open tabs) through the claude4arc CLI. Use when the user mentions Arc, asks you to do something "in my browser", or needs a site where they are already signed in. Opens and operates websites, fills forms, clicks, types, takes screenshots, extracts page data, and works with the user's existing tabs.
---

# claude4arc

Drives the user's own Arc (real profile, trusted input events) through a local
extension. It also works in Dia, Chrome, Brave, Edge, and Chromium; set
`CLAUDE4ARC_BROWSER=chrome` (or `dia`, `brave`, ...) only when the user names
another browser. Work happens in background tabs, so the user is not interrupted.
If a command fails with "Arc bridge is not running", run `claude4arc doctor`
and relay its output.

## Speed rules (each tool call costs seconds of model time; the browser is fast)

- Do not look before you act. Guess selectors from the words in the task:
  `text=Save`, `role=button[name="Sign in"]`, `role=textbox[name=Email]`,
  or a field's label (`fill "text=Full name" Ada`, `select text=Country Spain`).
  Selectors also search cross-origin iframes when the page itself has no match.
  Only when a guess fails, `find <words>` and retry that one step.
- Open and act in the same call: `claude4arc new <url> -- fill … -- click … -s`.
- Batch: when you have several tasks, do ALL of them in ONE `claude4arc
  batch` call. Each stdin line is one chain, with an optional `label:` prefix.
  Each line prints `== label ok|FAILED <start ms>-<end ms>` and its output. A
  failure does not stop later lines, and the task finishes by itself at the
  end, so you need no `new`, `finish`, ids, or timestamp commands. Do not add
  `snap` to look first. Then retry only the failed lines with another batch.

  ```bash
  claude4arc batch <<'EOF'
  A: goto https://a.test/form -- fill "text=Name" Ada -- select "text=Country" Spain -- check "text=I agree" -- click "text=Submit" -s
  B: goto https://b.test -- accept -- click "text=Delete" -s
  C: goto https://c.test -- click "text=Open report" -- text
  D: goto https://d.test -- fill role=textbox $'line 1\n  line 2' -- click "text=Save" -s
  E: goto https://e.test -- drag "text=Date" "css=li >> nth=0" -- click "text=Save" -s
  F: goto https://f.test -- click "text=Account" -- click "text=Sign out" -s
  G: goto https://g.test/list -- seek "Row 500" -- click 'text="Row 500"' -s
  H: goto https://h.test/wiki -- text 'css=tr:has-text("Iron")' 400
  I: goto https://i.test/docs -- section "Return value"
  J: goto https://j.test/repo -- text 1500
  EOF
  ```

  Every line above works without looking first: a popup becomes the current
  page (so `text` reads it), `fill` handles code editors and iframe fields,
  `drag` handles HTML5 and mouse lists (drop on the first item to move to the
  top), menus open on `click`, and `seek` scrolls virtual lists. Quoting
  follows the shell: `"…"`, `'…'`, and `$'…\n…'`.
- To read, use `section <heading>` for one part of a document, plain `text`
  for the main content (usually short), or `text 'css=tr:has-text("x")'` for
  one table row. A guessed CSS selector often misses.
- `click` waits up to 5 s for its target, so `click "text=Load" -- click
  "text=Continue"` works when Continue appears later.
- Trust receipts. `ok`, `popup p2`, `confirm "…" accepted`, `navigated → …`,
  or a `-s` diff that shows the new state confirm the step. Do not
  spend another call re-checking with `eval` or `snap`.
- Quote selectors that contain `[`, `]`, spaces, or `*` (zsh expands them).
- Reuse one task for the whole goal (`goto`), and `finish` once at the end.

## Commands (default: use these)

```bash
claude4arc new <url> [-- <cmd> ...] [-s] # new task, optionally act right away
claude4arc 7 <cmd> [args]              # run on the task's current page
claude4arc 7:p2 <cmd> [args]           # run on page p2 (and make it current)
claude4arc 7 fill @3 hi -- click @4 -s # chain with "--"; -s appends a diff snapshot
claude4arc batch [7] [--keep] <<'EOF'  # one chain per line (see Speed rules)
```

| Command | Does |
|---|---|
| `snap` / `snap full` / `snap @12` | viewport / whole page / one subtree snapshot |
| `diff` | only what changed since the last snapshot of this page |
| `table [sel]` | a table or grid as tab-separated rows (largest visible table by default) |
| `links [words]` | visible links as `@ref text → full URL`, filtered by words |
| `find <words>` | matching elements anywhere on the page, with refs |
| `seek <sel\|words> [container]` | scroll a feed or virtualized list until a match renders; prints its ref |
| `section <heading> [chars]` | the text under a heading, up to the next heading of the same level |
| `text [sel] [chars]`, `text all` | readable text of `<main>`, of one element (`text @12`, `text css=article`), or of the whole page; default 8000 chars |
| `goto <url>`, `back`, `forward`, `reload` | navigate and wait for load |
| `click <sel>`, `dblclick`, `hover` | trusted pointer input; scrolls into view. `click 420,260` clicks screenshot coordinates |
| `fill <sel> <text>`, `type <text>`, `press [sel] <key>` | text and keys (`Enter`, `Meta+a`); `fill` also sets date, time, range, and color inputs |
| `select <sel> <value>`, `check <sel>`, `uncheck <sel>` | form controls |
| `drag <source> <target>` | drag and drop (HTML5 or mouse-based, chosen automatically); `drag 400,300 600,420` for canvas apps |
| `wait download [ms] [forget]` | after clicking a download link: wait for the file, print its path; `forget` removes it from Arc's download list |
| `upload <sel> <path...>` | set a file input (hidden inputs work; a label or wrapper also works) |
| `scroll <dy> [sel]`, `wait <sel\|ms\|url:part\|gone:sel>` | scroll the page or the scroll container under `sel`; wait for a condition |
| `accept [text]` | accept the next confirm/prompt; put it before the action |
| `eval <js>` | run a JS expression in the page, print the result |
| `shot [full]` | screenshot path (JPEG, CSS pixels, so image x,y = mouse x,y); view it with Read |
| `open <url>`, `use p2`, `pages`, `tabs`, `adopt [tabId]`, `close` | pages and tabs |
| `finish [keep...]` | end the task: closes tabs Claude opened |

Action commands print `ok` unless something notable happened (`popup p2`,
`confirm "Delete?" dismissed`). Popups become the current page.

`fill` understands code and rich-text editors (Monaco, CodeMirror, Ace, Quill,
ProseMirror/TipTap, Lexical, CKEditor 5, TinyMCE). Target the editor or any
element inside it; the text is set through the editor's own API, so newlines
and indentation stay exact. If the editor ends up with other text, `fill`
prints what it holds. `text` appends the full content of visible code editors,
including lines that are scrolled out of view.

## Save tokens

- To locate one thing, use `find`. After an action, use `-s` (a diff), not
  `snap`. To read content, use `text` or `text <sel>`, not a snapshot.
- Refs (`@12`) stay valid while the element exists; navigation resets them.
- `find` sees only rendered elements. For feeds and virtualized lists, use
  `seek "Invoice 1234"`: it scrolls the list until the match renders.
- If `find` says a modal is open, close it before looking further.
- Each task belongs to the Claude session that created it. Use your own id.

## Snapshot format

```
Title | url | 1680x1050 y=0/3199
@7 searchbox "Search Wikipedia"
@24 h1 "Welcome to Wikipedia"
 the [free](@26) encyclopedia that [anyone can edit](@27).
@12 link "Log in" →/w/index.php?title=Special:UserLogin
@4 checkbox "Newsletter" [checked]
@3 textbox "Email" ="ada@x.co"
```

One space of indent is one level of nesting. `[text](@N)` is an inline link or
button. Diffs print `~` for an element whose state changed, `+` for new lines,
and `-` for removed lines. `-s` waits for the DOM to settle before diffing.

Cross-origin iframes (embedded tools, payment fields, LTI apps in Canvas) are
stitched into the snapshot. Their refs carry the frame ref: `@24.1` is element
1 inside frame `@24`. Use them like any ref. `find` searches all frames.
`@24 >> text=Submit` scopes a selector to a frame; `text @24` and
`eval @24 <js>` run inside it; `snap @24` shows only that frame.

## Selectors

`@12`, `text=Sign in` (substring, any case), `text="Sign in"` (exact),
`role=button[name="Sign in"]`, `role=link[name*="docs"]` (also `^=` and `$=`; textbox, searchbox,
and combobox match one another), `loc=href:/pricing`, `xpath=...`,
`css=.card:has-text("Pro")`, raw CSS (includes open and closed shadow roots
and same-origin iframes), and a `>> nth=0` suffix. An ambiguous selector fails and
lists the candidates with refs.

## Scripts (loops, extraction, complex logic)

```bash
claude4arc run 7 <<'EOF'
const rows = await page.evaluate(() => [...document.querySelectorAll("tr")].map((r) => r.innerText));
console.log(rows.slice(0, 20).join("\n"));
EOF
```

Do not sleep for a fixed time between actions (`setTimeout`, `waitForTimeout`):
`click`, `fill`, and `goto` return once the page has reacted, and dialogs are
handled for you. When you need a result, wait for the condition itself, with a
short timeout:

```js
await page.click(button);
await page.waitForFunction((label) => document.querySelector(`[aria-label="${label}"]`), label, { timeout: 3000 });
```

With a task id, `t` (task) and `page` (current page) are predefined. Without
one, use `const t = await task("name")` or `await task(7)`. Page methods:
`goto, snapshot({scope, root, diff}), find, seek(sel, {container, max, timeout, direction}), text, click, fill, press, check,
selectOption, setInputFiles, hover, dragAndDrop, scroll, waitForURL,
waitForSelector, waitForFunction, evaluate(fn, arg), fetch(url, {saveAs}),
screenshot, bringToFront, acceptDialog, dismissDialog, mouse.*, keyboard.*,
cdp(method, params)`. Task methods: `page(label), newPage({url}), tabs(),
userTab(), adopt(tab), finish({keep})`. `claude4arc help` has signatures.

## Arc behavior

- Background tabs work for everything: input, snapshots, screenshots.
- In tabs Claude opens, `alert`/`confirm`/`prompt` never appear on the user's
  screen. They are answered in the page and reported in the output. Confirms
  and prompts are dismissed by default. To accept one, arm it before the
  action: `accept -- click @9` or `accept "Ada" -- click @9`.
- New windows never pop up. In background tabs, `target=_blank` links and
  `window.open` open as a new background page (`popup p2 (link)`), and forms
  that target a new window load in the current tab (`navigated → url`).
  Sign-in popups that talk back to their opener (OAuth) work: the popup page
  gets a relayed `window.opener`, so `postMessage` and `window.close()` reach
  the original page.
- `adopt` takes over the tab the user is looking at. Never close, navigate, or
  submit in a user tab unless the user asked for it. `finish` only releases it.

- Agent tabs are muted and sealed off from the user's machine: clipboard
  writes are reported as `copied (kept off the user's clipboard): "..."`, and
  print/share/fullscreen/permission prompts/file pickers/`mailto:` links are
  reported as `blocked ...`. Use `upload` for files; answer permission needs
  by asking the user.
- PDFs: `text` extracts the whole document; `shot` shows a page.

## App notes

- Google Docs/Sheets/Slides draw on a canvas: `text` returns the real content
  through Google's export (Sheets as CSV). To edit a Doc, click the page
  (`click css=.kix-page-paginated >> nth=0`) and `type`. In Sheets, jump with
  the Name Box (`fill css=#t-name-box B2 -- press css=#t-name-box Enter`) and
  `type` with `\t` between cells and `\n` between rows.
- Apps that fade their toolbar while you type (Notion) hide those controls
  from `find`; move the mouse first: `hover 900,20 -- find actions`.
- In private apps (mail, docs), scope reads to what the task needs:
  `snap css=[role=dialog]`, `text @12`, exact role selectors. Do not dump
  inboxes or document lists into the conversation.

## Safety and hand-off

- Confirm with the user before you send messages, post, buy, delete data, or
  change account settings.
- Sites on the user's blocklist are off limits. Commands there fail with
  "is on the claude4arc blocklist": stop and tell the user. Never run
  `claude4arc block` or `unblock` unless the user asks.
- Hand over to the user for their passwords, 2FA, CAPTCHAs, and permission
  prompts. Tell them what to do in Arc, then continue with the same task id.
- When done, run `finish` once. Keep a page only when the user must see the
  result: `finish p2`.
