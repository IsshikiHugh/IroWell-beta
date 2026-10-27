// Slash commands that open a dialog (/usage, /context, /status, /mcp, /model, /help, and /agents, which the CLI
// answers), the context meter's panel, and /clear. None of them leaves a turn, not even after a reload.
import { PORT, startSuite, startSession, check, expectSoon, waitResults, command, reloadPage, workDir, endSuite } from '../lib.mjs';

const WORK = workDir('commands');
const suite = await startSuite(PORT);
const { page } = suite;

await startSession(page, WORK, 'Reply with just: ok');
check(await waitResults(page, 1, { timeout: 30000 }), 'first turn');
const turns = () => page.locator('.turn').count();

// typing a full command name preselects exactly that one in the popup (not /usage-credits or the like)
await page.fill('#input', '');
await page.type('#input', '/usage');
await expectSoon(async () => (await page.locator('#popup .pop-item.sel .pop-main').textContent()).trim() === '/usage', 'the exact match is preselected in the popup');
await page.fill('#input', '');

// How many elements in the open dialog match `sel` (with `text` in them).
const count = (sel, text) => page.locator(`.modal ${sel}`, text ? { hasText: text } : {}).count();
// `open()` brings up the dialog; it must have `title` and show what `shows()` looks for. Esc closes it.
async function dialog(name, open, title, shows, what) {
  await open();
  await expectSoon(async () => await page.locator('.modal .modal-title', { hasText: title }).count() === 1 && await shows(), `${name} opens its dialog${what ? ': ' + what : ''}`);
  await page.keyboard.press('Escape');
  await expectSoon(async () => await page.locator('.modal').count() === 0, `Esc closes the ${name} dialog`, 3000);
}
await dialog('/usage', () => command(page, '/usage'), 'Usage',
  async () => await count('.meter-row') >= 2 && await count('.plan-badge', 'Claude Max plan') === 1, 'both plan limits and the plan');
await dialog('/context', () => command(page, '/context'), 'Context window',
  async () => await count('.ctx-seg') >= 2 && await count('.ctx-grid .sq') >= 50 && await count('.ctx-leg') >= 3, 'a stacked bar, the square grid and a legend');
await dialog('the context meter', () => page.locator('#sb-ctx').click(), 'Context window', async () => await count('.ctx-bar') === 1);
await dialog('/help', () => command(page, '/help'), 'Commands and shortcuts', async () => await count('td.mono', '/review') === 1, 'the CLI\'s commands');
await dialog('/status', () => command(page, '/status'), 'Status', async () => await count('td', 'test@example.com') === 1, 'the account');
await dialog('/mcp', () => command(page, '/mcp'), 'MCP servers', async () => await count('td.mono', 'fake-docs') === 1 && await count('td.mcp-connected') === 1, 'the server and its state');
await dialog('/model', () => command(page, '/model'), 'Model', async () => await count('.hrow', 'Sonnet 5.5') === 1, 'the CLI\'s models');
await dialog('/agents', () => command(page, '/agents'), '/agents', async () => await count('.modal-body', '(fake) /agents') === 1, 'what the CLI answered');
check(await turns() === 1 && await page.locator('#outline .ol-item').count() === 1, 'none of these commands added a turn');

// the history replayed on a reload brings none back either
await reloadPage(page, 'Reply with just');
await page.locator('.turn-foot .meta.result').first().waitFor({ timeout: 10000 });
check(await turns() === 1, 'after a reload, still no command turns');

// /clear: a fresh draft in the same folder, and the cleared session archived
const nSess = await page.locator('.sess').count();
await command(page, '/clear');
await expectSoon(async () => await page.locator('.draft-intro').isVisible() && await page.locator('.sess.active').count() === 0 && await turns() === 0,
  '/clear starts a fresh session in the same directory');
await expectSoon(async () => await page.locator('.sess').count() === nSess - 1 && await page.locator('.sess .sess-title', { hasText: 'Reply with just' }).count() === 0,
  '/clear archives the session it cleared');

await endSuite(suite);
