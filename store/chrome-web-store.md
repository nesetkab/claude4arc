# Chrome Web Store submission

Arc, Dia, Chrome, Brave, and Edge can all install extensions from the Chrome
Web Store. A store listing lets people install claude4arc without developer
mode.

## Steps

1. Build the package: `npm run package:extension`. This writes
   `dist/claude4arc-extension-<version>.zip` without the manifest `key`, which
   the store does not accept.
2. Register a developer account at
   https://chrome.google.com/webstore/devconsole (one-time fee).
3. Click **New item**, upload the zip, and fill in the listing below.
4. After the store publishes the item, it shows the item's extension ID.
   Users of the store version run
   `claude4arc install --extension-id <store id>` so that the native host
   accepts that ID. Add the ID to the README install steps.

## Listing

- **Name:** claude4arc
- **Summary (132 characters max):** Lets Claude Code use your browser in
  background tabs, through a local bridge. Requires the claude4arc CLI.
- **Category:** Developer Tools
- **Language:** English
- **Icon:** `extension/icons/icon-128.png`
- **Homepage:** https://github.com/nesetkab/claude4arc
- **Privacy policy:** https://github.com/nesetkab/claude4arc/blob/main/PRIVACY.md

### Description

claude4arc lets Claude Code, Anthropic's coding agent, use your real browser:
your tabs, your logged-in sessions, and your cookies. Claude works in its own
background tabs, so it does not take over your screen, steal focus, or show
dialogs.

This extension is only the browser half. It needs the claude4arc command-line
tool and its native host on the same computer. See
https://github.com/nesetkab/claude4arc for installation.

- Works in Arc, Dia, Chrome, Brave, and Edge.
- Handles forms, iframes, dialogs, popups, virtual lists, and code editors.
- A blocklist keeps Claude away from sites such as your bank.
- No analytics. The extension talks only to the local native host.

### Single purpose

Let a local AI agent (Claude Code) operate browser tabs on the user's
behalf, through a native messaging host on the same computer.

### Permission justifications

- **debugger:** sends trusted mouse and keyboard input, reads the page
  structure, and takes screenshots in the tabs that the agent works in, through
  the DevTools Protocol.
- **tabs:** opens, lists, and closes the agent's background tabs, and reports
  tab changes to the local host.
- **nativeMessaging:** the only channel to the claude4arc host on the user's
  computer. The extension has no other way to receive commands.
- **downloads:** reports the file path when the agent downloads a file, and
  removes that entry from the download list on request.
- **storage:** remembers which tabs belong to the agent while the browser
  runs (session storage only).
- **alarms:** keeps the connection to the native host alive.
- **Host permission `<all_urls>`:** the agent works on whatever site the user
  asks for. A content script removes other extensions' frames from the agent's
  own tabs, because they interrupt DevTools Protocol sessions.

### Data usage

The extension collects no user data and sends nothing off the computer. Check
"This item does not collect user data" and the three certifications about
selling, unrelated use, and creditworthiness.
