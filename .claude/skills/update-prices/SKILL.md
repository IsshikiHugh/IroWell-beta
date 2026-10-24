---
name: update-prices
description: Check IroWell's API price table (what the Usage page's "cost" is priced by) against Anthropic's official pricing page and update it, so that past totals are repriced only where the new price really applied. Use when the user asks to update/check the price table or the cost figures, when a new Claude model comes out, or when Anthropic changes its prices.
---

# Update the price table

The Usage page's cost is each answer in the Claude Code transcripts priced at API rates. The table is
`PRICE_ROWS` in `server/daemon.mjs` (search for `const PRICE_ROWS`); the comment above it explains the
fields. Each daemon prices its own machine's answers again whenever it starts, by the time of each answer,
and the client replaces the totals it keeps for a machine when that machine's table changes (`prices` in
`costDump`). So whatever the table says for a past moment becomes the past cost: get the dates right.

## 1. Read the official prices

Fetch `https://platform.claude.com/docs/en/about-claude/pricing.md` (the .md form is plain text). From it
take, for every model: base input, output, cache hits, the long-prompt prices (Claude Haiku 5.5 has a
second set over 100,000 tokens), and check the rules the code assumes for every model:

- 5-minute cache write = 1.25 × input, 1-hour cache write = 2 × input
- fast mode = 2 × every price (compare the fast mode table with the base prices)

If one of these rules no longer holds, say so to the user before changing anything: it is code, not a row.

## 2. Compare and decide, row by row

For each difference, decide which case it is, and tell the user which you chose and why:

| Case | What to do | Effect on past totals |
|---|---|---|
| The table was wrong (a price that never was the official one) | Fix the row where it stands | All past work repriced |
| A model the table doesn't cover yet (a new model) | Add a row with no `since`, above any broader pattern that would match its id first | All its past work priced |
| Anthropic changed a price, and the page, release notes or announcement says from when | Add a new row above the old one, with `since` = that moment (ISO, UTC) | Work from then on repriced; earlier keeps the old price |
| Anthropic changed a price and the date is unknown | Same, with `since` = now (ISO, UTC) | Only work from now on |

Never edit an old price in place for a real price change: the old row is what prices the work before it.
An old row can be deleted once the row that replaced it has been in effect for more than 35 days (the
history keeps 35 days). Rows are tried top to bottom, the first match that is in effect wins, so a
specific id (`sonnet-5-5`) goes above a broader one (`sonnet-5`). Patterns are regular expressions on the
model id (`claude-opus-5-5`, …).

Then update the date in "checked …" in the comment above the table.

## 3. Check it

- `node --check server/daemon.mjs`
- Recompute this machine's last days with the new table and compare by model with the old one (read
  `~/.claude/projects/*/*.jsonl` and `*/*/subagents/*.jsonl`; an answer's last line per message id counts),
  so the user sees what changes and by how much.
- Run the test suite (`node test/run.mjs quick`, and `node test/run.mjs usagesync`). If the quick suite's
  expected cost changes because a fixture's model price changed, update the fixture's comment and numbers
  to the official prices, not to whatever the code now prints.
- Other sessions may test the same checkout at the same time (fixed ports): check `ps` for a running
  `test/run.mjs` first.

## 4. Tell the user

- each change, its case and `since`, and what it does to their past totals (in dollars)
- that totals change once each machine's daemon runs the new code (the UI's update for each server; this
  machine's daemon restarts from the checkout the same way), and that a half hour whose transcripts are
  gone keeps its old total
- if `client/` changed too: the client has to be restarted and the page reloaded
- don't commit or push unless asked
