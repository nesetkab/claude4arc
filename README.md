# claude4arc

Let [Claude Code](https://docs.claude.com/en/docs/claude-code) use your real
[Arc](https://arc.net) browser: your tabs, your logged-in sessions, your
cookies. Claude works in background tabs, so it does not take over your
screen, steal focus, or show dialogs.

![claude4arc compared with ego-lite and Claude for Chrome](bench/figures/benchmark.png)

On the same 14 browser tasks with the same model, a Claude Code agent finished
in about 50 s with claude4arc, 195 s with ego-lite, and 320 s with Claude for
Chrome. It read about 10 times fewer tokens than with ego-lite and 26 times
fewer than with Claude for Chrome. See [bench/](bench/README.md) for
the method and its limits.

## Requirements

- macOS
- [Arc](https://arc.net)
- [Node.js](https://nodejs.org) 22 or later
- [Claude Code](https://docs.claude.com/en/docs/claude-code)

No npm dependencies.

## Install

```bash
git clone https://github.com/nesetkab/claude4arc.git
cd claude4arc
npm link
claude4arc install
```

`claude4arc install` does three things:

1. It writes a small launcher to `~/.arc-bridge/host-launcher.sh`.
2. It registers the native messaging host `com.arcforclaude.bridge` in
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. Arc
   reads native hosts from Chrome's folder, not from its own.
3. It links the Claude skill to `~/.claude/skills/claude4arc`.

Then load the extension in Arc once:

1. Open `arc://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder of this repo.

Check that everything works:

```bash
claude4arc doctor
```

Every line should start with `ok`. Start a new Claude Code session so that it
loads the skill.

## Use

Ask Claude to do something in Arc, for example "open my GitHub notifications
in Arc and summarize them". The skill loads by itself, and Claude runs short
commands like these:

```bash
claude4arc new news.ycombinator.com        # task 7 p1 | Hacker News | https://...
claude4arc 7 find comments                 # @41 link "311 comments" →item?id=...
claude4arc 7 click @41 -s                  # click, then print what changed
claude4arc 7 fill "text=Email" ada@example.com -- click "text=Sign up" -s
claude4arc 7 section "Return value"        # read one section of a document
claude4arc 7 finish                        # close the tabs Claude opened
```

For several tasks, `batch` runs one command chain per line in a single call.
It prints the start and end time of each line, keeps going after a failure,
and closes its tabs at the end:

```bash
claude4arc batch <<'EOF'
form: goto https://example.com/signup -- fill "text=Name" Ada -- check "text=I agree" -- click "text=Submit" -s
docs: goto https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/at -- section "Return value"
EOF
```

`claude4arc run` executes a Node script against the Page API for loops and
extraction. `claude4arc help` prints the full API, and
[skill/SKILL.md](skill/SKILL.md) is what Claude reads.

## How it works

```
Claude Code ─bash─▶ claude4arc CLI ─unix socket─▶ native host ─native messaging─▶ extension ─chrome.debugger─▶ tab
```

- **Extension** (`extension/`): an MV3 extension with the `debugger`, `tabs`,
  `downloads`, and `nativeMessaging` permissions. It forwards an allow-listed
  set of tab, window, download, and DevTools Protocol calls. Its `key` fixes
  the extension ID to `bfbcdjkeonepklbmjjghoddpahhhnimp`, which the native
  host manifest allows.
- **Native host** (`host/host.js`): Arc starts it when the extension connects.
  It relays requests between the socket `~/.arc-bridge/bridge.sock` (mode
  0600) and the extension, and keeps per-tab state such as dialogs and frame
  sessions.
- **CLI** (`bin/claude4arc.js`, `lib/`): a Page API with compact snapshots and
  refs, trusted mouse and keyboard input, screenshots, dialogs, popups,
  uploads, downloads, and editors.
- **Skill** (`skill/SKILL.md`): teaches Claude the commands and how to use
  them with few tool calls.

Two internal names come from the first version and stay the same so that
existing installs keep working: the native host `com.arcforclaude.bridge` and
the state folder `~/.arc-bridge` (socket, host log, task records,
screenshots).

## Behavior in Arc

- Claude opens its own background tabs in your current space. Input,
  snapshots, and screenshots work there without switching tabs.
- New windows never pop up. `target=_blank` links and `window.open` become new
  background pages. For OAuth popups, `window.opener.postMessage` and
  `window.close()` are relayed back to the opening page.
- `alert`, `confirm`, and `prompt` are answered inside the page, so no dialog
  appears on your screen. Confirms default to cancel; Claude accepts one only
  when it arms `accept` first.
- Claude's tabs are muted. Clipboard writes stay inside the page. Print,
  share, fullscreen, permission prompts, native file pickers, and external
  app links (`mailto:`, `zoom:`) are blocked and reported.
- Cross-origin iframes, open and closed shadow roots, virtual lists, and code
  or rich-text editors (Monaco, CodeMirror, Ace, Quill, ProseMirror, Lexical,
  CKEditor, TinyMCE) work.
- Google Docs and Sheets are read through Google's own export, and PDFs
  through macOS PDFKit.
- `finish` closes only the tabs that Claude opened. Tabs you hand over with
  `adopt` are released, never closed.
- Each task belongs to the Claude Code session that created it, so parallel
  sessions do not interfere with each other. Set `CLAUDE4ARC_ANY_TASK=1` to
  use a task from another session.

## Security

Any process that runs as your macOS user can connect to the socket and control
Arc with your logged-in sessions. This is the same trust model as other local
browser agents. Only install claude4arc on a machine you trust, and review
what Claude does in sensitive accounts.

The skill tells Claude to ask you before it sends messages, posts, buys,
deletes data, or changes account settings, and to hand over to you for
passwords, 2FA, and CAPTCHAs.

To remove access, run `claude4arc uninstall` and remove the extension in
`arc://extensions`.

## Troubleshooting

`claude4arc doctor` names the failing part. Common fixes:

| Symptom | Fix |
|---|---|
| `Arc bridge is not running` | Open Arc, and check that the claude4arc extension is on in `arc://extensions`. |
| `bridge socket` fails | Click the reload icon of the extension in `arc://extensions`. |
| `native host manifest` fails | Run `claude4arc install` again. |
| It stopped working after a Node upgrade | Run `claude4arc install` again: the launcher records the path to `node`. |
| Claude does not use the tool | Start a new Claude Code session, and check that `~/.claude/skills/claude4arc` exists. |

## Update

```bash
git pull
npm link
claude4arc install
claude4arc reload-extension
```

`npm link` and `install` are only needed when the command or the skill
changed, but they are safe to run every time.

The project was first called `arc-browser`. If you installed it under that
name, run `npm rm -g arc-browser` once, then the steps above. `install`
removes the old `~/.claude/skills/arc-browser` link.

## Tests

The tests drive real Arc tabs against local fixture pages:

```bash
node tests/run.js              # all scenarios, fixtures on 127.0.0.1:8811-8812
node tests/run.js iframe -v    # filter by name, print each command and its time
```

## Uninstall

```bash
claude4arc uninstall
npm unlink -g claude4arc
```

Then remove the claude4arc extension in `arc://extensions`. To also delete
the task records, logs, and screenshots, run `rm -rf ~/.arc-bridge`.

## License

[MIT](LICENSE)
