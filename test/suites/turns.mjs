// Around a turn: the event log's trim; /clear and /detach waiting in the queue; the moment (1 s) a message is held
// before Claude gets it, and what Stop, a rewind, Detach and Ctrl+C do in it; where a dialog opens, and press and
// hold; a new session and a branch shown before the server answers; streamed text typed out; text with no marker;
// request cards. Claude is the fake (its built-in replies: "ok", and the codeword it was told, if it was).
import { PORT, check, until, wait, startSuite, addFolder, eventStream, workDir, transcript, logNow, routeCmd, endSuite } from '../lib.mjs';
import { rpcOf, stageFeed, sidePage, blankSession, openSession } from './_qc.mjs';

process.env.IRO_COMPACT_MS = '500'; // the event log is trimmed every half second (else every minute)
const WORK = workDir('turns-work');
const FOLDER = `.folder[data-dir="${WORK}"]`;
const api = await startSuite(PORT);
const { page, errors, token } = api;
const rpc = rpcOf(api);
await stageFeed(page.context());
let nativeDialogs = 0;
page.on('dialog', (d) => { nativeDialogs++; d.dismiss(); }); // the page draws its own (ui/dialog.js)
await addFolder(page, WORK);

// One stream for the whole suite: what the pages hear.
const T = eventStream(PORT, token);
await until(() => T.up, 10000, 'the event stream');
const of = (sid) => T.events.filter((e) => e.sid === sid);
const has = (sid, kind) => of(sid).some((e) => e.kind === kind);
const at = (sid, test) => of(sid).find(test)?.seq ?? 0;
const isResult = (e) => e.kind === 'msg' && e.msg.type === 'result';
const results = (sid) => of(sid).filter(isResult);
const texts = (sid) => of(sid).filter((e) => e.kind === 'user_text');
const logOf = async (sid) => (await logNow(PORT, token)).filter((e) => e.sid === sid);
const active = () => page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);

// ---- the event log keeps only what a gone session's row needs; an archived one goes entirely ----
{
  const kept = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  const gone = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  await rpc({ type: 'send', sid: kept, text: 'hello' });
  await until(() => results(kept).length === 1, 15000, 'the answer to hello');
  const before = (await logOf(kept)).length;
  await rpc({ type: 'close', sid: kept });
  await rpc({ type: 'archive', sid: gone });
  const rowOnly = (k) => k.every((e) => ['created', 'meta', 'closed', 'state'].includes(e.kind)) && k.find((e) => e.kind === 'created')?.dormant && k.some((e) => e.kind === 'closed');
  let log = [];
  await until(async () => { log = await logNow(PORT, token); return rowOnly(log.filter((e) => e.sid === kept)) && !log.some((e) => e.sid === gone); }, 10000); // (trimmed every half second)
  const k = log.filter((e) => e.sid === kept);
  check(k.length < before && rowOnly(k), `a closed session keeps only its row in the log (${before} → ${k.map((e) => e.kind)})`);
  check(!log.some((e) => e.sid === gone), 'an archived one leaves nothing');
  await rpc({ type: 'archive', sid: kept });
}

