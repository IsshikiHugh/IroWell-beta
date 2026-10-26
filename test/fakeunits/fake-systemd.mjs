// A user systemd for the tests (a Mac has none): `systemd-run --user`, and as much of `systemctl --user` and
// `journalctl --user` as the daemon asks. Units are files in $FAKE_UNITS_DIR: <inv>.json (the unit), <inv>.log
// (what it printed: the journal) and <inv>.exit ("exited <code>" or "killed <signal>") once it has ended.
// The shims beside this file run it: <tool> <args>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const DIR = process.env.FAKE_UNITS_DIR || path.join(os.tmpdir(), 'iro-fake-units');
fs.mkdirSync(DIR, { recursive: true });
const [tool, ...args] = process.argv.slice(2);
const f = (inv, ext) => path.join(DIR, `${inv}.${ext}`);
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const units = () => fs.readdirSync(DIR).filter((x) => x.endsWith('.json')).map((x) => JSON.parse(read(path.join(DIR, x)))).sort((a, b) => a.mono - b.mono);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runs = (u) => read(f(u.inv, 'exit')) == null && alive(u.pid);
const latest = (name) => units().filter((u) => u.unit === name || u.unit === `${name}.service`).pop();

if (tool === 'systemd-run') {
  let unit = `run-u${process.pid}`, cwd = os.homedir();
  const rest = [...args];
  while (rest.length && rest[0].startsWith('-')) {
    const a = rest.shift();
    if (a === '--') break;
    if (a.startsWith('--unit=')) unit = a.slice(7);
    else if (a === '--unit' || a === '-u') unit = rest.shift();
    else if (a.startsWith('--working-directory=')) cwd = a.slice(20);
    else if (['-p', '--property', '-E', '--setenv', '--description'].includes(a)) rest.shift();
  }
  unit = unit.endsWith('.service') ? unit : `${unit}.service`;
  const inv = randomBytes(16).toString('hex');
  const out = fs.openSync(f(inv, 'log'), 'a');
  const p = spawn('/bin/sh', ['-c', `"$@"; echo "exited $?" > '${f(inv, 'exit')}'`, 'sh', ...rest], { cwd, detached: true, stdio: ['ignore', out, out], env: { PATH: process.env.PATH, HOME: os.homedir() } });
  p.unref();
  fs.writeFileSync(f(inv, 'json'), JSON.stringify({ unit, inv, pid: p.pid, mono: Math.round(os.uptime() * 1e6), desc: rest.join(' '), cwd }));
  console.error(`Running as unit: ${unit}; invocation ID: ${inv}`);
} else if (tool === 'systemctl') {
  const verb = args.find((a) => !a.startsWith('-'));
  if (verb === 'show-environment') console.log(`HOME=${os.homedir()}`);
  else if (verb === 'list-units') for (const u of units()) { if (runs(u)) console.log(`${u.unit} loaded active running ${u.desc}`); }
  else if (verb === 'show') {
    const names = args.slice(args.indexOf('--') + 1);
    console.log(names.map((n) => {
      const u = latest(n);
      if (!u) return `Id=${n}\nActiveState=inactive\nTransient=no`;
      const exit = read(f(u.inv, 'exit'))?.trim().split(' ');
      return [`Id=${u.unit}`, `InvocationID=${u.inv}`, `MainPID=${runs(u) ? u.pid : 0}`, `ActiveEnterTimestampMonotonic=${u.mono}`, `ExecMainStartTimestampMonotonic=${u.mono}`,
        'Transient=yes', `Description=${u.desc}`, `WorkingDirectory=${u.cwd}`, `ActiveState=${runs(u) ? 'active' : 'inactive'}`,
        ...(exit ? [`ExecMainCode=${exit[0] === 'exited' ? 1 : 2}`, `ExecMainStatus=${exit[1]}`] : [])].join('\n');
    }).join('\n\n'));
  } else if (verb === 'stop') {
    for (const n of args.slice(args.indexOf('--') + 1)) {
      const u = latest(n);
      if (!u || !runs(u)) continue;
      fs.writeFileSync(f(u.inv, 'exit'), 'killed 15');
      try { process.kill(-u.pid, 'SIGTERM'); } catch {}
    }
  } else { console.error(`fake systemctl: ${verb}?`); process.exit(1); }
} else if (tool === 'journalctl') {
  const name = args[args.indexOf('-u') + 1];
  for (const u of units().filter((x) => x.unit === name)) {
    for (const l of (read(f(u.inv, 'log')) || '').split('\n').filter(Boolean)) console.log(JSON.stringify({ MESSAGE: l, _SYSTEMD_USER_UNIT: u.unit, _SYSTEMD_INVOCATION_ID: u.inv }));
    const exit = read(f(u.inv, 'exit'))?.trim().split(' ');
    if (exit) console.log(JSON.stringify({ MESSAGE: `${u.unit}: Main process exited`, USER_UNIT: u.unit, USER_INVOCATION_ID: u.inv, EXIT_CODE: exit[0], EXIT_STATUS: exit[1], ...(exit[1] !== '0' ? { UNIT_RESULT: exit[0] === 'exited' ? 'exit-code' : 'signal' } : {}) }));
  }
}
