// What the fake Claude answers in the away suite: the away agent, told the user did not answer in time.
export default [
  { match: /\[Away\] ⏰ The user has not answered/, steps: [{ text: 'No answer from you: went with a.' }] },
];