// ---- /clear and /detach wait their turn in the session's queue; the server runs them then ----
{
  const A = await blankSession(rpc, WORK, 'queue-detach');
  check(/can't be queued/.test((await rpc({ type: 'queue', sid: A, op: 'add', text: '/help' })).error || ''), 'a command that only opens a panel is not one for the queue');
  await rpc({ type: 'send', sid: A, text: 'one turn' });
  await rpc({ type: 'queue', sid: A, op: 'add', text: '/detach' });
  check(await until(() => of(A).some((e) => e.kind === 'queue' && e.items.length === 1 && e.items[0].text === '/detach'), 5000) && !has(A, 'closed'),
    'a /detach sent during a turn is listed in the queue, and the session runs on');
  await until(() => has(A, 'closed'), 15000, 'the queued /detach');
  check(at(A, isResult) > 0 && at(A, (e) => e.kind === 'closed') > at(A, isResult), 'it detaches the session once the turn is over');

  // /clear with a message behind it: the session is archived, and the message starts the fresh one
  const B = await blankSession(rpc, WORK, 'queue-clear', page);
  await page.fill('#input', 'half typed');
  await rpc({ type: 'send', sid: B, text: 'a turn' });
  await rpc({ type: 'queue', sid: B, op: 'add', text: '/clear' });
  await rpc({ type: 'send', sid: B, text: 'after the clear' });
  check(await until(() => of(B).some((e) => e.kind === 'queue' && e.items.map((i) => i.text).join() === '/clear,after the clear'), 5000), 'a /clear and the message after it wait in the queue, in order');
  await until(() => has(B, 'archived'), 15000, 'the queued /clear');
  const next = T.events.find((e) => e.kind === 'created' && e.seq > at(B, isResult) && e.title === 'after the clear');
  check(at(B, isResult) > 0 && at(B, (e) => e.kind === 'archived') > at(B, isResult) && texts(B).length === 1,
    'the /clear archives the session once the turn is over; the message behind it was not sent there');
  check(next?.cwd === WORK && texts(next.sid).map((e) => e.text).join() === 'after the clear',
    `that message starts a fresh session in the folder (${JSON.stringify(next && { cwd: next.cwd, title: next.title })})`);
  // (the page hears it on its own stream, which can be behind the test's)
  await page.waitForFunction(() => document.querySelector('.sess.active .sess-title')?.textContent === 'after the clear' && document.getElementById('input').value === 'half typed'
    && ![...document.querySelectorAll('.sess-title')].some((t) => t.textContent.includes('queue-clear')), null, { timeout: 5000 }).catch(() => {});
  check(await active() === 'after the clear' && await page.inputValue('#input') === 'half typed' && await page.locator('.sess-title', { hasText: 'queue-clear' }).count() === 0,
    `the page that had it open shows the fresh session, with what was typed (${await active()}, ${JSON.stringify(await page.inputValue('#input'))})`);
  await page.fill('#input', '');
  await until(() => results(next.sid).length === 1, 15000, 'the fresh session\'s answer');

  // /clear with nothing behind it: a draft in the folder, as an unqueued /clear gives
  const C = await blankSession(rpc, WORK, 'queue-clear2', page);
  await rpc({ type: 'send', sid: C, text: 'a turn' });
  await rpc({ type: 'queue', sid: C, op: 'add', text: '/clear' });
  await until(() => has(C, 'archived'), 15000, 'the second queued /clear');
  await page.waitForFunction(() => document.querySelector('.draft-intro') && ![...document.querySelectorAll('.sess-title')].some((t) => t.textContent.includes('queue-clear2')), null, { timeout: 5000 }).catch(() => {});
  check(await page.locator('.draft-intro').count() === 1 && await page.locator('.sess-title', { hasText: 'queue-clear2' }).count() === 0, 'a queued /clear with nothing behind it leaves a new draft open');

  // typed with nothing going on: at once, and /detach asks nothing
  const D = await blankSession(rpc, WORK, 'queue-idle', page);
  const asked = await page.locator('.dlg-back').count();
  await page.fill('#input', '/detach');
  await page.press('#input', 'Enter');
  await until(() => has(D, 'closed'), 10000);
  check(has(D, 'closed') && !has(D, 'queue') && await page.locator('.dlg-back').count() === asked, 'typed in an idle session, /detach detaches it at once, without asking');
  await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-detached'), null, { timeout: 5000 }).catch(() => {});
  check(/st-detached/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'its row goes grey');
  for (const sid of [A, D, next.sid]) await rpc({ type: 'archive', sid });
}

// ---- a message that starts a turn is held a moment (1 s) before the CLI gets it: Stop then takes it back ----
{
  // Stop right away: out of the conversation (for a page that opens later too), its text returned, never sent
  const A = await blankSession(rpc, WORK, 'hold-stop');
  await rpc({ type: 'send', sid: A, text: 'Remember the codeword ALPHA' });
  const stopped = (await rpc({ type: 'interrupt', sid: A, reclaim: true })).data;
  await until(() => has(A, 'unsent'), 5000);
  check(stopped?.unsent?.text === 'Remember the codeword ALPHA' && !stopped.unsent.first, `a Stop within the moment takes the message back, with its text (${JSON.stringify(stopped)})`);
  check(texts(A).length === 1 && of(A).find((e) => e.kind === 'unsent')?.uuid === texts(A)[0].uuid && T.state(A) === 'idle',
    'the pages are told it is gone, and the session is idle again');
  check(!(await logOf(A)).some((e) => e.kind === 'user_text'), 'the log no longer has it');

  // not stopped: it goes after the moment, and Claude answers it (and never heard the one taken back)
  await rpc({ type: 'send', sid: A, text: 'What is the codeword?' });
  await until(() => results(A).length === 1, 15000, 'the answer to the codeword question');
  const sent = texts(A).at(-1);
  check(results(A).length === 1 && results(A)[0].ts - sent.ts >= 950 && of(A).filter((e) => e.kind === 'unsent').length === 1,
    `a message not stopped goes to Claude a moment later (answered ${results(A)[0]?.ts - sent.ts} ms after it was sent)`);
  check(T.lastText(A) === 'I don\'t know the codeword.', `the message taken back never reached Claude (${T.lastText(A)})`);

  // a second message in the moment: the first goes at once, the second waits its turn in the queue
  await rpc({ type: 'send', sid: A, text: 'first' });
  await rpc({ type: 'send', sid: A, text: 'second' });
  await until(() => results(A).length === 3, 15000, 'both answers');
  check(results(A).length === 3 && of(A).some((e) => e.kind === 'queue' && e.items.length === 1) && of(A).filter((e) => e.kind === 'unsent').length === 1,
    'a second message sent in the moment lets the first go; it queues, and both are answered');

  // a page from before the hold can't put a message back: its Stop lets the message go (and stops it, as always)
  const n = texts(A).length;
  await rpc({ type: 'send', sid: A, text: 'third' });
  const old = (await rpc({ type: 'interrupt', sid: A })).data;
  await until(() => texts(A).length === n + 1 && results(A).length === 4 && T.state(A) === 'idle', 15000, 'the stopped turn\'s end');
  check(!old && of(A).filter((e) => e.kind === 'unsent').length === 1 && (await logOf(A)).filter((e) => e.kind === 'user_text').length === 4,
    `a Stop that doesn't ask for the message back leaves it sent (${JSON.stringify(old)})`);

  // Detach in the moment: the message comes back with the reply (its CLI stops)
  const answered = results(A).length;
  await rpc({ type: 'send', sid: A, text: 'Remember the codeword BRAVO' });
  const closed = (await rpc({ type: 'close', sid: A, reclaim: true })).data;
  await until(() => has(A, 'closed'), 5000);
  check(closed?.unsent?.text === 'Remember the codeword BRAVO' && of(A).filter((e) => e.kind === 'unsent').length === 2 && results(A).length === answered
    && !transcript(T.claudeId(A)).includes('BRAVO'), `Detach in the moment takes the message back too (${JSON.stringify(closed)})`);

  // rewound to in the moment: it is simply taken back; the session stays
  const B = await blankSession(rpc, WORK, 'hold-rewind');
  await rpc({ type: 'send', sid: B, text: 'rewind me' });
  await until(() => texts(B).length === 1, 5000);
  const rew = (await rpc({ type: 'rewind', sid: B, uuid: texts(B)[0].uuid })).data;
  await until(() => has(B, 'unsent') && T.state(B) === 'idle', 5000); // (the stream's events can come after the answer)
  check(rew?.text === 'rewind me' && has(B, 'unsent') && T.state(B) === 'idle' && !has(B, 'closed'), `a rewind to the message held takes it back (${JSON.stringify(rew)})`);

  // the first message of a new session, stopped: the session goes with it
  const first = (await rpc({ type: 'new', cwd: WORK, text: 'never mind' })).data.sid;
  const gone = (await rpc({ type: 'interrupt', sid: first, reclaim: true })).data;
  await until(() => has(first, 'archived'), 5000);
  check(gone?.unsent?.first && gone.unsent.text === 'never mind' && has(first, 'unsent') && has(first, 'archived'), `a new session's first message, stopped, takes the session with it (${JSON.stringify(gone)})`);

  // in the page: Enter, then Ctrl+C
  await openSession(page, 'hold-rewind');
  await page.waitForFunction(() => !document.getElementById('input').disabled, null, { timeout: 10000 }).catch(() => {});
  await page.fill('#input', 'half a sentence');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !document.getElementById('stop').disabled, null, { timeout: 5000 }).catch(() => {});
  const thinking = () => page.evaluate(() => { const t = document.querySelector('#feed .feed-thinking'); return !!t && !t.classList.contains('idle'); });
  check(await page.inputValue('#input') === '' && await thinking(), 'the message shows as sent: the input is empty, Stop can be pressed, the logo under the feed turns');
  await page.keyboard.press('Control+KeyC');
  const t0 = Date.now();
  await page.waitForFunction(() => document.getElementById('input').value === 'half a sentence' && document.getElementById('stop').disabled, null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => { const t = document.querySelector('#feed .feed-thinking'); return !t || t.classList.contains('idle'); }, null, { timeout: 5000 }).catch(() => {});
  check(!(await thinking()) && Date.now() - t0 < 1000, `the logo goes at once, not at the end of its turn (${Date.now() - t0} ms)`);
  await until(() => of(B).filter((e) => e.kind === 'unsent').length === 2, 5000);
  check(await page.inputValue('#input') === 'half a sentence' && await page.locator('#stop').isDisabled() && of(B).filter((e) => e.kind === 'unsent').length === 2 && !results(B).length,
    `Ctrl+C right after Enter puts the message back into the input (${JSON.stringify(await page.inputValue('#input'))}), and nothing runs`);

  // a draft's first message, stopped: back to a draft of the folder, with the message in the input
  await page.fill('#input', '');
  await page.click(`${FOLDER} .folder-new`);
  await page.locator('.draft-intro').waitFor({ timeout: 5000 });
  const before = T.events.length;
  await page.fill('#input', 'a new session');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !document.querySelector('.draft-intro') && !document.getElementById('stop').disabled, null, { timeout: 10000 }).catch(() => {});
  await until(() => T.events.slice(before).some((e) => e.kind === 'created'), 5000);
  const made = T.events.slice(before).find((e) => e.kind === 'created')?.sid;
  await page.keyboard.press('Control+KeyC');
  await page.waitForFunction(() => document.querySelector('.draft-intro') && document.getElementById('input').value === 'a new session', null, { timeout: 5000 }).catch(() => {});
  await until(() => has(made, 'archived'), 5000);
  check(made && await page.locator('.draft-intro').count() === 1 && await page.inputValue('#input') === 'a new session' && has(made, 'archived') && !results(made).length,
    `Ctrl+C right after a new session's first message: a draft again, with the message in the input (${JSON.stringify(await page.inputValue('#input'))})`);
  await page.fill('#input', '');
  for (const sid of [A, B]) await rpc({ type: 'archive', sid });
}

