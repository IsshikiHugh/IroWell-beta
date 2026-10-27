// What the fake Claude answers in modes.mjs.
import path from 'node:path';

export default [
  // (says what it was given: the image reached Claude Code as an image block)
  { match: (text, ctx) => Array.isArray(ctx.content) && ctx.content.some((b) => b.type === 'image'),
    steps: (m, ctx) => [{ text: `I got an ${ctx.content.find((b) => b.type === 'image').source?.media_type} image.` }] },
  { match: /^Change the print line/, steps: (m, ctx) => [
    { tool: 'Edit', input: { file_path: path.join(ctx.session.cwd, 'calc.py'), old_string: 'print(add(2, 3))', new_string: 'print(add(4, 5))' } },
    { text: 'edited' },
  ] },
  // a command that runs until it is stopped (asks nothing, whatever the mode)
  { match: /^Run a long command/, steps: [{ tool: 'Bash', input: { command: 'sleep 60', description: 'Wait a minute' }, ask: false }, { text: 'slept' }] },
];
