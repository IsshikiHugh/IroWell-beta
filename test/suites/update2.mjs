// Updates whose Claude Code does not run, and updates for a newer Agent SDK (see _update.mjs: fake ssh, npm a stub).
// A release whose Claude Code comes out damaged (it runs as a bare Bun, as a copy on an NFS home once did) gets its
// packages fetched again; damaged again, preparing fails and says why, and Try again does it over. A release that
// breaks after its install is asked first on Reconnect, which then changes nothing. Either is prepared again later
// by itself. A newer SDK on npm is an update of its own: one the host can't fetch is said, one that didn't come is not
// offered again and again, and on this machine Reconnect installs it into server/ first.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, check, until, finish, startClient } from '../lib.mjs';
import { updateRig, RECONNECT } from './_update.mjs';

const r = await updateRig('upb');
const { page, button, up, note, label, reason, pid, current, newest, flag } = r;

try {
  await r.start(); // (installed by itself)
  await up.waitFor({ timeout: 30000 });

  // ---- damaged, fetched again, damaged again: preparing fails, nothing switches, no half-made release stays ----
  // (each line of the queue: what one fetch of a release's packages gets)
  fs.writeFileSync(flag.badCli, 'bad\nbad\n');
  r.npmReset();
  r.newer();
  const running = pid();
  await until(async () => /Preparing the update failed: .*does not run \(--version: 1\.4\.3\)/.test(await note()), 30000, 'a Claude Code that stays damaged: preparing the update fails');
  check(await label() === 'Try again' && pid() === running, `…says why, offers to try again (no switch), and the daemon in use goes on (${await label()}; ${await note()})`);
  const releases = fs.readdirSync(path.join(r.RDIR, 'releases'));
  check(releases.every((x) => x <= path.basename(current())), `…and leaves no half-made release behind (${releases.join(' ')}; current ${path.basename(current())})`);
  check(r.installs() === 2, `a damaged Claude Code: the packages are fetched again (${r.npmCalls().trim().split('\n').join(' | ')})`);
  // Try again (a failed update keeps that button): it prepares the update and switches.
  await r.update('Try again', { ahead: false });

  // ---- damaged once: fetched again, the update is prepared. That release then breaks: Reconnect asks it first,
  // and when its Claude Code doesn't run, nothing changes (the daemon in use doesn't retire, its sessions stay) ----
  fs.writeFileSync(flag.badCli, 'bad\nown\n'); // ("own": a stand-in Claude Code in the release, damaged below)
  r.npmReset();
  r.newer();
  await r.prepared('a damaged Claude Code');
  check(r.installs() === 2, `a damaged Claude Code, fetched again: the update is prepared (${r.npmCalls().trim().split('\n').join(' | ')})`);
  const broken = newest(), sdk = path.join(r.RDIR, 'releases', broken, 'node_modules', '@anthropic-ai');
  for (const f of fs.readdirSync(sdk).filter((d) => d.startsWith('claude-agent-sdk-'))) fs.writeFileSync(path.join(sdk, f, 'claude'), '#!/bin/sh\necho 1.4.3\n');
  const serving = pid(), inUse = current(), t0 = Date.now();
  await button.click();
  await until(async () => /Update failed: Claude Code at .*does not run \(--version: 1\.4\.3\)/.test(await note()), 15000, 'Reconnect to a release whose Claude Code does not run: the update fails');
  check(Date.now() - t0 < 6000 && pid() === serving && current() === inUse && !r.retiring(),
    `…at once, and says why; the daemon in use did not retire, and its release is still current (${Date.now() - t0} ms; ${await note()})`);
  await r.prepared('a release that broke, tried again later');
  await r.update('a release that broke, the second try');

  // ---- up-to-date code, but a newer Agent SDK on npm: prepared the same way ----
  r.npmReset();
  await r.restart({ IRO_TEST_SDK_LATEST: '99.0.0' }); // (a daemon that is told 99.0.0 is out)
  await r.prepared('newer SDK');
  check(/99\.0\.0 is out/.test(await reason()), `a newer Claude Code is the reason (${await reason()})`);
  await r.update('newer SDK', { fixed: false });
  check(/install .*@anthropic-ai\/claude-agent-sdk@latest/.test(r.npmCalls()), `the update installs the newest SDK (${r.npmCalls().trim().split('\n').join(' | ')})`);
  // (the stub can't really install 99.0.0: it is still out, but not offered again and again; the client looks
  // every 0.5 s)
  await new Promise((res) => setTimeout(res, 1000));
  check(await button.count() === 0, 'a newest SDK that did not come is not offered again');
  // The host can't fetch the newest SDK: the update goes through on the pinned one, and says so.
  fs.writeFileSync(flag.latestFail, '');
  await r.restartClient({ IRO_TEST_SDK_LATEST: '99.0.0' }); // (a client that hasn't tried it yet)
  await r.prepared('newest SDK unavailable');
  await r.update('newest SDK unavailable', { fixed: false });
  await until(async () => /Updated, but could not fetch the newest Claude Code/.test(await note()), 10000, 'the note about the newest SDK');
  check(/E403/.test(await note()), `it says why (${await note()})`);
  fs.rmSync(flag.latestFail);

  // ---- this machine, with a newer SDK out: Reconnect installs it into server/ (without touching package.json or
  // the lock file) before restarting the daemon ----
  r.client.kill('SIGTERM');
  r.killDaemons();
  r.npmReset();
  const LDIR = process.env.IRO_DIR;
  ({ client: r.client } = await startClient(PORT, { env: { ...r.env, HOME: process.env.HOME, IRO_TEST_SDK_LATEST: '99.0.0', IRO_SKILLS_DIR: '' } }));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  check(await until(async () => (await label()) === RECONNECT, 15000), `this machine: Reconnect (${await label()})`);
  check(/99\.0\.0 is out/.test(await reason()) && !/npm install/.test(await reason()), `this machine: the reason, and no npm by hand (${await reason()})`);
  check(/@latest/.test(r.npmCalls()) && !/--prefer-offline/.test(r.npmCalls()) && !fs.existsSync(path.join(LDIR, 'sdk-fetch')),
    `this machine: the newest SDK is downloaded ahead, and installed into server/ only on Reconnect (${r.npmCalls().trim()})`);
  await button.click();
  await until(() => /install --no-save .*--prefer-offline @anthropic-ai\/claude-agent-sdk@latest/.test(r.npmCalls()), 10000, 'npm install --no-save --prefer-offline …@latest in server/');
  await until(() => fs.readdirSync(LDIR).some((f) => /^old-/.test(f)) || /retired/.test(fs.readFileSync(path.join(LDIR, 'daemon.log'), 'utf8')), 15000, 'the local daemon restarts');
  check(r.errors.length === 0, 'no page errors' + (r.errors.length ? ': ' + r.errors.join(' | ') : ''));
} finally {
  await r.close();
}
finish();
