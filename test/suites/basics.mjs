// No browser: every source file parses, the client's HTTP guards, what a session on this machine is told about
// remote ports, and a blank session (the model list, Claude Code's own system prompt).
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO, PORT, check, finish, startClient, daemonAsk } from '../lib.mjs';
import { work } from './_qa.mjs';

// ---- syntax of every source file (checked a few at a time) ----
{
  const ls = (dir, test) => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).filter(test).map((e) => `${dir}/${e.name}`);
  const sources = [
    ...['server', 'client', 'skills'].flatMap((d) => ls(d, (e) => e.isFile() && e.name.endsWith('.mjs'))),
    ...ls('skills', (e) => e.isDirectory()).flatMap((d) => ls(d, (e) => e.isFile() && e.name.endsWith('.mjs'))),
    ...ls('client/ui', (e) => e.name.endsWith('.js')),
    ...ls('plugins', (e) => e.isDirectory() && fs.existsSync(path.join(REPO, 'plugins', e.name, 'ui.js'))).map((d) => `${d}/ui.js`),
    'test/fakeslack.mjs',
  ];
  const run = promisify(execFile), todo = [...sources], bad = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let f; (f = todo.shift());) await run(process.execPath, ['--check', path.join(REPO, f)]).catch((e) => bad.push(`${f}: ${e.stderr}`));
  }));
  check(sources.length > 30 && !bad.length, `syntax of ${sources.length} source files${bad.length ? ':\n' + bad.join('\n') : ''}`);
}

// ---- the client's HTTP side ----
const WORK = work('basics-work');
const { client, req, cmd, token } = await startClient(PORT);
const post = (body, headers = { 'x-token': token }) => req('POST', '/cmd', { headers, body: JSON.stringify(body) });
check((await post({}, {})).status === 403, 'POST without token → 403');
check((await req('GET', '/', { host: 'evil.com:' + PORT })).status === 403, 'foreign Host header → 403');
check((await post({ type: 'sync' })).status === 400, 'internal commands are not exposed');
check((await Promise.all(['adopt', 'retire', 'toString'].map((type) => post({ type })))).every((r) => r.status === 400),
  'nor the ones between daemons, nor names that are not commands');
check(/img-src 'self' data: blob:/.test((await req('GET', '/')).headers['content-security-policy']), 'the page may load images only from itself');
check(/empty/.test((await cmd({ type: 'new', cwd: WORK, text: '  ' })).error || ''), 'empty first message is rejected');
check(/Not a directory/.test((await cmd({ type: 'new', cwd: '/no/such/dir', text: 'x' })).error || ''), 'missing directory is rejected');
{
  const r = await post({ type: 'nonsense' });
  check(r.status === 400 || /doesn't know/.test(r.body), 'unknown commands are refused');
}
check(Array.isArray((await cmd({ type: 'history' })).data), 'history lists sessions');

// This machine is no remote server (suites/ports.mjs has one): a session is told nothing about ssh, the remote
// skill's script says there is nothing to forward, and the client forwards nothing.
{
  const prompt = (await daemonAsk(process.env.IRO_DIR, { type: 'uiPrompt' }))?.data; // (the daemon's own: the client doesn't pass it on)
  check(prompt?.includes('# IroWell UI') && !/Remote machine|\{\{/.test(prompt), 'on this machine a session\'s system prompt has the UI part and nothing about a remote machine');
  let out = '';
  try { out = execFileSync(process.execPath, [path.join(REPO, 'skills', 'remote', 'port.mjs'), '5173'], { stdio: 'pipe' }).toString(); } catch (e) { out = String(e.stdout) + String(e.stderr); }
  check(/^5173 -> http:\/\/localhost:5173\/ +\(the user is on this machine/.test(out), `the remote skill's script says there is nothing to forward here (${out.trim()})`);
  check(/this machine/.test((await cmd({ type: 'openPort', port: 5173 })).error || ''), 'and the client forwards no port of this machine');
}

// ---- a blank session ----
// Before any session runs, the model list comes from a CLI started only to ask (a new session's draft names its model).
{
  const list = (await cmd({ type: 'models' })).data || [];
  check(list.some((m) => m.value === 'default' && m.resolvedModel), `the model list is there with no session running (${list.length})`);
}
const sid = (await cmd({ type: 'new', cwd: WORK, blank: true })).data?.sid;
check(!!sid, 'blank session starts');
// The same harness as the terminal's `claude`: Claude Code's own system prompt (the SDK's default replaces it
// with an empty one; the fake reports what it was given).
{
  const sys = (await cmd({ type: 'context', sid })).data?.categories?.find((c) => c.name === 'System prompt')?.tokens || 0;
  check(sys > 500, `Claude Code's system prompt is in the context (${sys} tokens)`);
}

client.kill('SIGTERM');
await finish();
