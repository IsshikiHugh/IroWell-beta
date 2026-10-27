// The fake Claude's replies for handover.mjs: a question (AskUserQuestion) that keeps a session busy until it
// is answered, and a recall of that answer that reads the conversation the CLI was resumed with.
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b.content === 'string' ? b.content : b.text || '')).join('\n') : '');
// The answer the user gave last in this conversation ('' if none).
const picked = (ctx) => ctx.chain().filter((e) => e.type === 'user').map((e) => /User has answered your questions: "[^"]*"="([^"]+)"/.exec(textOf(e.message?.content))?.[1]).filter(Boolean).pop() || '';

export default [
  // "Ask me which color I prefer, Red or Blue": the question, then the pick (a getter: read once answered)
  { match: /^Ask me which (\w+) I prefer, (\w+) or (\w+)/, steps: (m, ctx) => [
    { tool: 'AskUserQuestion', input: { questions: [{ question: `Which ${m[1]} do you prefer?`, header: m[1], multiSelect: false,
      options: [{ label: m[2], description: '' }, { label: m[3], description: '' }] }] } },
    { get text() { return picked(ctx) || 'no answer'; } },
  ] },
  { match: /^Which \w+ did I pick/, steps: (m, ctx) => [{ text: picked(ctx) || 'I don\'t know.' }] },
];
