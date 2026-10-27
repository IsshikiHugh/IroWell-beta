// Replies for layout.mjs: a turn of tool calls (two of them ask), and long numbered answers.
import path from 'node:path';
import { factsRule } from './_f2.mjs';

export default [
  { match: /^Read calc\.py and README\.md/, steps: (m, ctx) => {
    const f = (name) => path.join(ctx.session.cwd, name);
    return [
      { tool: 'Read', input: { file_path: f('calc.py') } },
      { tool: 'Read', input: { file_path: f('README.md') } },
      { tool: 'Edit', input: { file_path: f('calc.py'), old_string: 'return a - b', new_string: 'return a + b' } },
      { tool: 'Bash', input: { command: 'grep -c "a + b" calc.py', description: 'Check the fix' } },
      { text: 'The function subtracted instead of adding.\n\nIt now returns `a + b`.\n\nRunning it prints 5, as it should.' },
    ];
  } },
  factsRule,
];
