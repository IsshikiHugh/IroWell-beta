// What the fake Claude answers in the forward suite (a session forwarded to a stand-in Slack).
const PLOT = process.env.IRO_TEST_PLOT || '/nonexistent/plot.png';
export default [
  // a turn with a log, a tool, then a reply and a question (and a picture it links to)
  { match: /Start the work/, steps: [
    { text: ':::log\n\nLooking at the tests first.\n\n:::' },
    { tool: 'Bash', input: { command: 'echo ok', description: 'Check' }, ask: false, result: 'ok' },
    { text: `:::reply\n\nDone: **3 tests** pass. See [plot.png](${PLOT}).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n:::\n\n:::ask[1]\n\nDelete \`old.js\` too?\n\n:::` },
  ] },
  // a turn that leaves nothing for the user
  { match: /Be quiet/, steps: [{ text: ':::log\n\nNothing to say.\n\n:::' }] },
  // two questions at once, then one
  { match: /Ask me two/, steps: [
    { tool: 'AskUserQuestion', input: { questions: [
      { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'big' }, { label: 'SQLite', description: 'small' }] },
      { question: 'Which port?', header: 'Port', multiSelect: false, options: [{ label: '8080' }, { label: '3000' }] },
    ] }, result: (input, answers) => JSON.stringify(answers) },
    { text: ':::reply\n\nNoted.\n\n:::' },
  ] },
  { match: /Ask me one/, steps: [
    { tool: 'AskUserQuestion', input: { questions: [{ question: 'Retry or fix?', header: 'Flaky', multiSelect: false, options: [{ label: 'Retry' }, { label: 'Fix' }] }] }, result: (input, answers) => JSON.stringify(answers) },
    { text: ':::reply\n\nOk.\n\n:::' },
  ] },
  // a tool permission
  { match: /Clean the build/, steps: [{ tool: 'Bash', input: { command: 'rm -rf build', description: 'Remove the build' }, ask: true, result: 'removed' }, { text: ':::reply\n\nCleaned.\n\n:::' }] },
  // a long turn (Stop ends it)
  { match: /Work for long/, steps: [{ sleep: 30000 }, { text: ':::reply\n\nFinally done.\n\n:::' }] },
];
