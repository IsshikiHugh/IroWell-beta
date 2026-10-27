// What the fake Claude answers in session.mjs.
import path from 'node:path';

// The answer to the last AskUserQuestion of this conversation, read from its tool result (as the model would).
const answered = (ctx) => {
  const e = [...ctx.chain()].reverse().find((x) => JSON.stringify(x.message?.content || '').includes('User has answered your questions'));
  return /="([^"]*)"/.exec(e.message.content[0].content)?.[1] || '';
};

export default [
  { match: /^Ask me which color I prefer/, steps: (m, ctx) => [
    { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which color do you prefer?', header: 'Color', multiSelect: false,
      options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] } },
    { sleep: 2000 }, // (nothing waits on the user for a moment: the page's bell goes)
    // (a getter: read when the step runs, after the question was answered)
    { tool: 'Write', get input() { return { file_path: path.join(ctx.session.cwd, 'color.txt'), content: answered(ctx) }; } },
    { text: 'ok' },
  ] },
  { match: /^Write b\.txt/, steps: (m, ctx) => [{ tool: 'Write', input: { file_path: path.join(ctx.session.cwd, 'b.txt'), content: 'b' } }, { text: 'ok2' }] },
];
