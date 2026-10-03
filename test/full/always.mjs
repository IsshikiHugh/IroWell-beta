// "Always allow" test: allow the first Write with Always allow; the second Write must not ask.
import { outDir, startSession, check, finish, startSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4794;
const WORK = path.join(S, 'work5');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1300, height: 1000 }, dialog: 'dismiss' });
await startSession(page, WORK, 'Use the Write tool to create a.txt containing "a". Then reply with just: ok');
const always = page.locator('.approval button', { hasText: 'Always allow' });
await Promise.race([always.waitFor({ timeout: 120000 }), page.locator('.meta.result').waitFor({ timeout: 120000 })]);
if (!(await always.count())) {
  console.log('no approval asked at all (settings already allow Write here); nothing to test');
} else {
  await always.click();
  await page.getByText('✓ always allowed').waitFor({ state: 'attached', timeout: 10000 });
  await page.locator('.meta.result').waitFor({ timeout: 120000 });
  await page.fill('#input', 'Now use the Write tool to create b.txt containing "b". Then reply with just: ok2');
  await page.press('#input', 'Enter');
  await page.locator('.meta.result').nth(1).waitFor({ timeout: 120000 });
  check(await page.locator('.approval').count() === 1, 'second Write was not asked again');
  check(fs.existsSync(path.join(WORK, 'a.txt')) && fs.existsSync(path.join(WORK, 'b.txt')), 'both files written');
  const local = path.join(WORK, '.claude', 'settings.local.json');
  console.log('  rule written to:', fs.existsSync(local) ? fs.readFileSync(local, 'utf8').replace(/\s+/g, ' ') : '(session only)');
}
await browser.close();
client.kill('SIGTERM');
finish();