// ---- a confirmation opens at the mouse pointer (or beside the field just typed in); a notice floats there ----
{
  const near = (p, x, y) => p && Math.abs(p.x - x) <= 40 && Math.abs(p.y - y) <= 40;
  await page.mouse.move(420, 300);
  const box = await page.evaluate(async () => {
    const d = await import('/ui/dialog.js');
    d.ask(null, { ok: 'Test' });
    await new Promise((r) => setTimeout(r, 0)); // (answerDialogs answers it a moment later)
    const b = document.querySelector('.dlg'); // (where it is put: the box itself is still growing)
    return b && { x: parseFloat(b.style.left), y: parseFloat(b.style.top), text: !!document.querySelector('.dlg-text') };
  });
  check(near(box, 420, 300) && !box.text, `a confirmation is just its button, opened at the pointer (${JSON.stringify(box)})`);
  await page.locator('.dlg-back').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  // (a field of its own, low on the page)
  await page.evaluate(() => { const f = document.createElement('input'); f.id = 'dlgField'; f.style.cssText = 'position:fixed;left:300px;bottom:40px;width:300px'; document.body.append(f); });
  await page.focus('#dlgField');
  await page.keyboard.press('Shift');
  const typed = await page.evaluate(async () => {
    const d = await import('/ui/dialog.js');
    d.ask(null, { ok: 'Test' });
    await new Promise((r) => setTimeout(r, 0));
    const b = document.querySelector('.dlg'), i = document.getElementById('dlgField').getBoundingClientRect();
    const bottom = b && parseFloat(b.style.top) + b.offsetHeight;
    return b && { above: bottom <= i.top, gap: Math.round(i.top - bottom) };
  });
  check(typed?.above && typed.gap < 20, `after typing it opens just above the field typed in (${JSON.stringify(typed)})`);
  await page.locator('.dlg-back').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('dlgField').remove());
  await page.mouse.move(500, 250);
  const note = await page.evaluate(async () => {
    (await import('/ui/dialog.js')).tell('Something went wrong');
    const t = document.querySelector('.toast.note');
    return t && { x: parseFloat(t.style.left), y: parseFloat(t.style.top), dlg: !!document.querySelector('.dlg-back') };
  });
  check(near(note, 500, 250) && !note.dlg, `a notice floats at the pointer, nothing to click (${JSON.stringify(note)})`);
}

