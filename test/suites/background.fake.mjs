// What Claude does in the background suite. The messages the real CLI sends for these (checked in test/real/triggers.mjs;
// shapes as Claude Code 2.1.310 wrote them):
// - a background Bash call's end: task_notification, then a `<task-notification>` user message (origin
//   { kind: 'task-notification' }) in a turn of its own: the fake's `background`, here through Bash run_in_background.
// - a background subagent that reports while the turn still runs: task_started (is_backgrounded) after the Agent
//   call, task_notification, and the `<task-notification>` read in that turn (its transcript keeps it as a
//   queued_command attachment, not a user entry): `raw` steps below.
// - another session's message (SendMessage): a user entry with isMeta, turnOrigin 'peer', origin { kind: 'peer',
//   from, name, fromMode, body } and the "Another Claude session sent a message:" envelope: `deliver` below.
// - a schedule firing (CronCreate): a user entry with the prompt as it is, isMeta, turnOrigin 'scheduled',
//   wakeupSource 'schedule_wakeup', no origin: `deliver` below.
const AGENT = 'amid0001';
const report = '<task-notification>\n<task-id>amid0001</task-id>\n<status>completed</status>\n<summary>Agent "Reply with fixed string" finished</summary>\n'
  + '<result>MID-REPORT-3</result>\n<usage><subagent_tokens>42745</subagent_tokens><tool_uses>0</tool_uses><duration_ms>2213</duration_ms></usage>\n</task-notification>';
const peer = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/44974.sock" from-name="work-trig-b" from-mode="bypass">\n'
  + 'PING-FROM-B, reply with just ack.\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.';

export default [
  // ---- triggers ----
  { match: 'Start a background command', steps: [
    { tool: 'Bash', input: { command: 'sleep 0.3; echo TRIG-DONE', description: 'Sleep then print marker', run_in_background: true } },
    { text: 'started' },
  ] },
  { match: 'Launch a subagent and keep working', steps: [
    { tool: 'Agent', input: { description: 'Reply with fixed string', prompt: 'Reply with exactly MID-REPORT-3', subagent_type: 'general-purpose', run_in_background: true },
      result: `Async agent launched successfully.\nagentId: ${AGENT}` },
    { raw: { type: 'system', subtype: 'task_started', task_id: AGENT, description: 'Reply with fixed string', subagent_type: 'general-purpose', task_type: 'local_agent', is_backgrounded: true } },
    { tool: 'Bash', input: { command: 'sleep 0.2', description: 'Work in the foreground' } },
    { raw: { type: 'system', subtype: 'task_notification', task_id: AGENT, status: 'completed', summary: 'MID-REPORT-3', usage: { total_tokens: 42745, tool_uses: 0, duration_ms: 2213 } } },
    { raw: { type: 'user', message: { role: 'user', content: report }, isReplay: true, origin: { kind: 'task-notification' }, timestamp: new Date().toISOString() } },
    { text: 'after' },
  ] },
  { match: 'Wait for a message from another session', steps: [
    { text: 'waiting' },
    { deliver: { content: peer, replay: true, steps: [{ text: 'ack' }], entry: { isMeta: true, turnOrigin: 'peer',
      origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/44974.sock', name: 'work-trig-b', fromMode: 'bypass', body: 'PING-FROM-B, reply with just ack.' } } } },
  ] },
  { match: 'Schedule a prompt', steps: [
    { tool: 'CronCreate', input: { cron: '43 17 26 10 *', prompt: 'Reply with just: TICK-9', recurring: false },
      result: 'Scheduled one-shot task f1a32822 (43 17 26 10 *). It will fire once then auto-delete.' },
    { text: 'scheduled' },
    { deliver: { content: 'Reply with just: TICK-9', replay: true, entry: { isMeta: true, turnOrigin: 'scheduled', wakeupSource: 'schedule_wakeup' } } },
  ] },

  // ---- units: what Claude starts outside its CLI ----
  // `Start the units: {sr, u1, u2, bf1, bf2}`: two units with systemd-run (they end once go-units is there, one
  // printing and exiting 3), a job left running with nohup, and a call that only names two more units.
  { match: /^Start the units: (.*)$/, steps: (m) => {
    const { sr, u1, u2, bf1, bf2 } = JSON.parse(m[1]);
    const wait1 = "bash -c 'while [ ! -e go-units ]; do sleep 0.2; done; echo UNIT-OUT-7; exit 3'", wait2 = "bash -c 'while [ ! -e go-units ]; do sleep 0.2; done; exit 0'";
    return [
      { tool: 'Bash', input: { command: `${sr} --user --unit=${u1} --working-directory=$PWD ${wait1}; ${sr} --user --unit=${u2} --working-directory=$PWD ${wait2}`, description: 'Start two units' } },
      { tool: 'Bash', input: { command: 'nohup node job.js > job.log 2>&1 &', description: 'Start the job' } },
      { tool: 'Bash', input: { command: `echo "for later: systemd-run --user --unit=${bf1} sleep 600; systemd-run --user --unit=${bf2} sleep 600"`, description: 'Note the next units' } },
      { text: 'launched' },
    ];
  } },
  // a turn that stays busy until the suite lets it go (the file go-turn)
  { match: 'Hold on until go-turn', steps: [
    { tool: 'Bash', input: { command: 'while [ ! -e go-turn ]; do sleep 0.1; done', description: 'Wait for go-turn' } },
    { text: 'held' },
  ] },
];
