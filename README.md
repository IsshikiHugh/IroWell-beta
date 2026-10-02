# iro-coding (MVP)

A custom UI for Claude Code built on the Claude Agent SDK. Sessions run on the remote server and persist when your local machine disconnects; the client connects over SSH without port forwarding.

```
[server]  daemon.mjs (long-lived, Agent SDK)  ── Unix socket ~/.iro-coding/daemon.sock
             ▲
             │  ssh <host> 'node attach.mjs'   (stdin/stdout bridge, no TCP port)
             │
[local]   client.mjs ── http://127.0.0.1:4777  (browser UI, localhost only)
```

- Close the browser, lose the network or put the laptop to sleep: sessions keep running on the server. On reconnect, the client replays the history from the event log.
- Tool approvals are answered in the UI. A pending approval stays pending across disconnects until someone answers it.

## Requirements

- Local: Node 18+ and a working `ssh <host>` (settings in `~/.ssh/config` such as jump hosts and keys are used as-is).
- Server: Linux or macOS with Node 18+. Log in to Claude once (run `claude` or `claude login`) so the credentials are in `~/.claude/`.

## Usage

```sh
node client/client.mjs    # then open http://127.0.0.1:4777/ and pick the server
```

The page opens on a server picker: **This machine** (everything runs here, no ssh; see "Running locally") always comes first, then the servers you connected to most recently, then the other hosts of your `~/.ssh/config` (and the files it `Include`s) in their order. Type to filter, or type any ssh destination (`user@host`) that isn't listed. ⇄ next to the connection status brings the picker back to switch servers; the page then shows only the new server's sessions (the old server keeps running them). `--host devbox` or `--local` skips the picker and connects right away.

There is no separate install or deploy step:

- The client installs its own packages (Markdown, KaTeX, code highlighting, diff) on start whenever they are missing or out of date, and those of `server/` when you pick this machine.
- On a host without IroWell, the first start installs it there (`server/` as a release under `~/.iro-coding/releases`, with its packages). If that fails (no node or npm on the host, no network), the UI says why and shows an **Install server** button to try again.
- Later, when the host runs older code than this client, or a newer Claude Code is out, the UI shows an **Update server** button next to the connection status (see "MVP limits").

Options: `--port 4777`, `--remote-node /path/to/node`. Remote commands run through the remote user's login shell (`$SHELL -lc`), so node from the profile is found. If node is only set up in `.bashrc` (for example nvm), pass its full path with `--remote-node`.

## Running locally

`--local` runs the same daemon on your own machine, from this checkout, with its state in `~/.iro-coding` there. Nothing else changes: the daemon still outlives the client and the browser, so closing the terminal or the page loses nothing, and **Update server** (shown when the checkout has newer daemon code than the running daemon) hands sessions over without interrupting them. The client connects to the daemon's socket directly instead of going through `attach.mjs`, and starts the daemon when none runs.

A laptop is not a server, so the first `--local` start writes `~/.iro-coding/config.json` with these defaults (a host has no such file, so it keeps the server behaviour). The daemon reads the file whenever it needs a value, so edits apply without a restart.

```json
{ "files": "folders", "allow": [], "detachIdleMinutes": 60, "keepAwake": true }
```

- `files: "folders"`: the UI (file viewer, Resources, `@` completion) reads only inside the sidebar's folders, the live sessions' directories and the media cache, with symlinks resolved. Adding a folder is what grants access to it. Paths listed in `allow` (e.g. `"~/notes"`) are allowed too. `"all"` lifts the limit. This covers only what the UI reads. What Claude itself may touch is still decided by Claude Code's permission settings.
- `detachIdleMinutes`: a session with nothing going on for that long is detached. Its CLI (about 400 MB each) exits, the row stays, and sending a message reattaches it. `0` turns this off.
- `keepAwake` (macOS): while a session is busy (a turn, a question waiting, a background task), the daemon holds `caffeinate -i`, so the machine doesn't fall into idle sleep in the middle of a turn. Closing the lid still sleeps.

After a shutdown, start the client again. The daemon starts with it and lists the earlier sessions as detached rows that reattach when you send to them. Nothing runs while the machine is off or asleep, including plan-usage sampling. Orphaned-process tracking in Tasks needs Linux's `/proc`, so it is not available on macOS.

## Details

