// The fake Claude of login.mjs: a Claude Code not logged in (`auth status` says so, and every turn is answered
// "Not logged in" by the CLI itself), until it is: a sign-in code accepted by `auth login`, or the suite logging
// it in "from a terminal" (the file LOGGED_IN). Nothing reaches the network.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOGGED_IN = path.join(process.env.CLAUDE_CONFIG_DIR, 'fake-logged-in');
export const GOOD_CODE = 'good-code#good-state';
const loggedIn = () => fs.existsSync(LOGGED_IN);
const NOT = 'Not logged in · Please run /login';

export default [
  // (the CLI's own answer, as "<synthetic>": no model turn; also to the daemon's one-off questions)
  { match: () => !loggedIn(), steps: (m, ctx) => {
    ctx.lastText = NOT;
    return [{ raw: { type: 'assistant', message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: NOT }],
      stop_reason: 'stop_sequence', stop_sequence: '', usage: { input_tokens: 0, output_tokens: 0 } } } }];
  } },
];

// `claude auth status --json` and `claude auth login [--console]`.
export function cli(argv) {
  if (argv[0] !== 'auth') return false;
  if (argv[1] === 'status') {
    console.log(JSON.stringify(loggedIn() ? { loggedIn: true, authMethod: 'claude.ai', email: 'test@example.com', orgId: 'org-test' } : { loggedIn: false, authMethod: 'none' }));
    return true;
  }
  if (argv[1] === 'login') return login(argv.includes('--console'));
  return false;
}

// As the real one: it opens $BROWSER on a link whose page calls back to a port here, prints the link whose page
// shows a code instead, and reads codes: a malformed one is said and another is read; a wrong one ends it.
function login(useConsole) {
  const link = (redirect) => `https://${useConsole ? 'platform.claude.com' : 'claude.com/cai'}/oauth/authorize?code=true&client_id=fake&response_type=code`
    + `&redirect_uri=${encodeURIComponent(redirect)}&scope=user%3Ainference&state=fake-state`;
  if (process.env.BROWSER) spawnSync(process.env.BROWSER, [link('http://localhost:54545/callback')]);
  process.stdout.write(`Opening browser to sign in…\nBrowser didn't open? Use the url below to sign in:\n\n${link('https://platform.claude.com/oauth/code/callback')}\n\nPaste code here if prompted > `);
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const code = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!code.includes('#')) { process.stdout.write('\nInvalid code. Please make sure the full code was copied\nPaste code here if prompted > '); continue; }
        if (code === GOOD_CODE) { fs.writeFileSync(LOGGED_IN, ''); console.log('\nLogin successful.'); }
        else { console.log('\nLogin failed: Request failed with status code 400'); process.exitCode = 1; }
        return resolve(true);
      }
    });
  });
}