// ---- press and hold (ui/hold.js): a click does nothing, half a second's hold runs it once, sliding off drops it ----
{
  await page.evaluate(async () => {
    const { holdToRun } = await import('/ui/hold.js');
    const b = document.createElement('button');
    b.id = 'holdTest'; b.textContent = 'Stop'; b.style.cssText = 'position:fixed;left:300px;top:300px;z-index:99';
    window.__held = 0; window.__clicked = 0;
    b.onclick = () => window.__clicked++;
    holdToRun(b, () => window.__held++);
    document.body.append(b);
  });
  const n = () => page.evaluate(() => [window.__held, window.__clicked]);
  await page.click('#holdTest');
  await wait(700); // (past the half second a hold takes)
  check((await n())[0] === 0, 'a plain click on a held control does nothing');
  await page.hover('#holdTest');
  await page.mouse.down();
  // (the fill read at its middle, its transition paused there: read by the clock, a slow machine reads it
  // before it has started or once it is over)
  const mid = await page.locator('#holdTest').evaluate((b) => {
    const a = b.getAnimations({ subtree: true }).find((x) => x.transitionProperty === 'transform');
    if (!b.classList.contains('holding') || !a) return null;
    a.pause();
    a.currentTime = 250;
    const fill = new DOMMatrix(getComputedStyle(b, '::after').transform).a;
    a.play();
    return { fill, ms: a.effect.getTiming().duration };
  });
  await until(async () => (await n())[0] === 1, 5000); // (let go once it ran: the half second is the page's)
  await page.mouse.up();
  check(Math.abs(mid?.fill - 0.5) < 0.05 && mid.ms === 500 && (await n()).join() === '1,1', `held for half a second it runs once, the fill growing across it meanwhile (${JSON.stringify(mid)}, ${await n()})`);
  // (the click that ends the hold reached only the swallowing listener: __clicked counts the plain click above)
  await page.hover('#holdTest');
  await page.mouse.down();
  await page.locator('#holdTest.holding').waitFor({ timeout: 5000 }).catch(() => {}); // (and off at once: a fixed wait can outlast the half second)
  await page.mouse.move(600, 600);
  await wait(600);
  await page.mouse.up();
  check((await n())[0] === 1, 'sliding off before the half second is up drops it');
  await page.evaluate(() => document.getElementById('holdTest').remove());
}

