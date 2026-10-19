// What the irowell skills' scripts share (not a skill: it has no SKILL.md): talking to the IroWell daemon of
// this host, the one that runs the session, which answers what they ask.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SOCK = path.join(process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding'), 'daemon.sock');

export const fail = (text) => { console.error(text); process.exit(1); };

// Sends each of `cmds` (with the ids 1, 2, …) once the daemon has said hello, and calls `onReply(reply, cmd)`
// with each answer as it comes. Resolves once every one has its answer. With no daemon to ask it fails with
// `unreachable(why)`; it fails too when the daemon closes the connection, or hasn't answered within `ms`.
export function ask(cmds, { unreachable, onReply, ms = 20000 }) {
  return new Promise((resolve) => {
    const sock = net.connect(SOCK);
    sock.setEncoding('utf8');
    sock.on('error', (e) => fail(unreachable(e.code || e.message)));
    const timer = setTimeout(() => fail('The IroWell daemon did not answer.'), ms);
    let left = cmds.length, buf = '';
    sock.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        let m;
        try { m = JSON.parse(buf.slice(0, i)); } catch {}
        buf = buf.slice(i + 1);
        if (m?.type === 'hello') cmds.forEach((cmd, n) => sock.write(JSON.stringify({ ...cmd, id: n + 1 }) + '\n'));
        else if (m?.type === 'reply' && cmds[m.id - 1]) {
          onReply(m, cmds[m.id - 1]);
          if (--left > 0) continue;
          // (what the daemon does from here on is no error any more)
          clearTimeout(timer);
          sock.removeAllListeners('close').destroy();
          resolve();
          return;
        }
      }
    });
    sock.on('close', () => fail('The IroWell daemon closed the connection.'));
  });
}

// Exits with `status` once what was printed is all out: to a pipe, stdout is written asynchronously, and
// exiting at once cuts off what is past the first 64 KB.
export const exit = (status = 0) => process.stdout.write('', () => process.exit(status));
