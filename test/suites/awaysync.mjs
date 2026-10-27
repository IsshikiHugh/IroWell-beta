// Away mode's settings, the same on every server (no model calls): this machine's daemon and a server's (fake ssh;
// its own state dir under a scratch $HOME). The client keeps them (time limits, Slack, the agent's prompt) and gives
// them to each daemon: a change on one server's page reaches the other, and a daemon that connects later gets them.
// The page can't send the commands that carry them (the Slack tokens are in them).
import { PORT, killDaemon, check, until, finish, startClient, daemonAsk, fakeHost } from '../lib.mjs';
import { fakeSlack } from '../fakeslack.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LDIR = process.env.IRO_DIR; // this machine's daemon state
const slack = await fakeSlack();
const { dir: RDIR, env } = fakeHost('awaybox', { shellEnv: { IRO_TEST_SLACK_API: slack.api }, extra: { IRO_NO_USAGE_RECORD: '1', IRO_TEST_SLACK_API: slack.api } });
fs.mkdirSync(LDIR, { recursive: true });
const { client, token, req, cmd } = await startClient(PORT, { env, host: 'awaybox', fresh: false });
const on = (target, body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token, 'x-target': target }, body: JSON.stringify(body) }).then((r) => ({ status: r.status, ...(r.body.startsWith('{') ? JSON.parse(r.body) : {}) }));
const kept = () => { try { return JSON.parse(fs.readFileSync(path.join(LDIR, 'away-shared.json'), 'utf8')); } catch { return null; } };
try {
  await until(async () => (await cmd({ type: 'awayState' })).data, 30000, 'the server is connected');

  // ---- set on the server, with this machine's daemon not connected: kept here ----
  check((await cmd({ type: 'awaySettings', giveUpMin: 77 })).data?.giveUpMin === 77, 'the server takes a new time limit');
  const ME = 'U0USER0001', APP = 'xapp-1-A0TEST-1234567890-abcdef', BOT = 'xoxb-1234567890-abcdefghij';
  check((await cmd({ type: 'awaySlackSet', appToken: APP, botToken: BOT, userId: ME })).data?.set, 'and the Slack app (tried from there)');
  check(kept()?.giveUpMin === 77 && kept().slack?.botToken === BOT && (fs.statSync(path.join(LDIR, 'away-shared.json')).mode & 0o777) === 0o600,
    `the client keeps them, where only this user reads them (${JSON.stringify(kept())?.slice(0, 120)})`);

  // ---- this machine's daemon connects: it gets them ----
  check(await until(async () => (await on('local', { type: 'awayState' })).data?.giveUpMin === 77, 30000), 'this machine\'s daemon, connected later, gets the time limit');
  const slackHere = (await on('local', { type: 'awaySlack' })).data;
  check(slackHere?.set && slackHere.userId === ME && !JSON.stringify(slackHere).includes(BOT), `and the Slack app (its tokens never shown) (${JSON.stringify(slackHere)?.slice(0, 120)})`);

  // ---- set here: it reaches the server ----
  check((await on('local', { type: 'awayAgentPromptSet', text: 'Ask me only about pushes.' })).data?.own, 'this machine takes an agent prompt');
  check(await until(async () => (await cmd({ type: 'awayAgentPrompt' })).data?.text === 'Ask me only about pushes.', 5000), 'the server gets it');
  await on('local', { type: 'awaySettings', alignRemindMin: 12 });
  check(await until(async () => (await cmd({ type: 'awayState' })).data?.alignRemindMin === 12, 5000) && kept()?.alignRemindMin === 12, 'and a reminder time set here');
  await on('local', { type: 'awaySlackClear' });
  check(await until(async () => (await cmd({ type: 'awaySlack' })).data?.set === false, 5000) && kept()?.slack === null, 'Slack cleared here is cleared there too');

  // ---- a page can't send them ----
  check((await on('ssh:awaybox', { type: 'awayConfig' })).status === 400 && (await on('local', { type: 'awayConfigSet', giveUpMin: 5 })).status === 400, 'the page can\'t read or set them directly');
} finally {
  client.kill();
  killDaemon(LDIR);
  killDaemon(RDIR);
  slack.close();
}
finish();
