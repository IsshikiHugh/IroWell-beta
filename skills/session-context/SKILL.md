---
name: session-context
description: Bring in context from another Claude Code session (another folder, another conversation, or another server the user's IroWell is connected to) by having a subagent, or a reader on that server, read its transcript and report only what is needed. Use when the user asks what another session did, decided, found or is doing, or wants its results, numbers, paths or conclusions brought into this one ("看看那个 session", "check what the training session found", "pull the context from the paper session"). A session id in the user's message means a session too, even with no word "session" beside it: a UUID like 4f1e9a2b-7c3d-4e8f-9a1b-2c3d4e5f6a7b, or its first 8 hex characters like 4f1e9a2b ("4f1e9a2b 里那个结论", "参考 4f1e9a2b-7c3d…").
---

# Context from another session

You don't read the other session's transcript yourself: a transcript runs to megabytes and would flood this conversation. A subagent reads it (for a session on another server: a reader there, 2b) and returns a short, sourced report.

## 1. Write the brief (here, before spawning)

From this conversation, work out and write down:

- **Target**: whatever identifies the other session — its folder, title or topic, a session id, roughly when it ran, and the server it is on if not this one. If the user named nothing more than a topic, pass that on: the subagent searches.

  A UUID, or a run of 8 or more hex characters, that the user gives without saying what it is, is a session id (whole or its start). If it could as well be a git commit in the folder being worked on, settle it with `node <abs path>/sessions.mjs list <it>` before spawning: it is a session when a listed id starts with it (other rows are sessions that only mention it).
- **What to fetch**: the part of that session the user cares about (a result, a decision, a file it changed, a bug it found, where it stands now).
- **Requirements**: what this session needs it for, and in what form (exact numbers, paths, commands, a timeline, verbatim quotes...).
- **Default** when the user gave no specifics: the newest state first, then the most important facts — what it was asked, what it concluded or changed, what is still open. The aim is a working picture of that session, not a recap of every turn.

Ask the user only when they can't mean any single session and the brief can't say which to search for.

## 2. Spawn the subagent

Call the Agent tool (`general-purpose`) with a prompt built from the template below. Fill in the brief, and give `sessions.mjs` (next to this file, in this skill's base directory) as an absolute path.

```
Read another Claude Code session's transcript and report what this brief asks for. Read only: change no files, run nothing but the reader below and read-only commands.

Brief
- Target: <...>
- What to fetch: <...>
- Requirements: <... or "none: newest state first, then the most important facts">

Reader: node <abs path>/sessions.mjs
  list [filter] [--limit N]            sessions, most recently active first ("← this session" is the caller: skip it)
  outline <id>                         one line per turn: time, request, tool count, start of the answer
  show <id> [--turns A-B | --last N] [--tools none|brief|full]
  grep <id> <regex>                    matching lines with turn numbers
Another host: ssh <host> "\$SHELL -lc 'node --input-type=module - <args>'" < <abs path>/sessions.mjs

Steps
1. If the target gives a session id or the start of one, use it as it is with outline (any unique start works). Otherwise find the session with list (try the folder or title words). If several fit, choose by the brief and name the others in the report.
2. Get the overall picture with outline, then read only the turns that matter with show / grep. Use --tools full only for the turns whose tool output holds the answer.
3. Report:
   - Session: id, folder, title, when it was last active.
   - The answer to the brief: facts, numbers, paths and commands verbatim, each with its turn number (#n).
   - Anything that later turns changed or overturned, and what is still open.
   - What you could not find or are unsure of.
   Keep it under about 400 words unless the brief asks for more. No commentary on the transcript format.
```

## 2b. A session on another server

When the session is on another server than this one, don't spawn the subagent: a reader on that server reads it there, and its report comes back here through the IroWell client on the user's computer. `node <abs path>/peers.mjs` (next to this file) lists the servers the client is connected to; `local` is the user's own computer.

Send the brief on stdin, and give the Bash call a timeout of 600000 (a read takes a few minutes):

```sh
node <abs path>/peers.mjs ask <server> <<'EOF'
Target: <...>
What to fetch: <...>
Requirements: <...>
EOF
```

The script prints the reader's report: go on to step 3 with it. If it says:

| Output | Do |
|---|---|
| `not connected to "<server>"`, `no connection to <server> right now` | Ask the user to connect to it in the UI, or which of the servers listed they mean |
| `runs an older IroWell` | Ask the user to update that server (Reconnect to update) |
| `Cannot reach the IroWell daemon`, `No IroWell client is connected` | Read it over ssh instead: step 2, with the host in the brief |
| another error | Report it as it is |

## 3. Use the report

Answer the user (or carry on with the task) from the report. Say which session it came from and how recent it is. If the report leaves a gap that matters, send the subagent a follow-up question rather than opening the transcript here.
