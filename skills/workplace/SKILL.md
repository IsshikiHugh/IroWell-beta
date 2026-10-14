---
name: workplace
description: Tell the user which git worktree this session mainly works in; the UI shows it, with its branch, beside the session's title. Use when the work moves to another worktree (after `git worktree add`, EnterWorktree, or when you start editing files in one), when it moves back, and when a note after a tool call says the work ran in another worktree than the one shown.
user-invocable: false
---

# Where this session works

Beside the session's title the user sees the git worktree this session works in and its branch. Until you say otherwise it is the folder the session started in. The branch is read from git each time, so checking out a branch there shows by itself: you only say which **worktree**.

## Commands

```sh
node <this skill's base directory>/workplace.mjs [command]
```

| Command | Does |
|---|---|
| (none) | Prints what the title shows now |
| `set <dir>` | This session now mainly works in the git worktree `<dir>` is in (any directory inside it) |
| `reset` | Back to the folder the session started in |

## When to set it

- **Set it when the work moves**: you created a worktree for this task and work there (`git worktree add ../repo-feature`, EnterWorktree), or the user asked you to carry on in an existing one. Set it as you start, not when you finish.
- **Mainly, not once**: a look at a file in another checkout, one command run there, does not move the work. Set it when that is where the changes of this task go.
- **Set it back** when the work returns: `reset` for the session's folder, `set <dir>` for another worktree. When you remove the worktree it shows, `reset` first.
- **When asked**: after a tool call, a note may say it ran in another worktree than the one shown. Decide by the rule above: `set` it, or carry on. Each worktree is asked about at most once a turn.

## When the script fails

| Output | Meaning | Do |
|---|---|---|
| `Cannot reach the IroWell daemon` | The session was not started from the IroWell UI | Nothing to show: carry on |
| `The server doesn't know "workplaceCli"` | This server runs an older IroWell | Tell the user to reconnect to update |
| `Not in a git working tree` | `<dir>` is not in a git repository | Give a directory inside the worktree |
