---
name: arc-browser
description: Control the user's real Arc browser (their logged-in sessions, cookies, and open tabs) through the arc-browser CLI. Use when the user mentions Arc, asks you to do something "in my browser", or needs a site where they are already signed in. Opens and operates websites, fills forms, clicks, types, takes screenshots, extracts page data, and works with the user's existing tabs.
---

# arc-browser

Drives the user's own Arc (real profile, trusted input events) through a local
extension. Work happens in background tabs, so the user is not interrupted.
If a command fails with "Arc bridge is not running", run `arc-browser doctor`
and relay its output.

## Commands (default: use these)

```bash
arc-browser new <url> [-s]              # new task; prints "task 7 p1 | title | url"
arc-browser 7 <cmd> [args]              # run on the task's current page
arc-browser 7:p2 <cmd> [args]           # run on page p2 (and make it current)
arc-browser 7 fill @3 hi -- click @4 -s # chain with "--"; -s appends a diff snapshot
```

| Command | Does |
|---|---|
| `snap` / `snap full` / `snap @12` | viewport / whole page / one subtree snapshot |
| `diff` | only what changed since the last snapshot of this page |
| `find <words>` | matching elements anywhere on the page, with refs |
| `seek <sel\|words> [container]` | scroll a feed or virtualized list until a match renders; prints its ref |
| `text [chars]` | readable text of `<main>` (default 8000 chars) |
| `goto <url>`, `back`, `forward`, `reload` | navigate and wait for load |
| `click <sel>`, `dblclick`, `hover` | trusted pointer input; scrolls into view |
| `fill <sel> <text>`, `type <text>`, `press [sel] <key>` | text and keys (`Enter`, `Meta+a`) |
| `select <sel> <value>`, `check <sel>`, `uncheck <sel>` | form controls |
| `upload <sel> <path...>` | set a file input |
| `scroll <dy>`, `wait <sel\|ms\|url:part\|gone:sel>` | scroll; wait for a condition |
| `accept [text]` | accept the next confirm/prompt; put it before the action |
| `eval <js>` | run a JS expression in the page, print the result |
| `shot [full]` | screenshot PNG path (CSS pixels); view it with Read |
| `open <url>`, `use p2`, `pages`, `tabs`, `adopt [tabId]`, `close` | pages and tabs |
| `finish [keep...]` | end the task: closes tabs Claude opened |

Action commands print `ok` unless something notable happened (`popup p2`,
`confirm "Delete?" dismissed`). Popups become the current page.

## Save tokens and time

- Do not snapshot by reflex. To locate one thing, use `find`. After an action,
  use `-s` (diff) instead of a full `snap`. To read content, use `text`.
- Chain every step you can already decide: `fill @3 x -- fill @4 y -- click @5 -s`.
- Use `wait url:/done` or `wait <sel>` instead of fixed delays.
- Refs (`@12`) stay valid while the element exists. After navigation, refs reset.
- `find` sees only rendered elements. For infinite feeds and virtualized lists
  (Gmail, X, large tables), use `seek "Invoice 1234"` or `seek #row-99 #list`: it
  wheels the list container step by step until the match renders, then prints
  its ref. Bare words are text; use `css=tag` for a tag name.
- Use one task per user goal and reuse its pages with `goto`.

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
`role=button[name="Sign in"]`, `role=link[name*="docs"]` (textbox, searchbox,
and combobox match one another), `loc=href:/pricing`, `xpath=...`,
`css=.card:has-text("Pro")`, raw CSS (includes open and closed shadow roots
and same-origin iframes), and a `>> nth=0` suffix. An ambiguous selector fails and
lists the candidates with refs.

## Scripts (loops, extraction, complex logic)

```bash
arc-browser run 7 <<'EOF'
const rows = await page.evaluate(() => [...document.querySelectorAll("tr")].map((r) => r.innerText));
console.log(rows.slice(0, 20).join("\n"));
EOF
```

With a task id, `t` (task) and `page` (current page) are predefined. Without
one, use `const t = await task("name")` or `await task(7)`. Page methods:
`goto, snapshot({scope, root, diff}), find, seek(sel, {container, max, timeout, direction}), text, click, fill, press, check,
selectOption, setInputFiles, hover, dragAndDrop, scroll, waitForURL,
waitForSelector, waitForFunction, evaluate(fn, arg), fetch(url, {saveAs}),
screenshot, bringToFront, acceptDialog, dismissDialog, mouse.*, keyboard.*,
cdp(method, params)`. Task methods: `page(label), newPage({url}), tabs(),
userTab(), adopt(tab), finish({keep})`. `arc-browser help` has signatures.

## Arc behavior

- Background tabs work for everything: input, snapshots, screenshots.
- In tabs Claude opens, `alert`/`confirm`/`prompt` never appear on the user's
  screen. They are answered in the page and reported in the output. Confirms
  and prompts are dismissed by default. To accept one, arm it before the
  action: `accept -- click @9` or `accept "Ada" -- click @9`.
- New windows never pop up. In background tabs, `target=_blank` links and
  `window.open` open as a new background page (`popup p2 (link)`), and forms
  that target a new window load in the current tab (`navigated → url`).
  `window.open` flows that talk back to their opener (some OAuth popups) cannot
  work this way; try the site's redirect login, or ask the user.
- `adopt` takes over the tab the user is looking at. Never close, navigate, or
  submit in a user tab unless the user asked for it. `finish` only releases it.

## Safety and hand-off

- Confirm with the user before you send messages, post, buy, delete data, or
  change account settings.
- Hand over to the user for their passwords, 2FA, CAPTCHAs, and permission
  prompts. Tell them what to do in Arc, then continue with the same task id.
- When done, run `finish` once. Keep a page only when the user must see the
  result: `finish p2`.
