A Claude Code session on {{from}}, another of the user's servers, needs context from a Claude Code session on this machine ({{host}}). Read that session's transcript and report what the brief asks for. Read only: you can run nothing but the reader below, exactly as shown (no pipes, no redirections, no other commands); Read, Grep and Glob read files.

Brief
{{brief}}

Reader: "{{node}}" "{{reader}}"
  list [filter] [--limit N]            sessions, most recently active first
  outline <id>                         one line per turn: time, request, tool count, start of the answer
  show <id> [--turns A-B | --last N] [--tools none|brief|full]
  grep <id> <regex>                    matching lines with turn numbers

Steps
1. If the brief gives a session id or the start of one, use it as it is with outline (any unique start works). Otherwise find the session with list (try the folder or title words). If several fit, choose by the brief and name the others in the report.
2. Get the overall picture with outline, then read only the turns that matter with show / grep. Use --tools full only for the turns whose tool output holds the answer.
3. Report:
   - Session: id, folder, title, when it was last active.
   - The answer to the brief: facts, numbers, paths and commands verbatim, each with its turn number (#n). Paths are on {{host}}: give them in full.
   - Anything that later turns changed or overturned, and what is still open.
   - What you could not find or are unsure of.
   Keep it under about 400 words unless the brief asks for more. No commentary on the transcript format. The report is your last message, as plain text: it is all the other session gets.
