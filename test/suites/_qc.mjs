// What the suites from quick parts C and D share (turns, progress, workplace, leftrunning, away).

// The page's commands, sent as the page sends them: the parsed reply, or { status } for a refusal (403, 400) that has none.
export const rpcOf = ({ req, token }) => (body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) })
  .then((r) => (r.status === 200 ? JSON.parse(r.body) : { status: r.status }));

// window.__iroFeed(msg) in the context's pages (those loaded from now on): a message as if it came down the page's
// event stream, to stage what a session can't easily make happen (bursts from a remote server, forty requests).
// A staged event takes a seq far past the log's (1e12…): the page then drops the log's own events, so stage in a
// page of its own, or last.
export function stageFeed(context) {
  return context.addInitScript(() => {
    const E = window.EventSource, open = [];
    window.EventSource = class extends E { constructor(...a) { super(...a); open.push(this); } };
    window.__iroFeed = (d) => open.at(-1).onmessage({ data: JSON.stringify(d) });
  });
}

// Another page on the same client (with __iroFeed when stageFeed ran), once connected; its errors go into `errors`.
export async function sidePage(page, errors) {
  const p = await page.context().newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(page.url());
  await p.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  return p;
}

// A blank session (a CLI sent nothing yet) in `cwd`, named `title`: its sid. With `page`, it is opened there.
export async function blankSession(rpc, cwd, title, page) {
  const sid = (await rpc({ type: 'new', cwd, blank: true })).data.sid;
  await rpc({ type: 'rename', sid, title });
  if (page) await openSession(page, title);
  return sid;
}

// The session named `title` opened on `page` (its title shown).
export async function openSession(page, title) {
  await page.locator('.sess', { hasText: title }).first().click();
  await page.waitForFunction((t) => document.getElementById('title').textContent === t, title, { timeout: 5000 });
}