// ---- a new session and a branch show at once, before a slow server answers (here 1 s) ----
{
  // `as`: what the server is sent instead
  const slow = (type, refuse, as) => routeCmd(page, type, async (route, body) => {
    await wait(1000);
    if (refuse) route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: 'refused for the test' }) });
    else route.continue(as ? { postData: JSON.stringify({ ...body, ...as }) } : undefined);
  });
  const look = () => page.evaluate(() => ({
    q: document.querySelector('#feed .turn-q-text')?.textContent, note: document.querySelector('#feed .pending-note')?.textContent,
    intro: !!document.querySelector('.draft-intro'), input: document.getElementById('input').value,
    row: document.querySelector('.sess.active .sess-title')?.textContent, dot: document.querySelector('.sess.active .dot')?.className,
    branched: /branched/.test(document.getElementById('feed').textContent),
  }));
  const pending = () => page.waitForFunction(() => document.querySelector('#feed .pending-note'), null, { timeout: 5000 }).catch(() => {});
  const settled = () => page.waitForFunction(() => !document.querySelector('.pending-note'), null, { timeout: 15000 }).catch(() => {});

  let unroute = await slow('new', true);
  await page.click(`${FOLDER} .folder-new`);
  await page.locator('.draft-intro').waitFor({ timeout: 5000 });
  await page.fill('#input', 'shown at once');
  await page.press('#input', 'Enter');
  await pending();
  const early = await look();
  check(early.q === 'shown at once' && /starting/.test(early.note || '') && early.input === '' && early.row === 'shown at once' && early.dot === 'dot st-busy',
    `a new session shows at once: its message, its row, an empty input (${JSON.stringify(early)})`);
  await settled();
  const refused = await look();
  check(refused.intro && refused.input === 'shown at once' && !refused.row, `refused: back to the draft, the message in the input again (${JSON.stringify(refused)})`);
  await unroute();

  unroute = await slow('new', false, { text: 'the server\'s one' }); // (named apart, to tell the server's session from the stand-in)
  await page.fill('#input', 'shown then real');
  await page.press('#input', 'Enter');
  await pending();
  const ok = await look();
  check(ok.row === 'shown then real' && ok.q === 'shown then real' && /starting/.test(ok.note || ''), `again, shown at once (${JSON.stringify(ok)})`);
  await settled();
  // (the row is redrawn on the next frame)
  await page.waitForFunction(() => document.querySelector('.sess.active .sess-title')?.textContent === 'the server\'s one'
    && ![...document.querySelectorAll('.sess-title')].some((t) => t.textContent.includes('shown then real')), null, { timeout: 5000 }).catch(() => {});
  const real = await look();
  check(real.row === 'the server\'s one' && !real.intro && !real.note && await page.locator('.sess-title', { hasText: 'the server\'s one' }).count() === 1
    && await page.locator('.sess-title', { hasText: 'shown then real' }).count() === 0,
  `then the server's session takes its place: one row, open (${JSON.stringify(real)})`);
  await unroute();

  // (typed during a turn it would wait in the queue: the turn is over first)
  await page.waitForFunction(() => !document.querySelector('.sess.active .dot.st-busy'), null, { timeout: 15000 }).catch(() => {});
  unroute = await slow('branch', true);
  await page.fill('#input', '/branch');
  await page.click('#send');
  await pending();
  const br = await look();
  check(br.row === 'the server\'s one (branch)' && br.branched && /starting the branch/.test(br.note || ''), `a branch shows at once, with the conversation copied (${JSON.stringify(br)})`);
  await settled();
  const brBack = await look();
  check(brBack.row === 'the server\'s one' && !brBack.branched && await page.locator('.sess-title', { hasText: '(branch)' }).count() === 0,
    `refused: the branch goes and the original opens again (${JSON.stringify(brBack)})`);
  await unroute();
}

