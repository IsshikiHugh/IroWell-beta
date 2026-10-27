---
name: progress
description: Keep a progress list for a long task (what has to be done, what is being done, what is done) that the user sees beside the conversation and edits too. Use when a task will run over many steps or turns (a multi-stage implementation, a migration, a batch of experiments, revising a paper), when the user asks for a progress list, a plan to follow, or to track what is done ("列个进度表", "记一下要做哪些事", "track this"), and when you are told that the user changed the progress list.
disable-model-invocation: true
---

# Progress list

One list per session: the things its long task has to do, each marked todo, doing or done. It is kept outside the conversation, so it is still there after a compaction, a detach or a restart. From the moment it has its first item, the user sees it at the foot of the right rail, and writes to it as you do: they mark items, reword them, add their own, reorder and remove. Every change is recorded with who made it, and you are shown the user's. When the task is over, the list is ended: by the user's End button, or by you once they agreed.

It holds the task's steps at the level the user follows it. TodoWrite stays for the small steps inside one of them.

## Commands

```sh
node <this skill's base directory>/progress.mjs [command]
```

| Command | Does |
|---|---|
| (none) | Prints the list, and what the user changed since you last read it |
| `add <text> [<text>…]` | New items, each todo, at the end. The first `add` starts the list. `--after <id>` puts them below that item, `--top` at the top |
| `doing <id>…` `done <id>…` `todo <id>…` | Marks items |
| `edit <id> <text>` | Rewords an item |
| `move <id> --after <id>` (or `--top`) | Puts an item somewhere else |
| `remove <id>…` | Takes items off the list |
| `end` | Ends the list: the task is over. It disappears from the rail; the next `add` starts a new one. Only after the user said yes (see below) |
| `log` | Every change so far, yours and the user's, with the time |

Every command prints the list as it is afterwards:

```
Progress list (1 of 4 done)
  1 [x] Load and clean the data
  4 [~] Train the baseline
  2 [ ] Run the ablations
  3 [ ] Write the results table

The user changed the list since you last read it:
  10-10 14:02  added 5 "Report GPU hours too" below 3
  10-10 14:03  marked 2 done (was todo): "Run the ablations"
```

`[ ]` todo, `[~]` doing, `[x]` done. The number is the item's id: it never changes, also when the item moves, and it is not its position.

## Keeping it

- **Agree on the plan first**: the list records a plan the user has agreed to, not your first draft of one. Propose the steps in the conversation, and work on them with the user (their objections, what is missing, the order) until they say the plan is right. A plan can be wrong, and the list is not the place to find that out. Don't `add` anything before that, and don't start the work either.
- **Then start it**: `add` the agreed steps, in the agreed order. One item is one outcome the user would recognise ("Train the baseline"), in a short line, in the user's language. Not every command you will run. When the user gave the items themselves ("make a list: A, B, C"), that is the agreed plan: add them as given.
- **Mark as you go**: `doing` when you start an item, `done` the moment it is finished, not several at the end. One item `doing` at a time, unless the work really runs in parallel.
- **Done means done**: mark an item done only when it is finished and checked. Something blocked or half done stays `doing` (or goes back to `todo`), and you tell the user why.
- **The plan changes**: put a step you discover where it belongs (`add --after`), reword an item whose scope changed, `remove` one that is no longer needed. Leave the done items: they are the record of what was done.
- **Ending it**: never `end` the list on your own. When every item is done and the user has nothing more they want added or changed (they said so, or their reply to the finished work asks for nothing else), ask them whether to end the list, as a question they answer with yes or no. Run `end` only after their yes. While they still ask for changes to the finished work, the list stays: add those changes as items. If they ask you to end it, that is their yes.

## What the user changed

Their changes reach you two ways: at the end of every command's output, and with their next message (as added context naming this skill) when they edited the list in between. Each change is shown once.

Read them as the user steering the task:

| The user | Means |
|---|---|
| added an item | Work to do, at the place they put it |
| removed an item | Don't do it. If it is already done, or half done, say so |
| marked an item done | It is done as far as they are concerned: don't redo it. If you know it isn't, say so instead of marking it back |
| marked a done item todo | They want it done again, or better: ask what was missing if it isn't clear |
| reworded an item | The new text is the task |
| moved an item | Their order is the order to work in |
| ended the list | The task is over as far as they are concerned. If work is still open, say so. Start a new list only for a new long task |

On a long run without the user (many items in one turn), run the script with no command before you start each item: they may have edited the list while you worked. When a change alters what you do, say so in a line of your reply.

## When the script fails

| Output | Meaning | Do |
|---|---|---|
| `Cannot reach the IroWell daemon` | The session was not started from the IroWell UI | There is no list to show: keep track with TodoWrite |
| `The server doesn't know "progressCli"` | This server runs an older IroWell | Tell the user to reconnect to update |
| `The list has no item <id>` | That id is gone (removed by the user, or mistyped) | Run it with no command and use the ids it prints |
