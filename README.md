# IroWell

> [!WARNING]
> **IroWell is in beta.** Expect bugs, rough edges and breaking changes between versions, including to the on-server state in `~/.iro-coding`. Don't rely on it for anything you can't afford to redo, and please report problems as issues.

A browser front end for Claude Code. Sessions run on a remote server (or on your own machine) and keep running when your laptop disconnects. You use them from a local web page that connects to the server over plain SSH.

```
[server]  daemon.mjs (long-lived, Claude Agent SDK) ── Unix socket ~/.iro-coding/daemon.sock
             ▲
             │  ssh <host> 'node attach.mjs'   (stdin/stdout bridge, no open TCP port)
             │
[local]   client.mjs ── http://127.0.0.1:4777  (browser UI, localhost only)
```

## What this is (and isn't)

IroWell **only rewrites the front end**. It does not make the agent any more capable. Every session is the Claude Code that ships with the Claude Agent SDK, and it uses the same system prompt, settings layers (permissions, hooks, MCP servers, plugins), CLAUDE.md files, memory, skills and subagents as `claude` in a terminal. What changes is the way you interact with it:

- Sessions live on the server. Closing the browser, losing the network or putting the laptop to sleep doesn't stop them. When you reconnect, the history is replayed.
- The conversation is easier to read, and you can look at files on the server without leaving the page (see [Main features](#main-features)).
- Pending tool approvals and questions stay open across disconnects until someone answers them.

A few things are tied to the terminal and work differently: the CLI runs headless, there is no `!` shell prefix (use the built-in terminal panel instead), forked subagents are not offered, and MCP servers that ask for input (elicitation) are declined.

## Usage

### Requirements

- **Local machine**: Node 18+ with npm, and a working `ssh <host>`. Settings in `~/.ssh/config`, such as jump hosts, keys and forwards, are used as they are.
- **Server**: Linux or macOS with Node 18+ and npm. An older Node is refused, and the error names the version it found. Ubuntu's own `nodejs` package is too old, so install Node from nodejs.org, nvm or fnm.
- **Claude logged in on the server**, once. Until it is, the UI shows **Claude is not logged in** with a **Log in** button: it opens the sign-in page in your browser, and you paste the code that page shows back into the dialog (on **This machine** the page finishes the login by itself). `/login` opens the same dialog, e.g. to switch accounts. You can also run the command the notice gives on the server (`claude auth login` from the bundled Claude Code, or `claude login` if the CLI is installed). The notice clears itself within 15 s of logging in.

### (a) Deploying the server

There is no separate deploy step. Clone this repository **on your local machine** only:

```sh
git clone <this repo> && cd IroWell-dev
```

The first time you connect to a host, the client copies `server/` to it over ssh. It installs it as a release under `~/.iro-coding/releases/` with its npm packages, including the latest Claude Agent SDK, and starts the daemon. If the install fails (for example, there is no node or npm on the host, or no network), the UI says why and shows an **Install server** button to retry.

Later, when the server runs older code than your client, or a newer Agent SDK is on npm, an **Update server** button appears next to the connection status. Updating never interrupts a session: idle sessions move to the new daemon right away, and busy ones move as soon as they finish.

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
4. Leave whenever you like. The sidebar dot shows each session's state: green means busy, yellow means idle, and grey means detached (sending a message reattaches it).
5. Use the clock button on a folder (or `/resume`) to reopen past sessions, including ones started in the terminal.

Slash commands, `@` file completion, image paste and drop, ⇧Tab (permission mode), ⌥M (model and effort) and Ctrl+C (interrupt) behave as they do in the terminal.

## Main features

### (a) Better message display

- **Turn-based layout**: the conversation is a list of turns. A turn's question stays pinned at the top while you scroll through its answer. The outline on the right (**Anchors**) lists the turns, and clicking one jumps to it.
- **Folded steps**: tool calls and thinking between two pieces of text fold into one "N steps" line that shows the step running now. Expand it to see the individual cards.
- **Rich tool cards**: Bash shows the command and its output. Edit and Write show a diff with real file line numbers. TodoWrite shows as a checklist. Subagent steps nest inside their card. MCP tools show as `server · tool`.
- **Rendering**: Markdown (GFM tables, task lists, highlighted code with copy buttons) and LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, ```` ```math ````). Raw HTML from the model is shown as text and never executed.
- **Live activity**: text and thinking stream as they are generated. An indicator shows what is running ("Running Bash · … · 24s", waiting for approval), and background shells and subagents stay listed until they finish.
- **Status line**: model and effort, permission mode, a context-window meter, 5-hour and weekly plan-limit meters, git branch, tokens, cost and session time.
- **Panels instead of text dumps**: `/usage`, `/cost` and `/context` open visual panels. The **Usage** page charts plan usage over the last 48 h and 7 days, sampled by the daemon every 30 minutes.
- **Other conveniences**: queued messages while Claude is busy, **Rewind to here** and **Branch from here** on any question, `/btw` side questions in a floating card, and input history with grey inline suggestions.

### (b) Previewing files on the server

- **Clickable file references**: paths that Claude mentions (an `inline code` path, a Markdown link to a file, the file names in tool cards and in a turn's changed-files list) are links. A click copies the absolute path on the server. ⌘/Ctrl/Shift-click opens the file.
- **Resources tab** (right rail): files you open are listed here and fetched from the server in the background, in 1 MB chunks with a progress bar.
  - Text and code are shown with syntax highlighting. Small files are re-read on each open, so you always see the current content.
  - Images (png, jpg, gif, webp, svg, avif…) are shown full size.
  - Videos (mp4, webm, mov…) play in the page. One this browser can't decode (e.g. OpenCV's `mp4v`) is converted on this computer by the local client with ffmpeg (H.264, or VP9 for a browser without H.264); the server needs no ffmpeg. ffmpeg is found on PATH, in Homebrew, conda or `~/.local`, or from `pip install imageio-ffmpeg`.
  - Everything is held in browser memory (512 MB at most, with the least recently viewed files released first). Nothing is written to your local disk.
- **Built-in terminal**: ⌃\` (or the icon in the header) drops a terminal panel over the conversation. It runs real shells on the server in the session's folder, with one tab per shell.
- **Tasks tab**: lists Claude's background tasks, subagents and processes the session left running on the server (e.g. `nohup python train.py &`). You can stop each of them from here.

## Limits

- The live event log is kept in daemon memory. If the daemon restarts, use a folder's history to reopen sessions; the cards reopened this way lose some detail.
- A daemon with no client attached and nothing running exits after 72 hours (`IRO_IDLE_HOURS`, `0` = never).
- The SDK doesn't stream subagent output, so subagent steps appear once each step is complete.
- IroWell runs the Claude Code bundled with the Agent SDK, not your terminal's `claude`, so it does not follow Claude Code's own auto-update. **Update server** fetches the newest version instead.
- The cost figure is computed at API rates. It is not what a subscription is actually charged.

## Tests

```sh
cd test && npm install           # once: playwright-core (uses an installed Chromium, or $IRO_CHROMIUM)
node test/run.mjs quick          # ~10 s, no model calls
node test/run.mjs full           # every end-to-end suite with real Claude turns (~5 min, uses plan quota)
node test/remote.mjs <ssh-host>  # a real round trip against a host
```
