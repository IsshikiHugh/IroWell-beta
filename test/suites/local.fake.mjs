// What the fake Claude answers in the local suite.
export default [
  // a session that waits for an answer (busy), with a word to remember across a detach and a reopen
  { match: /^Remember the codeword \w+ and ask me/, steps: [{ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which color do you prefer?', header: 'Color', multiSelect: false,
    options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] } }, { text: 'ok' }] },
];