// ---- streamed text is typed out evenly, however it arrives: in bursts from a remote server (staged) ----
{
  const p2 = await sidePage(page, errors); // its own page: its frames and clock are the test's
  const sid = await blankSession(rpc, WORK, 'typewriter', p2);
  // The page's frames and clock are the test's from here, a frame every FRAME ms: on a slow machine real
  // frames come late and few, and the pace read would be the machine's. (Its waits here poll on a timer.)
  const FRAME = 20;
  await p2.evaluate((FRAME) => {
    let now = performance.now(), id = 0;
    const q = new Map();
    performance.now = () => now;
    window.requestAnimationFrame = (cb) => (q.set(++id, cb), id);
    window.cancelAnimationFrame = (i) => q.delete(i);
    // `n` frames, and what `sample()` reads after each
    window.__frames = (n, sample = () => 0) => Array.from({ length: n }, () => {
      now += FRAME;
      const cbs = [...q.values()];
      q.clear();
      cbs.forEach((f) => f(now));
      return sample();
    });
  }, FRAME);
  // one burst: 20 deltas in one packet; the shown length after each frame, for a second
  const burst = (n, k) => p2.evaluate(({ sid, n, k, frames }) => {
    for (let i = 0; i < 20; i++) window.__iroFeed({ type: 'partial', sid, op: 'delta', block: 'text', text: `w${k}-${i} `.padEnd(n / 20, '.') });
    return window.__frames(frames, () => document.querySelector('#feed .assistant.live')?.textContent.length ?? -1);
  }, { sid, n, k, frames: 1000 / FRAME });
  await p2.evaluate((sid) => window.__iroFeed({ type: 'partial', sid, op: 'start', block: 'text' }), sid);
  const a = await burst(400, 1);
  const allAfter = (xs) => xs.findIndex((x) => x >= xs.at(-1)) + 1; // the frames until all of it shows
  // (the first burst is spread over 200 ms, the page's TYPE_FIRST_MS)
  check(a[0] < 200 && a.at(-1) >= 390 && Math.abs(allAfter(a) - 200 / FRAME) <= 1, `a burst of 400 characters is typed out over several frames, not at once (all shown after ${allAfter(a)} frames: ${a.slice(0, 8)}… ${a.at(-1)})`);
  // leaving the session mid-reply stops the typing; back in it, the text so far is there and typing goes on from it
  await p2.locator('.sess:not(.active)').first().click();
  await p2.waitForFunction(() => document.getElementById('title').textContent !== 'typewriter', null, { timeout: 5000, polling: 100 }).catch(() => {});
  await p2.evaluate((sid) => window.__iroFeed({ type: 'partial', sid, op: 'delta', block: 'text', text: ' and more while away.' }), sid);
  await p2.locator('.sess', { hasText: 'typewriter' }).click();
  const backAt = await p2.evaluate(() => document.querySelector('#feed .assistant.live')?.textContent ?? '');
  check(backAt.length >= a.at(-1) && backAt.includes('while away'), `back in the session mid-reply, the text so far shows at once (${backAt.length} chars, ends ${JSON.stringify(backAt.slice(-24))})`);
  const b = await burst(400, 2); // a second burst a second later: spread over about that second, up to 600 ms (TYPE_MAX_MS)
  check(b[0] < backAt.length + 200 && Math.abs(allAfter(b) - 600 / FRAME) <= 1, `the next one is typed on from there, spread over the gap between bursts (all shown after ${allAfter(b)} frames)`);
  // the finished message arrives while text is still being typed: it waits for the typing, then takes its place
  const full = await p2.evaluate(() => document.querySelector('#feed .assistant.live').textContent);
  const more = ' and then the rest of the reply, which arrived together with the finished message.';
  const fin = await p2.evaluate(({ sid, text, more, FRAME }) => {
    window.__iroFeed({ type: 'partial', sid, op: 'delta', block: 'text', text: more });
    window.__iroFeed({ type: 'event', seq: 1e12, sid, ts: Date.now(), kind: 'msg',
      msg: { type: 'assistant', uuid: 'u-final', parent_tool_use_id: null, message: { model: 'claude-test', content: [{ type: 'text', text }] } } });
    const at = () => ({ live: !!document.querySelector('#feed .assistant.live'), shown: [...document.querySelectorAll('#feed .assistant')].filter((x) => x.offsetParent).map((x) => x.textContent) });
    const now = at();
    window.__frames(900 / FRAME);
    return { now, later: at() };
  }, { sid, text: full + more, more, FRAME });
  check(fin.now.live && fin.now.shown.length === 1 && !fin.now.shown[0].includes('arrived together'), `the finished message waits while the text is typed out (${JSON.stringify(fin.now).slice(0, 120)})`);
  check(!fin.later.live && fin.later.shown.length === 1 && fin.later.shown[0].trim().endsWith('finished message.'), `then it takes the live text's place (${JSON.stringify(fin.later).slice(-120)})`);
  await p2.close();
  await rpc({ type: 'archive', sid });
}

