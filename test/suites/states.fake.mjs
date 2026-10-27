// What the fake Claude answers in the states suite.
export default [
  // a foreground tool that runs a few seconds: the activity line names it and counts
  { match: /^Run a four-second command/, steps: [{ tool: 'Bash', input: { command: 'sleep 4', description: 'Four seconds' }, ask: false }, { text: 'done' }] },
  // a background shell that runs on after the turn (until stopped)
  { match: /^Start a background wait/, steps: [{ background: { command: 'sleep 600', description: 'Long wait' } }, { text: 'started' }] },
  // a turn long enough to leave the session while it runs
  { match: /^Take a moment/, steps: [{ sleep: 1500 }, { text: 'ok' }] },
  // a turn that runs until it is stopped
  { match: /^Run sleep 30/, steps: [{ tool: 'Bash', input: { command: 'sleep 30', description: 'Sleep 30 s' }, ask: false }, { text: 'slept' }] },
];
