# arc-browser

Lets Claude Code control your real Arc browser: your tabs, your logged-in
sessions, your cookies. It works like ego-lite, but for Arc.

```
Claude Code ──bash──▶ arc-browser CLI ──unix socket──▶ native host ──native messaging──▶ Arc extension ──chrome.debugger──▶ tab
```

- **Extension** (`extension/`): a thin MV3 extension with the `debugger`,
  `tabs`, and `nativeMessaging` permissions. It forwards an allow-listed set of
  tab, window, and DevTools Protocol calls.
- **Native host** (`host/host.js`): Arc starts it when the extension connects.
  It relays requests between `~/.arc-bridge/bridge.sock` (mode 0600) and the
  extension.
- **CLI** (`bin/arc-browser.js`, `lib/`): runs Node scripts against a small Page
  API (snapshots with refs, trusted mouse and keyboard input, screenshots,
  dialogs, popups, uploads).
- **Skill** (`skill/SKILL.md`): teaches Claude the API. `install` links it to
  `~/.claude/skills/arc-browser`.

No dependencies. Requires Node 22 or later.

## Install

```bash
npm link
arc-browser install
```

Then load the extension once in Arc:

1. Open `arc://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

Check the result:

```bash
arc-browser doctor
arc-browser status
```

### Why the manifest goes in Google Chrome's folder

Arc reads native messaging host manifests from
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, not from
its own `Arc/User Data` folder. `arc-browser install` writes
`com.arcforclaude.bridge.json` there. The manifest allows only this extension's
ID (`bfbcdjkeonepklbmjjghoddpahhhnimp`, fixed by the `key` in the manifest).

## Use

Ask Claude to do something in Arc. The skill loads, and Claude runs short
commands:

```bash
arc-browser new news.ycombinator.com          # task 7 p1 | Hacker News | https://...
arc-browser 7 find comments                   # @41 link "311 comments" →item?id=...
arc-browser 7 click @41 -s                    # click, then print what changed
arc-browser 7 fill @3 hi -- press Enter -- wait url:/search
arc-browser 7 finish
```

Scripts cover loops and extraction: `arc-browser run 7 <<'EOF' ... EOF`, with
`t` and `page` predefined. `arc-browser help` prints the full API.

## Speed

Typical latency, including the Node start of the CLI:

| Operation | Time |
|---|---|
| `snap`, `find`, `text`, `eval` | 70–130 ms |
| `click`, `fill`, `check` in a background tab | 150–250 ms |
| 8-step form chain in one command | about 600 ms |
| `new <url>` (Arc creates the tab) | 0.6–1.5 s |

Arc does not render hidden tabs, so it holds their input events. The CLI sends
a 1×1 capture request whenever an input event is not acknowledged within
20 ms. The capture produces a frame and releases the event. The debugger stays
attached between commands, and navigation waits use DevTools events instead of
polling.

## Behavior in Arc

- Claude works in background tabs in your current space by default. Input,
  snapshots, and screenshots work there without switching tabs.
- Arc does not open new tabs from a background tab. `click()` on a
  `target=_blank` link opens the URL as a new page instead. For popups from
  `window.open()`, Claude calls `page.bringToFront()` first.
- In tabs Claude opens, `alert`, `confirm`, and `prompt` are answered inside
  the page, so no dialog appears on your screen. Confirms and prompts default
  to cancel; Claude arms `accept` before an action when it means to accept.
  The host dismisses any native dialog that still gets through. Tabs you own
  keep normal dialogs.
- Arc shows no debugging bar. The debugger stays attached to Claude's tabs
  between commands and is released by `finish`, `close`, or closing the tab.
- `finish()` closes only the tabs that Claude opened. Tabs you own are
  released, never closed.

## Security

Any process running as your user can connect to the socket and control Arc
with your sessions. This is the same trust model as ego-lite and Claude in
Chrome. Remove access with `arc-browser uninstall` and by removing the
extension.

## Uninstall

```bash
arc-browser uninstall
npm unlink -g arc-browser
```

Then remove "Arc for Claude" in `arc://extensions`.