// The next two stage a turn's messages in a page of their own (the order and shape of what arrives is the point).
// (both sessions made first: once events are staged, the page drops the log's own)
const p3 = await sidePage(page, errors);
const requestsSid = await blankSession(rpc, WORK, 'requests');
const unmarkedSid = await blankSession(rpc, WORK, 'unmarked', p3);

// ---- text Claude leaves without a marker: the reply while it is the last thing written, a log once more follows in the turn ----
{
  const sid = unmarkedSid;
  const seen = await p3.evaluate(async (sid) => {
    let seq = 1e12;
    const feed = (e) => window.__iroFeed({ type: 'event', seq: seq++, sid, ts: Date.now(), ...e });
    const say = (content) => feed({ kind: 'msg', msg: { type: 'assistant', uuid: `u${seq}`, parent_tool_use_id: null, message: { model: 'claude-test', content } } });
    const kinds = () => [...document.querySelectorAll('#feed .assistant')].map((a) => (a.querySelector('.md-log') ? 'log' : a.querySelector('.md-role') ? 'marked' : 'reply'));
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = [];
    feed({ kind: 'user_text', text: 'first' });
    say([{ type: 'text', text: 'Now the config dataclasses.' }]); await tick(); out.push(kinds());
    say([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]); await tick(); out.push(kinds());
    say([{ type: 'text', text: ':::reply\nMarked.\n:::\n\nAnd the answer, unmarked.' }]); await tick(); out.push(kinds());
    feed({ kind: 'user_text', text: 'second' });
    say([{ type: 'text', text: 'Next turn.' }]); await tick(); out.push(kinds());
    return out;
  }, sid);
  check(JSON.stringify(seen) === '[["reply"],["log"],["log","marked"],["log","marked","reply"]]',
    `unmarked text reads as the reply until more of the turn follows, then as a log; the last answer of a turn stays one (${JSON.stringify(seen)})`);
  await rpc({ type: 'archive', sid });
}

