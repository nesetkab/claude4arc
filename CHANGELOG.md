# Changelog

## Unreleased

### Added

- Linux support. `install`, `doctor`, and `uninstall` know the native host
  folders of Chrome, Chromium, Brave, Edge, and Chrome for Testing, and the
  host finds its browser through `/proc`. PDFs are read with `pdftotext`.
- CI runs the browser suite in headless Chrome for Testing on macOS and
  Linux, on every push. Chrome for Testing is a supported browser.
- Browser tests for Lexical, ProseMirror, CKEditor 5, TinyMCE, Ace,
  CodeMirror 5, batch mode, and paste.
- A held-out benchmark rerun at 0.6: 88.7 s, 7.7 tool calls, and 0.33 M
  tokens read, down from 117.1 s, 8.0, and 0.48 M.

### Changed

- `install` pins a Node path that `brew upgrade` keeps, and the launcher
  falls back to another Node 22 or newer if the pinned one is gone.
- The editor helper uses the same locked slot as the in-page helper.
- `~/.arc-bridge/page-secret` is created on first use, not on import.

### Fixed

- New-tab links and `window.open` did nothing on a user tab in the
  background. They now open a background tab, also after a dialog.
- The first paste in a tab could insert nothing. Paste checks the result,
  retries, and falls back to inserting the text.
- Paste lost images and rich text on the clipboard. It restores every type.
- Plain ProseMirror editors were filled through the keyboard instead of
  their own API.
- Filling an editor without an API used `Meta+a` on Linux.

## 0.6.0 (2026-10-11)

### Changed

- `new [url] [name]` always creates a task, so an all-digit name like `3` is
  a name, not a task id. `<id>` commands always resume.
- `claude4arc install` pins the Node that runs it instead of the first `node`
  on the login shell's PATH. `doctor` checks the pinned Node's version.
- A second host for the same browser, such as one from another profile, waits
  for the first to exit instead of taking over its socket.
- Commands that send input are not retried after a detach once input went out;
  the error says the command may already have taken effect.
- The in-page helper lives in a locked, non-enumerable slot that only the CLI
  can open, so a page can no longer replace it.

### Fixed

- Output over 64 KB was cut off when piped, including into Claude Code's Bash
  tool.
- A navigation slower than its timeout crashed the CLI instead of throwing.
- `seek` could loop forever on a list that grew once and then stopped.
- A call made after the browser or extension went away never settled, and the
  CLI exited 0 with no output.
- `waitForEvent("popup")` never resolved on Claude's own tabs, and a popup from
  an adopted tab got two labels.
- `type` failed on emoji and other characters outside the US keyboard.
- `press Shift+a` typed `a`, and a bad chord like `Meta+Foo` left Meta held.
- `press` and `focus` on an element inside a frame clicked it first, so Enter
  on a frame's button activated it twice.
- Checkboxes, switches, and radios drawn over an `opacity: 0` input (MUI,
  Bootstrap) counted as hidden.
- Paging through results could click a carousel or wizard "Next" button.
- `links` and `loc=href:` failed on pages with links inside an SVG.
- `:has-text()` and `:text-is()` failed after a combinator such as `ul >`, and
  when chained.
- Snapshots dropped repeated text in sibling cells, so `Yes Yes No` read
  `Yes No`.
- Role names longer than 100 characters never matched.
- `table <ref>` on something that is not a table read some other table.
- `aria-labelledby` inside shadow DOM, closed shadow roots on custom elements
  defined late, and `text` under a strict style CSP now work.
- Concurrent commands could lose tasks, reuse a label, or bring back a finished
  task. Writes to `tasks.json` now hold a lock, and an unreadable file is kept
  as `tasks.json.bad-*` instead of being wiped.
- Closing a tab could leave `tasks.json.*.tmp` files behind.
- A batch line ending in `finish` skipped cleanup when an earlier step failed.
- `drag x,y x,y` on a draggable element did nothing.
- CodeMirror 6 fill failed on text with `\r\n`.
- `fetch` ignored a timeout over 60 seconds, and `saveAs` saved error pages.
- Warnings printed twice, and `wait` with no argument crashed.
- A malformed request, a message over the browser's 1 MB limit, or another
  debugger on the tab could crash or drop the host.
- Install paths containing `$`, quotes, or backslashes broke the launcher.

## 0.5.0 (2026-09-26)

### Added

- Support for Dia, Google Chrome, Brave, Microsoft Edge, and Chromium next to
  Arc. Each browser runs its own bridge; `CLAUDE4ARC_BROWSER` selects one, and
  a task stays in the browser where it started.
- A site blocklist: `claude4arc block`, `unblock`, and `blocked`. The CLI
  refuses blocked sites, and the host sends Claude's tabs away from them.
- `claude4arc clean`. Screenshots older than one day are deleted automatically
  (at most 100 are kept), stale temporary files are removed, and the host log
  rotates at 512 KB.
- A Claude Code plugin and marketplace:
  `claude plugin marketplace add nesetkab/claude4arc`.
- Published on npm: `npm install -g claude4arc`.
- `claude4arc install --no-skill` (for plugin users) and
  `--extension-id <id>` (for a Chrome Web Store build).
- A Chrome Web Store package (`npm run package:extension`), extension icons,
  a privacy policy, and a store listing guide.
- Unit tests (`npm test`) and GitHub Actions CI on macOS and Linux.
- A held-out benchmark with tasks that claude4arc was not tuned on.

### Changed

- The skill is 40% smaller with the same rules.
- `lib/page.js` is split into `util`, `shim`, `frames`, and `input` modules.

### Fixed

- `goto localhost:3000` treated `localhost:` as a URL scheme.
- A click target under a fixed header is scrolled clear before the click.
- `fill "text=…"` that matches plain text falls back to the textbox labelled
  with those words.
- A target clipped inside a scrolling container, such as a modal body, is
  scrolled into view before a click or check.
- `:has-text()` and `:text-is()` work anywhere in a CSS selector, for example
  `css=tr:has-text("Paper clips") button`.
- A selector that matches only hidden elements names the tab or section to
  open first.
- `seek` pages through paginated lists (Next buttons in a pager) when there is
  nothing to scroll.

## 0.4.0 (2026-09-26)

- Renamed from `arc-browser` to `claude4arc`, with an upgrade path for the old
  command, skill link, and environment variable.
- `claude4arc batch`: one command chain per line, per-line timing, and an
  automatic finish.
- `section <heading>` reads one part of a document.
- A faster `seek` for virtual lists.
- Selectors search cross-origin frames when the page has no match, labels
  target their controls, and ambiguous `text=` selectors prefer the exact or
  the only interactive match.
- A missed `text` selector falls back to the main text.
- Benchmark against ego-lite and Claude for Chrome.

## 0.3.0 (2026-09-25)

- Agent tabs are sealed off from the user's machine: muted, a private
  clipboard, and blocked print, share, fullscreen, permission prompts, file
  pickers, and external links.
- OAuth popups work through a relayed `window.opener`.
- Downloads, PDFs (through PDFKit), and Google Docs and Sheets (through
  Google's export).
- Pipelined input: typing is about 10 times faster in background tabs.
- `table`, `links`, coordinate clicks and drags, and container-aware scroll.

## 0.1.0 (2026-09-24)

- First version as `arc-browser`: the MV3 extension, the native messaging
  host, the CLI with compact snapshots and refs, and the Claude skill.
- Cross-origin iframes, editors (Monaco, CodeMirror, and others), HTML5 drag
  and drop, virtual lists, and closed shadow roots.
- Dialogs never reach the user's screen, and new windows open as background
  pages.
