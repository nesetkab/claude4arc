---
name: claude4arc
description: Control the user's real Arc browser (their logged-in sessions, cookies, and open tabs) through the claude4arc CLI. Use when the user mentions Arc, asks you to do something "in my browser", or needs a site where they are already signed in. Opens and operates websites, fills forms, clicks, types, takes screenshots, extracts page data, and works with the user's existing tabs.
---

# claude4arc

Drives the user's own Arc (real profile, trusted input) in background tabs, so
the user is not interrupted. Set `CLAUDE4ARC_BROWSER=dia` (or `chrome`,
`brave`, `edge`, `chromium`) only when the user names another browser. If a
command fails with "bridge is not running", run `claude4arc doctor` and relay
its output.

## Speed rules (each tool call costs seconds; the browser is fast)

- Do not look before you act. Guess selectors from the task's words:
  `text=Save`, `role=button[name="Sign in"]`, or a field's label
  (`fill "text=Full name" Ada`, `select text=Country Spain`). Selectors also
  search cross-origin iframes. Only when a guess fails, `find <words>`.
- Several tasks: do ALL of them in ONE `claude4arc batch` call. One chain per
  line, optional `label:` prefix. Each line prints
  `== label ok|FAILED <start ms>-<end ms>` and its output; a failure does not
  stop later lines, and the tab closes at the end (no `new`, `finish`, ids, or
  timestamp commands needed). Then retry only the failed lines.

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
  EOF
  ```

  All of these work blind: a popup becomes the current page, `fill` handles
  code editors and iframe fields, `drag` handles HTML5 and mouse lists (drop on
  the first item to move to the top), menus open on `click`, `seek` scrolls
  virtual lists and pages through paginated ones, and `click` waits up to 5 s
  for late content. If a target is in a hidden tab or wizard step, the error
  names the tab or step to open first.
- One task: open and act in one call, `claude4arc new <url> -- fill … -- click … -s`,
  then reuse it with `claude4arc 7 goto …` and `finish` once at the end.
- Read with `section <heading>`, plain `text` (main content), or `text <sel>`.
  A guessed CSS selector often misses; a missed `text` selector falls back to
  the main text.
- Trust receipts: `ok`, `popup p2`, `confirm "…" accepted`, `navigated → …`,
  or a `-s` diff confirm the step. Do not re-check with `eval` or `snap`.
- Quote selectors that contain `[`, `]`, spaces, or `*`.

## Commands

```bash
claude4arc new <url> [-- <cmd> ...] [-s]  # new task, act right away; -s appends a diff snapshot
claude4arc 7 <cmd> [args] [-- <cmd> ...]  # run on task 7's current page (7:p2 for page p2)
claude4arc batch [7] [--keep] <<'EOF'     # one chain per line
```

| Command | Does |
|---|---|
| `find <words>` | matching elements on the page and in frames, with refs |
| `snap` / `snap full` / `snap @12`, `diff` | snapshot of the viewport, the page, or a subtree; changes since the last one |
| `text [sel] [chars]`, `text all`, `section <heading>` | readable text of `<main>`, an element, the page, or one section |
| `table [sel]`, `links [words]` | a table as tab-separated rows; links with full URLs |
| `seek <sel\|words> [container]` | scroll a feed or virtual list until a match renders |
| `goto <url>`, `back`, `forward`, `reload` | navigate and wait for load |
| `click <sel>`, `dblclick`, `hover` | trusted pointer input; `click 420,260` uses screenshot coordinates |
| `fill <sel> <text>`, `type <text>`, `press [sel] <key>` | text and keys (`Enter`, `Meta+a`); `fill` sets editors and date, range, and color inputs |
| `select <sel> <value>`, `check`, `uncheck`, `upload <sel> <path...>` | form controls |
| `drag <from> <to>` | drag and drop; `drag 400,300 600,420` for canvas apps |
| `accept [text]` | accept the next confirm or prompt; put it before the action |
| `wait <sel\|ms\|url:part\|gone:sel>`, `wait download` | wait for a condition or a download (prints its path) |
| `scroll <dy> [sel]`, `eval [@frame] <js>`, `shot [full]` | scroll; run JS; screenshot path (image x,y = mouse x,y) |
| `open <url>`, `use p2`, `pages`, `tabs`, `adopt [tabId]`, `close`, `finish [keep...]` | pages and tabs; `finish` closes only Claude's tabs |

`fill` sets Monaco, CodeMirror, Ace, Quill, ProseMirror, Lexical, CKEditor, and
TinyMCE through their own APIs, so newlines and indentation stay exact.

## Snapshots and selectors

```
Title | url | 1680x1050 y=0/3199
@24 h1 "Welcome"
 the [free](@26) encyclopedia
@4 checkbox "Newsletter" [checked]
@3 textbox "Email" ="ada@x.co"
@9 iframe "Checkout" (cross-origin)
 @9.1 textbox "Card number"
```

One space of indent is one level of nesting; `[text](@N)` is an inline link.
Diffs mark `~` changed, `+` new, `-` gone. Refs stay valid until navigation.
`@9.1` is element 1 in frame `@9`; `@9 >> text=Pay` scopes a selector to it.

Selectors: `@12`, `text=Sign in` (substring, any case), `text="Sign in"`
(exact), `role=link[name*="docs"]` (also `=`, `^=`, `$=`), `loc=href:/pricing`,
`xpath=…`, `css=.card:has-text("Pro")`, raw CSS (includes shadow roots), and a
`>> nth=0` suffix. An ambiguous selector fails and lists candidates.

## Scripts

`claude4arc run 7 <<'EOF' … EOF` runs Node with `t` (task) and `page`
predefined; `claude4arc help` lists the Page API. Do not sleep a fixed time
between actions: they return once the page reacts. Wait for a condition:
`await page.waitForFunction(() => …, undefined, { timeout: 3000 })`.

## Behavior

- `alert`/`confirm`/`prompt` never reach the user's screen; confirms are
  dismissed unless you arm `accept` first.
- `target=_blank` and `window.open` open a background page (`popup p2`);
  OAuth popups can talk to their opener.
- Claude's tabs are muted. Clipboard writes stay in the page; print, share,
  permission prompts, file pickers, and `mailto:` links are blocked and
  reported. Use `upload` for files.
- `adopt` takes over the user's current tab. Never close, navigate, or submit
  there unless asked; `finish` only releases it.
- Google Docs and Sheets: `text` returns the real content. To edit a Doc,
  `click css=.kix-page-paginated >> nth=0` and `type`. In Sheets, go to a cell
  with `fill css=#t-name-box B2 -- press css=#t-name-box Enter`, then `type`
  with `\t` between cells and `\n` between rows. PDFs: `text` reads them.
- Notion-style toolbars hide while typing: `hover 900,20` first.
- In mail and documents, read only what the task needs; do not dump inboxes.

## Safety

- Ask the user before you send messages, post, buy, delete data, or change
  account settings.
- A command that fails with "is on the claude4arc blocklist" is off limits:
  stop and tell the user. Never run `claude4arc block` or `unblock` yourself.
- Hand over passwords, 2FA, CAPTCHAs, and permission prompts to the user, then
  continue with the same task id.
- Use only the task ids you created. Run `finish` once at the end; `finish p2`
  keeps a page open for the user.