// ---- a request is shown like the input: four lines at most, then a corner button that opens the whole of it ----
{
  const sid = requestsSid;
  await openSession(p3, 'requests');
  const long = 'A long request that goes on well past the fourth line of its card. '.repeat(40);
  await p3.evaluate(({ sid, texts }) => texts.forEach((text, i) => window.__iroFeed({ type: 'event', seq: 2e12 + i, sid, ts: Date.now(), kind: 'user_text', text })),
    { sid, texts: ['One line.', 'Two lines:\nthe second.', long] });
  await p3.locator('.turn-q.long').waitFor({ timeout: 5000 }).catch(() => {});
  const cards = () => p3.evaluate(() => ({
    pill: document.querySelector('.input-wrap').getBoundingClientRect().height,
    win: window.innerHeight, feed: document.getElementById('feed').clientHeight,
    cards: [...document.querySelectorAll('.turn-q')].map((q) => {
      const t = q.querySelector('.turn-q-text'), b = q.querySelector('.turn-expand');
      return { h: q.getBoundingClientRect().height, lines: Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight)), button: !!b.offsetParent, open: q.classList.contains('open'),
        arrows: ['out', 'in'].filter((d) => getComputedStyle(b.querySelector(`.ic-${d}`)).display !== 'none').join(),
        inside: q.querySelector('.turn-q-scroll').scrollHeight > q.querySelector('.turn-q-scroll').clientHeight + 1 };
    }),
  }));
  const shut = await cards();
  const [one, two, more] = shut.cards;
  check(Math.abs(one.h - shut.pill) <= 1 && one.lines === 1 && !one.button, `a one-line request is as tall as the empty input (${one.h} vs ${shut.pill})`);
  check(two.lines === 2 && !two.button, `a few lines are shown whole, with no button (${JSON.stringify(two)})`);
  check(more.lines === 4 && more.button && more.arrows === 'out' && !more.inside, `a longer one is cut at four lines and gets the corner button (${JSON.stringify(more)})`);
  await p3.locator('.turn-q.long .turn-expand').click();
  const open = (await cards()).cards[2];
  check(open.open && open.lines > 4 && open.inside && open.h <= shut.win / 2 + 32 && open.arrows === 'in',
    `the button opens it: up to half the window, the rest scrolls inside; its arrows then point inwards (${JSON.stringify(open)}, window ${shut.win})`);
  await p3.locator('.turn-q.long .turn-expand').click();
  const again = (await cards()).cards[2];
  check(!again.open && again.arrows === 'out' && again.lines === 4, `and closes it again (${JSON.stringify(again)})`);
  // a short window: fewer lines, so the card leaves the conversation its room; opened, it still shows its text
  await p3.setViewportSize({ width: 1400, height: 440 });
  // (the feed shrinks in steps, the input's height easing in last; on a slow machine a step can be read as the
  // end: wait until its height holds, and the lines shown are those that height gives)
  let lastH = -1;
  await until(() => p3.evaluate(() => {
    const f = document.getElementById('feed');
    return [f.clientHeight, getComputedStyle(f).getPropertyValue('--q-lines') === String(Math.max(1, Math.min(4, Math.floor((f.clientHeight / 3 - 30) / 24))))];
  }).then(([h, fits]) => { const held = h === lastH; lastH = h; return held && fits; }), 5000, 'the short window\'s feed settles');
  const low = await cards();
  check(low.cards[2].lines < 4 && low.cards[2].button && low.cards[2].h <= low.feed / 3 + 1, `in a short window it shows fewer lines: a third of the conversation at most (${low.cards[2].lines} lines, ${low.cards[2].h} of ${low.feed})`);
  await p3.locator('.turn-q.long .turn-expand').last().click();
  const lowOpen = (await cards()).cards[2];
  check(lowOpen.open && lowOpen.h >= low.cards[2].h && lowOpen.h < low.feed, `opened there, it is no smaller than it was and fits the conversation (${lowOpen.h} of ${low.feed})`);
  await rpc({ type: 'archive', sid });
}
await p3.close();

T.req.destroy();
check(nativeDialogs === 0, `no native confirm/alert (${nativeDialogs})`);
await endSuite(api);
