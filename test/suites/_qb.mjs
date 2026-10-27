// Fixtures and helpers shared by the plugins, settings and usage suites (not a suite itself).
import fs from 'node:fs';
import path from 'node:path';
import { REPO, check, wait, workDir } from '../lib.mjs';

// (the run's suites share one output folder: each of these folders is named after its suite)
const SUITE = path.basename(process.argv[1] || 'qb', '.mjs');
const dirOf = (name, files) => workDir(`${SUITE}-${name}`, files);

// The plugins the widgets show (IRO_PLUGINS_DIR): the checkout's clock, a plugin whose tile opens nothing,
// and one whose ui.js fails. `add(name)` copies another of the checkout's plugins in later.
export function pluginsDir() {
  const dir = dirOf('plugins', {
    'still/plugin.json': JSON.stringify({ title: 'still' }),
    'still/ui.js': "export default { tile(el) { el.textContent = 'ok'; } };",
    'broken/plugin.json': JSON.stringify({ title: 'broken' }),
    'broken/ui.js': "throw new Error('boom');",
  });
  const add = (name) => fs.cpSync(path.join(REPO, 'plugins', name), path.join(dir, name), { recursive: true });
  add('clock');
  process.env.IRO_PLUGINS_DIR = dir;
  return { dir, add };
}

// A folder whose drafts start in Plan mode, and one whose drafts start in Accept edits (their own settings).
export const planFolder = () => dirOf('work', { '.claude/settings.local.json': JSON.stringify({ permissions: { defaultMode: 'plan' } }) });
export const editsFolder = () => dirOf('edits', { '.claude/settings.local.json': JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }) });

// The UI Skills page edits a copy of skills/ (IRO_SKILLS_DIR), never the checkout's.
export function skillsCopy() {
  const dir = dirOf('skills');
  fs.cpSync(path.join(REPO, 'skills'), dir, { recursive: true });
  process.env.IRO_SKILLS_DIR = dir;
  return dir;
}

// The Output style page edits this folder in place of ~/.claude (IRO_STYLES_HOME): a style of the user's, and their settings.
export function stylesHome() {
  const dir = dirOf('claude-home', {
    'output-styles/mine.md': '---\nname: Mine\ndescription: A style of my own\ncolor: blue\n---\n\nAnswer in haiku.\n',
    'settings.json': JSON.stringify({ model: 'opus' }, null, 2),
  });
  process.env.IRO_STYLES_HOME = dir;
  return dir;
}

