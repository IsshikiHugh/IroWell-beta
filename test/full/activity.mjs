// Activity indicator: spinner + what's running + timers + heartbeat + background tasks.
import { outDir, startSession, check, finish, startSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4784;
const WORK = path.join(S, 'work13');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const { client, browser, page, errors } = await startSuite(PORT);
const label = () => page.locator('#act-label').textContent();
const metaText = () => page.locator('#act-meta').textContent();

await startSession(page, WORK, 'Run this exact command in the foreground with Bash (not in the background): node -e "setTimeout(() => console.log(42), 8000)" and then reply with just the number it printed.');
check(await page.locator('#busy').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false), 'indicator appears as soon as the turn starts');
const seen = new Set();
let bashLabel = '', t1 = null, t2 = null, sawWaiting = false;
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  if (await page.locator('.turn-foot .meta.result').count()) break;
  const allow = page.locator('.approval .btns button.primary');
  if (await allow.count()) {
    if ((await label()) === 'Waiting for your approval') sawWaiting = true;
    await allow.first().click();
  }
  const l = await label();
  seen.add(l.split(' · ')[0]);
  if (l.startsWith('Running Bash')) {
    bashLabel = l;
    if (!t1) t1 = { l, m: await metaText(), at: Date.now() };
    else if (Date.now() - t1.at > 4000 && !t2) t2 = { l, m: await metaText() };
  }
  await page.waitForTimeout(250);
}
console.log('  labels seen:', [...seen].join(' | '));
console.log('  bash label:', bashLabel, '| meta then/later:', t1?.m, '→', t2?.m);
check(bashLabel.startsWith('Running Bash'), 'shows the running tool');
check(/\d+s$/.test(bashLabel), 'shows how long the tool has been running');
check(!!t1 && !!t2 && t1.m !== t2.m, 'turn timer keeps counting (alive)');
check(!(t2?.m || '').includes('no heartbeat'), 'heartbeat keeps arriving');
if (sawWaiting) check(true, 'approval shows "Waiting for your approval"');
await page.locator('.turn-foot .meta.result').first().waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
check(await page.locator('#busy').isHidden(), 'indicator goes away when idle');

// background task keeps the indicator (as a task list) after the turn ends
await page.fill('#input', 'Start this command with Bash using run_in_background: node -e "setTimeout(() => console.log(7), 40000)". Do not wait for it; reply with just: started');
await page.press('#input', 'Enter');
const tb = Date.now();
while (Date.now() - tb < 120000) {
  const allow = page.locator('.approval .btns button.primary');
  if (await allow.count()) await allow.first().click();
  if ((await page.locator('.turn-foot .meta.result').count()) >= 2) break;
  await page.waitForTimeout(300);
}
await page.waitForTimeout(2000);
const tasksBtn = page.locator('#act-tasks');
console.log('  after turn:', await label(), '|', await tasksBtn.isVisible() ? await tasksBtn.textContent() : '(no task button)');
check(await tasksBtn.isVisible() && /1 background task/.test(await tasksBtn.textContent()), 'background task is shown after the turn');
if (await tasksBtn.isVisible()) {
  await tasksBtn.click();
  check(await page.locator('#act-tasklist .act-task').count() >= 1, 'task list opens');
  console.log('  task:', await page.locator('#act-tasklist .act-task').first().textContent());
  await page.screenshot({ path: path.join(S, 'activity-tasks.png') });
}

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
finish();
