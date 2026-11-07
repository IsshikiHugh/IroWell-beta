// The reader on the other server (skills/session-context/fetch.md): it runs the transcript reader as it was
// told to, then two commands it may not run, and reports what each gave.
export default [
  { match: /^A Claude Code session on ([\s\S]+?), another of the user's servers/, steps: (m, ctx) => {
    const [, node, reader] = /Reader: "([^"]+)" "([^"]+)"/.exec(ctx.text);
    const touch = /Touch: (\S+)/.exec(ctx.text)[1];
    const seen = {};
    return [
      { tool: 'Bash', input: { command: `"${node}" "${reader}" grep 4f1e 'ZEBRA|loss'`, description: 'Grep the session' } },
      { text: (c) => { seen.list = c.lastResult; return 'Found it.'; } },
      { tool: 'Bash', input: { command: `"${node}" "${reader}" list ZEBRA > ${touch}`, description: 'Save the list' } },
      { text: (c) => { seen.redirect = c.lastResult; return 'Reading on.'; } },
      { tool: 'Bash', input: { command: `touch ${touch}`, description: 'Touch' } },
      { text: (c) => `REPORT for a session on ${m[1]}\nlist: ${seen.list}\nredirect: ${seen.redirect}\ntouch: ${c.lastResult}` },
    ];
  } },
];
