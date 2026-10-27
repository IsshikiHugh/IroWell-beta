// What only the real Claude Code can show of delivery (test/suites/delivery.mjs tests the rest on the fake):
// an AskUserQuestion answer, sent the way the daemon sends it, reaches the model; an interrupt stops a real
// foreground Bash child under the real CLI, and the session answers afterwards. Three short turns.
import { PORT, cleanEnv, check, until, wait, finish, startClient, eventStream, workDir } from '../lib.mjs';

const WORK = workDir('real-delivery');
const { client, token, cmd } = await startClient(PORT, { env: cleanEnv() });
const T = eventStream(PORT, token, cmd);
await until(() => T.up, 15000, 'transport up');

// ---- AskUserQuestion: the answer reaches the model ----
const sid = (await cmd({ type: 'new', cwd: WORK, mode: 'default',
  text: 'Use the AskUserQuestion tool to ask me which color I prefer, with options Red and Blue. After I answer, reply with just the color I picked.' })).data.sid;
await until(() => T.of(sid).some((e) => e.kind === 'approval'), 120000, 'the question');
const q = T.of(sid).find((e) => e.kind === 'approval');
check(q?.tool === 'AskUserQuestion', 'the CLI asks AskUserQuestion through the page');
await cmd({ type: 'approve', sid, rid: q.rid, allow: true, answers: { [q.input.questions[0].question]: 'Blue' } });
await until(() => T.results(sid).length >= 1, 120000, 'the answer');
check(/blue/i.test(T.lastText(sid)), `the model got the answer (${JSON.stringify(T.lastText(sid))})`);

// ---- an interrupt stops a running foreground Bash ----
const n = T.events.length;
await cmd({ type: 'send', sid, text: 'Run this exact bash command in the foreground (do not use run_in_background): node -e "setTimeout(() => console.log(1), 30000)"' });
const bash = () => T.events.slice(n).some((e) => e.kind === 'msg' && e.msg.type === 'assistant' && e.msg.message.content.some((x) => x.type === 'tool_use' && x.name === 'Bash'));
await until(() => bash() || T.events.slice(n).some((e) => e.kind === 'approval'), 120000, 'Bash started');
await until(() => T.events.slice(n).some((e) => e.kind === 'approval'), 2000); // (the approval may follow the tool_use)
const b = T.events.slice(n).find((e) => e.kind === 'approval');
if (b) await cmd({ type: 'approve', sid, rid: b.rid, allow: true });
await wait(3000); // (the command is running)
check(T.state(sid) === 'running', 'state running during the Bash command');
const t0 = Date.now();
await cmd({ type: 'interrupt', sid });
await until(() => T.state(sid) === 'idle', 20000, 'idle after the interrupt');
check(Date.now() - t0 < 15000, `the interrupt stopped the 30 s command in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
check(/still here/i.test(await T.ask(sid, 'Reply with just: still here')), 'the session is usable after the interrupt');

T.req.destroy();
client.kill('SIGTERM');
finish();
