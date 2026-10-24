---
name: session-context
description: Bring in context from another Claude Code session (another folder, another conversation, or another host) by having a subagent read its transcript and report only what is needed. Use when the user asks what another session did, decided, found or is doing, or wants its results, numbers, paths or conclusions brought into this one ("看看那个 session", "check what the training session found", "pull the context from the paper session").
---

# Context from another session

You don't read the other session's transcript yourself: a transcript runs to megabytes and would flood this conversation. A subagent reads it and returns a short, sourced report.

## 1. Write the brief (here, before spawning)

From this conversation, work out and write down:

- **Target**: whatever identifies the other session — its folder, title or topic, a session id, roughly when it ran, and the ssh host if it is not this machine. If the user named nothing more than a topic, pass that on: the subagent searches.
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
1. Find the session with list (try the folder, title words or id). If several fit, choose by the brief and name the others in the report.
2. Get the overall picture with outline, then read only the turns that matter with show / grep. Use --tools full only for the turns whose tool output holds the answer.
3. Report:
   - Session: id, folder, title, when it was last active.
   - The answer to the brief: facts, numbers, paths and commands verbatim, each with its turn number (#n).
   - Anything that later turns changed or overturned, and what is still open.
   - What you could not find or are unsure of.
   Keep it under about 400 words unless the brief asks for more. No commentary on the transcript format.
```

## 3. Use the report

Answer the user (or carry on with the task) from the report. Say which session it came from and how recent it is. If the report leaves a gap that matters, send the subagent a follow-up question rather than opening the transcript here.
