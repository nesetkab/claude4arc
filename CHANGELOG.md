# Changelog

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
- Install with npm from GitHub: `npm install -g github:nesetkab/claude4arc`.
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
