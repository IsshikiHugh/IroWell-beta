// What the fake Claude answers in cards.mjs: one turn that uses each kind of tool card.
import path from 'node:path';

const SUMMARY = [
  'Fixed `add()`: it now returns $f(a,b)=a+b$. For the record,',
  '',
  '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$',
  '',
  '| a | b | add(a, b) |',
  '|---|---|---|',
  '| 2 | 3 | 5 |',
  '| 4 | 5 | 9 |',
  '',
  'The secret number is 4817.',
].join('\n');

export default [
  { match: /^Fix calc\.py/, steps: (m, ctx) => {
    const f = (name) => path.join(ctx.session.cwd, name);
    return [
      { thinking: 'add() subtracts. Read it, fix it, run it, then have a subagent find the secret.' },
      { tool: 'Read', input: { file_path: f('calc.py') } },
      { tool: 'Edit', input: { file_path: f('calc.py'), old_string: 'return a - b', new_string: 'return a + b' } },
      { tool: 'Bash', input: { command: 'python3 calc.py', description: 'Run calc.py' } },
      { agent: { description: 'Find the secret number', prompt: 'Find the secret number in secret.txt.', steps: [
        { tool: 'Read', input: { file_path: f('secret.txt') } },
        { text: 'I read secret.txt, which holds one line. '.repeat(20) + 'The secret number is 4817.' },
      ] } },
      { text: SUMMARY },
    ];
  } },
];
