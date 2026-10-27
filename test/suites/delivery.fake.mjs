// What the fake Claude answers in the delivery suite.
export default [
  // a tool call that asks for approval (default mode)
  { match: /^Use the Write tool to create hi\.txt/, steps: [{ tool: 'Write', input: { file_path: 'hi.txt', content: 'hi from remote\n' } }, { text: 'done' }] },
  { match: /^Ask me which color I prefer/, steps: [{ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which color do you prefer?', header: 'Color', multiSelect: false,
    options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] } }, { text: 'noted' }] },
  // a command that runs until it is interrupted
  { match: /^Run a 30-second command/, steps: [{ tool: 'Bash', input: { command: 'sleep 30', description: 'Sleep 30 s' }, ask: false }, { text: 'slept' }] },
];
