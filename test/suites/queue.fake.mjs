// What the fake Claude answers in the queue suite.
export default [
  // a turn that stays busy until the suite creates the file it names in the session's folder (or Stop / Send now)
  { match: /^Wait for (\S+?)\. Then reply with just: (\S+)$/,
    steps: (m) => [{ tool: 'Bash', input: { command: `until [ -e ${m[1]} ]; do sleep 0.1; done`, description: `Wait for ${m[1]}` }, ask: false }, { text: m[2] }] },
];
