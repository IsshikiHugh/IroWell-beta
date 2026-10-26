# IroWell

> [!WARNING]
> **IroWell is in beta.** Expect bugs, rough edges and breaking changes between versions, including to the on-server state in `~/.iro-coding`. Don't rely on it for anything you can't afford to redo, and please report problems as issues.

A browser front end for Claude Code and Codex. Sessions run on a remote server (or on your own machine) and keep running when your laptop disconnects. You use them from a local web page that connects to the server over plain SSH.

```
[server]  daemon.mjs (Claude Agent SDK / Codex App Server) ── Unix socket ~/.iro-coding/daemon.sock
             ▲
             │  ssh <host> 'node attach.mjs'   (stdin/stdout bridge, no open TCP port)
             │
[local]   client.mjs ── http://127.0.0.1:4777  (browser UI, localhost only)
```

## What this is (and isn't)

IroWell **only rewrites the front end**. It does not make the agent any more capable. Claude sessions use the Claude Code that ships with the Claude Agent SDK, and it uses the same system prompt, output style, settings layers (permissions, hooks, MCP servers, plugins), CLAUDE.md files, memory, skills and subagents as `claude` in a terminal. What changes is the way you interact with it:

- Sessions live on the server. Closing the browser, losing the network or putting the laptop to sleep doesn't stop them. When you reconnect, the history is replayed.
- The conversation is easier to read, and you can look at files on the server without leaving the page (see [Main features](#main-features)).
- Pending tool approvals and questions stay open across disconnects until someone answers them.

A few things are tied to the terminal and work differently: the CLI runs headless, there is no `!` shell prefix (use the built-in terminal panel instead), forked subagents are not offered, and MCP servers that ask for input (elicitation) are declined.

Codex uses its native App Server, subscription login, config, Skills, MCP and history. Select the engine when creating a conversation. See [Codex setup and workflows](docs/codex.md) for installation, login, permissions and validation.

## Usage

### Requirements

- **Local machine**: Node 18+ with npm, and a working `ssh <host>`. Settings in `~/.ssh/config`, such as jump hosts, keys and forwards, are used as they are.
- **Server**: Linux or macOS with Node 18+ and npm. An older Node is refused, and the error names the version it found. Ubuntu's own `nodejs` package is too old, so install Node from nodejs.org, nvm or fnm.
- **Your chosen engine logged in on the server**, once. For Codex, use **Codex account** in a Codex draft ([details](docs/codex.md)). For Claude: Until it is, the UI shows **Claude is not logged in** with a **Log in** button: it opens the sign-in page in your browser, and you paste the code that page shows back into the dialog (on **This machine** the page finishes the login by itself). `/login` opens the same dialog, e.g. to switch accounts. You can also run the command the notice gives on the server (`claude auth login` from the bundled Claude Code, or `claude login` if the CLI is installed). The notice clears itself within 15 s of logging in.

### (a) Deploying the server

There is no separate deploy step. Clone this repository **on your local machine** only:

```sh
git clone <this repo> && cd IroWell-dev
```

The first time you connect to a host, the client copies `server/` to it over ssh. It installs it as a release under `~/.iro-coding/releases/` with its npm packages, including the latest Claude Agent SDK, and starts the daemon. If the install fails (for example, there is no node or npm on the host, or no network), the UI says why and shows an **Install server** button to retry.

Later, when the server runs older code than your client, or a newer Agent SDK is on npm, the client installs the new release on the host by itself. Once it is ready, a **Reconnect to update** button appears next to the connection status; only a click on it switches to the new release (reloading the page doesn't), and only after the engines needed by active sessions pass their startup checks. Switching never interrupts a session: idle sessions move to the new daemon right away, and busy ones move as soon as they finish. If something fails, the UI says why and the client tries again later.

To stop a server, click ⏻ next to the connection status, or run:

```sh
node client/client.mjs --host <host> --stop     # or: --local --stop
```

### (b) Starting the client locally

```sh
node client/client.mjs
```

Then open <http://127.0.0.1:4777/>. You don't need `npm install` or a build: the client installs its own front-end packages (Markdown, KaTeX, highlighting, diff, terminal) on start. The page is served on localhost only and is protected by a per-run token.

Options:

| Flag | Meaning |
|---|---|
| `--host <ssh-host>` | skip the picker and connect to that host right away |
| `--local` | skip the picker and run everything on this machine |
| `--port 4777` | local port of the web page |
| `--remote-node /path/to/node` | node to use on the server, if it is not on the login shell's PATH (e.g. nvm set up only in `.bashrc`) |
| `--stop` | stop the server given by `--host` / `--local` |

### (c) Connecting to a server

The page opens on a **server picker**, which lists, in order:

1. **This machine**: runs the daemon locally from this checkout, without ssh (same as `--local`).
2. The servers you connected to most recently.
3. The other hosts in your `~/.ssh/config` and the files it `Include`s.

Type to filter, or type any ssh destination (`user@host`) that isn't listed. ⇄ next to the connection status brings the picker back so you can switch servers. The old server keeps its sessions running.

Each browser tab has its own server, named in its URL (`?server=local`, `?server=ssh:devbox`), so different tabs can show different servers at once. ⌘/Ctrl+Enter in the picker opens a server in a new tab.

Commands on the server run through the remote user's login shell (`$SHELL -lc`), so a node set up in the profile is found.

**Ports.** The forwards `~/.ssh/config` gives a host are set up as with `ssh <host>`, on an ssh of their own. More can be added while you work, without reconnecting: the plug next to the server's name lists the server's ports that this computer reaches as `localhost`, and forwards another one by its number (on the same local port when that is free here, else on a free one). A session on a server is told that it is remote and under which ssh name (the `remote` UI skill): when it starts something for you to open (a dev server, TensorBoard, Jupyter), it asks your client to forward the port and gives you the `http://localhost:…` link instead of one with the server's name. A port stays forwarded for as long as the client is connected to the server.

**Running locally.** With **This machine** / `--local`, the daemon still outlives the client and the browser. Because a laptop is not a server, the first local start writes `~/.iro-coding/config.json`:

```json
{ "detachIdleMinutes": 60, "keepAwake": true }
```

- `detachIdleMinutes` detaches sessions that have been idle that long, which frees about 400 MB each. Sending a message reattaches the session. `0` turns this off.
- `keepAwake` (macOS) holds `caffeinate -i` while a session is busy, so the machine doesn't idle-sleep in the middle of a turn.

## Basic workflow

1. **Add folder** in the sidebar registers a project directory on the server.
2. **+** on a folder opens a draft. Pick the model, effort and permission mode, then type. The session starts when you send the first message.
3. Approve tool calls in the tool cards, and answer `AskUserQuestion` prompts in the question card.
4. Leave whenever you like. The sidebar dot shows each session's state: green means busy, yellow means idle, and grey means detached (sending a message reattaches it). Rings around a dot mean Claude has stopped: two until you open the session, then one for as long as something still runs in the background.
5. Use the clock button on a folder (or `/resume`) to reopen past sessions, including ones started in the terminal.

Slash commands, `@` file completion, image paste and drop, ⇧Tab (permission mode), ⌥M (model and effort) and Ctrl+C (interrupt) behave as they do in the terminal.

## Main features

### (a) Better message display

- **Turn-based layout**: the conversation is a list of turns. A turn's question stays pinned at the top while you scroll through its answer. A question longer than four lines shows its first four; the button in its corner opens the rest. The outline on the right (**Anchors**) lists the turns, and clicking one jumps to it.
- **Folded steps**: tool calls and thinking between two pieces of text fold into one "N steps" line that shows the step running now. Expand it to see the individual cards.
- **Rich tool cards**: Bash shows the command and its output. Edit and Write show a diff with real file line numbers. TodoWrite shows as a checklist. Subagent steps nest inside their card. MCP tools show as `server · tool`.
- **Rendering**: Markdown (GFM tables, task lists, highlighted code with copy buttons) and LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, ```` ```math ````). Raw HTML from the model is shown as text and never executed.
- **Live activity**: text and thinking stream as they are generated. An indicator shows what is running ("Running Bash · … · 24s", waiting for approval), and background shells and subagents stay listed until they finish.
- **Status line**: model and effort, permission mode, a context-window meter, 5-hour and weekly plan-limit meters, git branch, tokens, cost and session time.
- **Panels instead of text dumps**: `/usage`, `/cost` and `/context` open visual panels. The **Usage** page charts plan usage over the last 48 h and 7 days, sampled by the daemon every 30 minutes, and lays each week out by half hour (a column per day), so the hours you worked and how hard show at a glance. A half hour's tint is what its work would cost at API rates (each daemon reads the token counts off the transcripts on its machine), and under each day stand the points it added to the weekly limit and its cost. Each machine's daemon keeps its own samples; while the client is connected to a server, it copies the samples one side missed (asleep, off, or refused by the usage API) from the other, for machines logged in to the same Claude account. The page itself reads none of the daemons directly: the client keeps one history and one level per account on your computer (`~/.iro-coding/usage-accounts.json`), with the later reading of a slot two machines took and the newest level any of them has, so the Usage page and the status line show the same whichever machine you are on. The cost is not copied between machines: a daemon only counts its own machine, and the client collects every machine's half-hour totals, keeps them on your computer (`~/.iro-coding/cost-machines.json`) and adds up those of the same account for the page. The usage API refuses for hours at times: a query that brings nothing is made again after 5, 10 and 15 minutes, and if the slot is still empty then, the daemon reads the level off the answer to a one-line message it sends to Haiku ("El Psy Congroo"), which costs a sliver of the plan.
- **Progress list**: for a long task, Claude keeps a list of what has to be done, what it is doing and what is done (the `progress` UI skill; `/irowell:progress` asks for one). Once a session has started one, it sits at the foot of the right rail, under whichever tab is open, and its bar folds it down to one line. You write to it as Claude does: click an item's mark to change it, its text to reword it, drag it to another place, remove it, or add your own. Claude is told what you changed, with your next message or the next time it reads the list. Each session has its own list, kept on the server (`~/.iro-coding/progress/`), so it outlives a compaction, a detach and a daemon update.
- **Output style**: Settings → Output style lists Claude Code's output styles on that server, the same ones `claude` in a terminal uses: the three built in (Default, Explanatory, Learning) and your own in `~/.claude/output-styles`. Make, edit and delete your own there (description, text, and whether Claude Code keeps its coding instructions), and pick the one every session started from then on uses (`outputStyle` in `~/.claude/settings.json`).
- **Other conveniences**: queued messages while Claude is busy (`/clear`, `/detach` and `/branch` wait their turn there too), **Rewind to here** and **Branch from here** on any question, `/btw` side questions in a floating card, and input history with grey inline suggestions.

### (b) Previewing files on the server

- **Clickable file references**: paths that Claude mentions (an `inline code` path, a Markdown link to a file, the file names in tool cards and in a turn's changed-files list) are links. A click copies the absolute path on the server. ⌘/Ctrl/Shift-click opens the file. A link can name lines (`[train.py](/abs/train.py:123-234)`, also `:123` and `#L123-L234`): the file then opens at them, with their line numbers marked.
- **File viewer**: an opened file shows in a dialog.
  - Text and code are shown with syntax highlighting. Small files are re-read on each open, so you always see the current content.
  - Images (png, jpg, gif, webp, svg, avif…) are shown whole, in a frame you can zoom and pan: drag to pan, ⌘/Ctrl-scroll or pinch to zoom, and on hover the buttons to zoom in, zoom out and reset. Zoomed far in, the image's pixels are drawn as squares.
  - Videos (mp4, webm, mov…) play in the page. One this browser can't decode (e.g. OpenCV's `mp4v`) is converted on this computer by the local client with ffmpeg (H.264, or VP9 for a browser without H.264); the server needs no ffmpeg. ffmpeg is found on PATH, in Homebrew, conda or `~/.local`, or from `pip install imageio-ffmpeg`.
  - An MP4/MOV video has a frame bar under it: step one frame back or on, or type a frame number (the first is 0) to go to it. The frames are read from the file itself; a WebM or a fragmented MP4 doesn't list them and has no bar.
  - Images, videos and big text files are fetched from the server in 1 MB chunks, the dialog showing the progress (closing it doesn't stop the download), and are then kept in browser memory, so opening one again is immediate. What is kept looks after itself: a file that changed on the server is fetched again, one not opened for an hour is dropped (checked when you next open a file), and at most 512 MB are held, the least recently opened files going first. Nothing is written to your local disk.
- **Built-in terminal**: ⌃\` (or the icon in the header) drops a terminal panel over the conversation. It runs real shells on the server in the session's folder, with one tab per shell.
- **Tasks tab**: lists Claude's background tasks, subagents and processes the session left running on the server (e.g. `nohup python train.py &`). You can stop each of them from here.
- **What a session runs stops with it**: detaching or archiving a session, stopping the server, or the session's Claude process ending also stops its background tasks and the processes it started (SIGTERM, then SIGKILL after 5 s). Only an update keeps them: the new daemon carries the session on, with them. Processes that got away all the same (the daemon was killed, say, or a session ran in a terminal) are listed under the ghost next to the server's name, by the session that started them, and can be stopped there. A process is told by the `CLAUDE_CODE_SESSION_ID` in its environment; on a Mac, processes of the system's own programs (e.g. `/bin/sleep`) don't show it and go unseen.

## Limits

- The live event log is kept in daemon memory. If the daemon restarts, use a folder's history to reopen sessions; the cards reopened this way lose some detail.
- A daemon with no client attached and nothing running exits after 72 hours (`IRO_IDLE_HOURS`, `0` = never).
- The SDK doesn't stream subagent output, so subagent steps appear once each step is complete.
- IroWell runs the Claude Code bundled with the Agent SDK, not your terminal's `claude`, so it does not follow Claude Code's own auto-update. The client fetches the newest version instead, and **Reconnect to update** switches to it.
- The cost figure is computed at API rates. It is not what a subscription is actually charged.

## Tests

```sh
cd test && npm install           # once: playwright-core (uses an installed Chromium, or $IRO_CHROMIUM)
node test/run.mjs quick          # ~10 s, no model calls
node test/run.mjs full           # every end-to-end suite with real Claude turns (~5 min, uses plan quota)
node test/remote.mjs <ssh-host>  # a real round trip against a host
```