// Synthetic plan-usage history in the daemon's usage.jsonl: 3 days, a sample every 30 minutes, on the :00/:30
// marks as the daemon stamps them. (IRO_NO_USAGE_RECORD: the daemon adds no real samples; a real weekly reset
// would start a cycle the synthetic days are not in.) Returns the file and when its last 5-hour window resets.
export function usageHistory(iroDir) {
  process.env.IRO_NO_USAGE_RECORD = '1';
  const file = path.join(iroDir, 'usage.jsonl');
  const lines = [], now = Date.now();
  let fiveResets = 0;
  const slot0 = Math.ceil((now - 3 * 24 * 3600e3) / 1800e3) * 1800e3;
  for (let t = slot0; t <= now; t += 1800e3) {
    const win = Math.floor(t / (5 * 3600e3));
    const five = Math.round(((t % (5 * 3600e3)) / (5 * 3600e3)) * 60);
    const week = Math.min(99, Math.round(((t - (now - 3 * 24 * 3600e3)) / (3 * 24 * 3600e3)) * 40) + 10);
    fiveResets = (win + 1) * 5 * 3600e3;
    lines.push(JSON.stringify({ t, five: { pct: five, resets: new Date(fiveResets).toISOString() }, week: { pct: week, resets: new Date(now + 4 * 24 * 3600e3).toISOString() } }));
  }
  fs.mkdirSync(iroDir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { file, fiveResets };
}

// Transcripts for the cost of the work (IRO_COST_DIR: the daemon reads these instead of ~/.claude/projects): an
// answer every half hour for 3 days at $2.004 each, every one written twice (once per content block, the first
// with the counts so far), the lot copied into a second transcript (a resumed session), one more answer by a
// subagent; and other models at the prices of pricing.md: a Sonnet 5.5 cache read ($0.10 per million, not
// Sonnet 5's $0.20), Claude Haiku 5.5 under and over its 100,000-token prompt (input and cache read together).
// Returns how many $2.004 answers there are, and what the others cost.
export function costTranscripts() {
  const root = dirOf('cost'), dir = path.join(root, '-quick-project');
  process.env.IRO_COST_DIR = root;
  fs.mkdirSync(path.join(dir, 'aaaa', 'subagents'), { recursive: true });
  const now = Date.now(), lines = [];
  let answers = 0;
  const answer = (id, t, out) => JSON.stringify({ type: 'assistant', timestamp: new Date(t).toISOString(), message: { id, model: 'claude-opus-5-5', usage: {
    input_tokens: 1000, output_tokens: out, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e5, cache_creation: { ephemeral_1h_input_tokens: 1e5, ephemeral_5m_input_tokens: 0 }, speed: 'standard' } } });
  for (let t = now - 3 * 24 * 3600e3 + 60e3; t < now; t += 1800e3) { lines.push(answer(`msg_${t}`, t, 10), answer(`msg_${t}`, t, 50000)); answers++; }
  fs.writeFileSync(path.join(dir, 'aaaa.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'bbbb.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'aaaa', 'subagents', 'agent-1.jsonl'), answer('msg_sub', now - 3600e3, 50000) + '\n');
  answers++;
  const other = (id, model, usage) => JSON.stringify({ type: 'assistant', timestamp: new Date(now - 7200e3).toISOString(), message: { id, model, usage } });
  fs.writeFileSync(path.join(dir, 'cccc.jsonl'), [
    other('msg_sonnet', 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 }), // $0.10
    other('msg_haiku_short', 'claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1e6, cache_read_input_tokens: 40000 }), // $0.0050 + $0.5 + $0.0004
    other('msg_haiku_long', 'claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1e6, cache_read_input_tokens: 60000 }), // $0.025 + $2.5 + $0.003
  ].join('\n') + '\n');
  return { answers, other: 0.1 + 0.5054 + 2.528 };
}

// Settings opened from the button below the usage card; with `row`, the page that row opens (Plugins, UI skills, Output style).
export async function openSettings(page, row) {
  await page.click('#settingsBtn');
  await page.locator('.modal .settings .set-row').first().waitFor({ timeout: 8000 });
  if (row) await page.locator(`.modal .set-row:has(.set-label:text-is("${row}")) .set-open`).click();
}

// The page's answer to its next command of `type` (to wait for what the page draws from it).
export const answered = (page, type) => page.waitForResponse((r) => r.url().endsWith('/cmd') && !!r.request().postData()?.startsWith(`{"type":"${type}"`), { timeout: 5000 });

// Polls `get` until `ok(value)` holds, then passes `what`; past `ms`, fails it with the last value.
export async function soon(get, ok, what, ms = 5000) {
  const end = Date.now() + ms;
  let v;
  for (;;) {
    try { v = await get(); } catch (e) { v = { error: String(e.message).split('\n')[0] }; }
    let good = false;
    try { good = !!ok(v); } catch {}
    if (good || Date.now() > end) { check(good, `${what}${good ? '' : ` (${JSON.stringify(v)?.slice(0, 400)})`}`); return v; }
    await wait(100);
  }
}

// The faked 400s some steps answer with are logged by the browser as failed loads: expected, not the page's errors.
export const drop400s = (errors) => { for (let i = errors.length - 1; i >= 0; i--) if (/status of 400/.test(errors[i])) errors.splice(i, 1); };

// A notice floats over the page's foot buttons for seconds (it fades by itself): put away once it has been seen.
export const dropNotice = async (page) => { await page.locator('.toast.note[data-seen]').waitFor({ timeout: 3000 }); await page.evaluate(() => document.querySelector('.toast.note')?.remove()); };
