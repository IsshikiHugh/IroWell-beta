// Replies for btw.mjs: /btw's side questions (a forked one-shot CLI), the next-prompt guess, and a long main
// turn that runs on until a side question has been asked.
import fs from 'node:fs';
import path from 'node:path';
import { facts } from './_f2.mjs';

// Written when a side question is asked: the long main turn waits for it, so the side question is answered
// while the main turn still runs.
const ASKED = path.join(process.env.CLAUDE_CONFIG_DIR, 'btw-asked');
const textOf = (c) => (typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));

export default [
  // the daemon's guess of the next prompt: one after the is_prime turn, none after the others
  { match: (t, ctx) => ctx.oneShot && t.startsWith('This is the end of a session'), steps: (m, ctx) => [{ text: /is_prime/.test(ctx.text) ? 'Now add unit tests for is_prime' : '-' }] },
  // a side question: the first comes with the daemon's preamble (and, in a re-forked thread, the earlier Q&A)
  { match: (t, ctx) => ctx.oneShot && (t.startsWith('(Side question.') || ctx.session.btw), steps: (m, ctx) => {
    const S = ctx.session, t = ctx.text, q = t.split('Next question: ').pop(); // (the question, past any recap)
    S.btw = true;
    fs.writeFileSync(ASKED, '');
    const before = S.btwLast || [...t.matchAll(/^A: (.*)$/gm)].pop()?.[1] || '';
    let answer = 'ok';
    if (/backwards/i.test(q)) answer = [...before].reverse().join('');
    else if (/previous side question/i.test(q)) answer = before;
    else if (/codeword/i.test(q)) answer = ctx.chain().filter((e) => e.type === 'user').flatMap((e) => [...textOf(e.message?.content).matchAll(/codeword ([A-Z]{3,})/g)].map((x) => x[1])).pop() || 'none';
    S.btwLast = answer;
    return [{ text: answer }];
  } },
  // the main turn that is busy while a side question is asked
  { match: /^Write 40 numbered one-sentence facts about rivers/, steps: () => {
    fs.rmSync(ASKED, { force: true });
    const lines = facts(40, 'rivers').split('\n');
    return (function* () {
      yield { text: lines.slice(0, 20).join('\n') };
      for (const end = Date.now() + 20000; !fs.existsSync(ASKED) && Date.now() < end;) yield { sleep: 100 };
      yield { sleep: 1200 }; // (the side answer reaches the page meanwhile)
      yield { text: lines.slice(20).join('\n') };
    })();
  } },
];