- **Folders and new sessions**: the sidebar lists folders registered on the server (`~/.iro-coding/folders.json`). **Add folder** at the top opens a picker: type a path (`~/proj`, `proj` relative to the remote home, or `/abs/path`), or click through the server's directories; recent project folders are offered too. **+** on a folder opens a draft that looks like any other session, with the same composer, model, effort and mode controls, but nothing runs until you send the first message, which creates the session in that folder. A draft keeps what you typed while you look elsewhere; an empty one disappears when you leave it. The clock button on a folder lists its past sessions. Right-click a folder to remove it from the sidebar: only the registration goes, so its sessions and Claude's memory stay on disk and come back when you add the folder again (open sessions keep running, hidden). The working directory is fixed once a session starts.
- **Same harness as the terminal**: sessions get Claude Code's own system prompt, every settings layer (user, project, local: permissions, hooks, MCP servers, plugins), CLAUDE.md files, auto memory, skills, subagents and claude.ai connectors, as `claude` in a terminal does. They start in `permissions.defaultMode` from settings.json (a draft shows it), keep file checkpoints, and Stop leaves background tasks running (stop them in Tasks). What remains different is tied to the terminal: the CLI runs headless (it introduces itself as an Agent SDK agent rather than "Claude Code, the CLI", and forked subagents are not offered), there is no `!` shell prefix, and MCP servers that ask for input (elicitation) are declined. Sessions started by an IroWell from before this change were recorded with an empty system prompt and keep it until you run `/compact` in them.
- **Rewind** (the terminal's Esc Esc): hover a question, click **⋯** at its right and pick **Rewind to here**. After a confirmation that lists the files to restore, Claude's Edit/Write changes since that message are undone (from file checkpoints; changes made through Bash are not), the message and everything after it leave the conversation, and the message goes back into the input. The later turns stay in the transcript file, off the conversation's path, as in the terminal.
- **Branch**: `/branch [name]` copies the whole conversation into a new session; **Branch from here** in a question's **⋯** menu copies it up to the end of that turn. The original stays as it is.
- **Hooks and subagents**: a hook from settings.json that printed something or failed shows as a ⚓ line in the turn (silent successes are not shown). Running subagents show a one-line summary of what they are doing in Tasks.
- **Permissions**: the remote `~/.claude/settings.json` applies (allow rules, auto mode and so on). Only the actions that still need confirmation show an approval card in the UI.
- **AskUserQuestion**: rendered as a question card with options and an "Other" free-text field.
- **Message rendering**: Markdown (GFM tables, task lists, code highlighting, copy buttons) plus LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, ```` ```math ````). Raw HTML in the model's output is shown as text and never executed.
- **Focus layout**: the conversation is a list of turns. A turn's question stays pinned at the top while you scroll through its answer. The tool calls and thinking between two pieces of text fold into one "N steps" line that shows the step running now; click it to see the cards, and click a card for its details. A pending approval opens its group, which folds back once you answer. The turn's footer lists the files it changed (click one to open it). The outline on the right lists the turns and highlights the one you are reading.
- **Tool cards**: Bash shows the command and its output. Edit/Write show a diff, which switches to one with the real file line numbers once the edit lands. Read/Grep/Glob collapse to one line (click to expand). TodoWrite shows as a checklist. Subagent (Agent) steps nest inside their card. MCP tools show as `server · tool`.
- **Streaming**: text and thinking appear as they are generated. Thinking is collapsed by default.
- **Approvals**: shown inside the matching tool card, with Allow, "Always allow" (when the CLI offers a rule) and Deny.
- **Slash commands**: functional commands never enter the conversation. `/usage` and `/cost` open a panel with plan-limit meters and this session's cost per model. `/context` opens a panel with a stacked bar, the square grid, a legend and breakdowns (memory files, skills, MCP servers…). Both are built from the SDK's structured data. `/help`, `/status`, `/mcp`, `/model`, `/resume`, `/clear` and `/rename` are handled in the page. Other CLI commands that only print something (e.g. `/agents`) show it in a dialog; a command gets a turn only if it makes the model work (e.g. a skill).
- **/btw <question>**: asks a side question on a throwaway fork of the conversation (no tools, not saved as a session). The answer streams into a floating card, even while the main turn is still running, and never appears in the conversation. Type follow-ups in the card. The right-hand rail lists the current session's side threads under "btw", below its turns (kept in `~/.iro-coding/btw.json` on the server, so they survive restarts); click one to reopen and continue it.
- **Input box**: no focus ring; at least as tall as the Send/Stop/Detach stack, grows with what you type up to about a third of the window. A slim bar along its top edge opens (and closes) a half-screen editor. No drag handle.
- **Input history and suggestions**: ↑/↓ walk through what you sent before (kept in this browser); ↓ past the newest restores your draft. As you type, the latest matching history entry appears in grey; when the box is empty, a guess at your next prompt appears. → or Tab accepts the grey text. The guess comes from a small model (Haiku) that sees only the last exchange, because the SDK's own prompt suggestions aren't sent in headless sessions; `/suggest off` turns it off.
- **Composer**: `/` completes slash commands (Enter runs a command that takes no arguments; Tab only completes; an exact name wins over longer ones). `@` completes files and directories under the session's working directory. Images can be pasted or dropped (at most 5, 5 MB each). Esc interrupts the running turn.
- **Queued messages**: a message sent while Claude is busy waits on the server, listed above the input, and becomes a turn of its own once the current one ends (in order). ✕ takes one back into the input; **Send now** stops the current response and sends that message next (like the terminal's Ctrl+X Ctrl+S).
- **Activity indicator** (above the composer, like the terminal's spinner): what is running now (thinking, writing, "Running Bash · <what> · 24s", waiting for your approval), how long the turn has taken, and a warning if the CLI has been quiet for a while. The daemon sends a heartbeat every 3 s while a session is busy, so a stalled connection shows up as "no heartbeat". Background shells and subagents stay listed, even after the turn ends, until they finish.
- **Sidebar**: sessions are grouped in folders by the directory they started in (click a folder to collapse it). Each session shows two waits: *you*, the time since Claude finished answering your last message, and *agent*, the time since Claude last finished anything, including turns it started itself (subagent and background reports). All times move together on one clock that ticks on the minute: minute steps for the first 10 minutes, then 5-minute steps, then hours and days.
- **Background reports**: when a subagent or background task reports back, that turn is marked as not yours (↩, purple) in the conversation and in Anchors, with what it reported.
- **Plan usage page** (Usage button in the sidebar): one toggle switches between *used per interval*, the percentage points of the 5-hour window used each hour (last 48 h) and of the weekly limit used each half hour (last 7 days) as bar charts with a table view, and *level over time*, the percentage of each limit as a curve (the number the status line shows). Both have hover values. The daemon samples the limits every 30 minutes and keeps 35 days in `~/.iro-coding/usage.jsonl` on the server, so it keeps counting while your laptop is away.
- **Session states** (dot in the sidebar): green = busy (working, or something of it still running in the background); yellow = idle (nothing running; detaching loses nothing); grey = detached (no Claude process here; it stays listed, and Reattach reopens it). Detach replaces Close.
- **Right rail tabs** (drag the rail's left edge to resize it; double-click the edge to reset): Anchors (one entry per turn; clicking one puts that question at the very top of the view, leaving blank space below if needed), btw (side threads), Tasks (below). The Tasks tab shows a count when something besides the main thread is running.
- **Tasks** (right rail): the main thread (always listed: running, idle or detached), Claude's background tasks (background shells, subagents, monitors; each can be stopped), processes the session left running on its own (e.g. `nohup python train.py &` from its Bash tool; each can be sent SIGTERM), and busy btw threads. Those orphaned processes are found through the `CLAUDE_CODE_SESSION_ID` the CLI puts in its tools' environment, which they keep after they are no longer children of the CLI (Linux servers only, via /proc, every 10 s).
- **Status line** (under the composer), two rows. First, separated by thin dividers: model + effort (opens the ⌥M panel), permission mode, context-window meter, 5-hour and weekly plan-limit meters with reset countdowns (grey until half used, dark amber after that, deep red from 85%), directory and git branch, tokens in/out and lines changed, cost at API rates, session time. Second: session name and the session ID (click to copy). It refreshes after every turn and once a minute.
- **/color <name>**: sets this session's colour, used as the page accent (question bars, Send, highlights); `/color default` resets it.
- **Keys**: ⌥M opens model and effort together (↑ ↓ model, ← → effort; Enter or ⌥M again applies, Esc cancels). ⇧Tab cycles the permission mode: Ask before edits → Accept edits → Plan → Auto (never Bypass).
- **Header**: click the title to rename (also written to Claude Code's session record). Stop (Esc) and Detach sit under Send.
- **History** (the clock button on a folder, or `/resume`): lists the folder's past sessions from the terminal and from this UI, tagged by source, and reopens any of them with its earlier conversation. Headless runs (`claude -p`, Python SDK) are hidden unless you tick "include headless / automated runs". After a daemon restart, this is how you get sessions back.
- **File references**: only where Claude marks a path as a reference: a whole `inline code` span that is a path (optionally `:line`), a Markdown link to a file (`[name](src/a.py#L3)`), and the file names in tool cards and the changed-files footer. Click copies the absolute path on the server (relative paths are taken from the session directory, `~` from the server's home). ⌘/Ctrl/Shift-click opens it: text files in the file viewer, images and videos in Resources.
- **Resources** (left sidebar): images (png, jpg, gif, webp, svg…) and videos (mp4, webm, mov…) load here in the background, in 1 MB chunks with a progress bar; click a ready one to view it. Memory budget: at most 512 MB held at once, 64 MB per image and 256 MB per video; when a new file does not fit, the least recently viewed ones are released (still listed; a click fetches them again). Two downloads at a time. Nothing is written to disk; a page reload clears the list. Videos in a format browsers can't decode (e.g. MPEG-4 Part 2 from OpenCV's `mp4v`) are converted on the server with ffmpeg to H.264 first, with a progress bar; converted copies are cached in `~/.iro-coding/media-cache` (at most 2 GB, oldest removed first), so opening the same video again is instant.
- **Cost figure**: the session total the SDK computes at API rates. It is not the actual charge on a subscription.

## MVP limits

- The event log lives in daemon memory. If the daemon restarts, the live list is cleared (the folders stay); use a folder's history to reopen sessions. Tool cards reopened this way lose some detail (no real-line-number patches, no subagent stats).
- **Stopping the server**: ⏻ next to the connection status, or `node client/client.mjs --host devbox --stop` (`--local --stop` on this machine). Every session is closed (each stays listed and reattaches when you send to it) and the daemon exits. Clients connected to it don't start a new one: the page shows **Start server** instead, and starting a client starts it too. Closing the client or the browser never stops the server.
- An unused daemon exits after 72 hours (`IRO_IDLE_HOURS` in its environment; `0` = never): no client attached and nothing going on (no turn, question waiting for approval, queued message, background task or process). Its sessions are closed and can be reopened from history; the next connection starts a new daemon. While it is gone, plan usage is not sampled.
- Streaming covers the main conversation only. The SDK does not stream subagent output, so subagent steps appear once each step is complete.
- One server at a time per client. To keep two in view at once, run a second client on its own `--port`.
- **Update server** never interrupts a session. It installs the new code as a release of its own (`~/.iro-coding/releases/r<time>`, with `current` pointing at the newest), then the running daemon starts the new one and hands its sessions over: an idle session moves at once (same row, same conversation; its CLI is resumed by the new daemon), a busy one (a turn, a question, a background task or process) finishes on the old code and moves as soon as it is idle. Until then the new daemon relays it, so the UI sees one server. The old daemon exits when its last session has moved; old releases are removed later. The button shows when the server runs older code than the client, or a newer Agent SDK is on npm.
- IroWell runs the Claude Code bundled with the Agent SDK, not the terminal's `claude`, so it does not follow Claude Code's auto-update. Installing and updating fetch the newest SDK (and with it the newest Claude Code); the daemon checks npm every 6 hours.
- Multiple browser tabs share one connection and all see the same state. Opening two clients against the same host also works.

## Tests

```sh
cd test && npm install        # once: playwright-core (uses the headless Chromium Playwright has downloaded, or $IRO_CHROMIUM)
node test/run.mjs quick       # ~10 s, no model calls: syntax, protocol basics, UI around a blank session
node test/run.mjs full        # quick + every end-to-end suite with real Claude turns (~5 min, uses some plan quota)
node test/run.mjs focus states   # selected suites
```

`test/remote.mjs <ssh-host>` runs a real round trip against a host (installing IroWell there if needed). The `update` suite covers installing and updating through the stand-in `test/fakebin/ssh` and `scp`.
