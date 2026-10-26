import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lines } from './shared.mjs';

export const CODEX_RUNTIME = JSON.parse(fs.readFileSync(new URL('./codex-runtime.json', import.meta.url), 'utf8'));
const run = (cmd, args, options = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000, maxBuffer: 2 << 20, ...options }, (e, out, err) => e ? reject(new Error(String(err || e.message).trim())) : resolve(out.trim())));

export function codexInstallation(dir) {
  const root = path.join(dir, 'runtimes', `codex-${CODEX_RUNTIME.version}-${process.platform}-${process.arch}`);
  const bin = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  let installing = null, error = '';
  const status = () => ({ version: CODEX_RUNTIME.version, installed: fs.existsSync(process.env.IRO_TEST_CODEX_BIN || bin), installing: !!installing, error, platform: `${process.platform}/${process.arch}` });
  const command = () => {
    // A separate test executable keeps protocol tests independent of accounts and network access.
    if (process.env.IRO_TEST_CODEX_BIN) return { cmd: process.execPath, args: [process.env.IRO_TEST_CODEX_BIN] };
    if (!fs.existsSync(bin)) throw new Error(`Codex ${CODEX_RUNTIME.version} is not installed. Open Codex account → Install on this host.`);
    return { cmd: process.execPath, args: [bin] };
  };
  async function check() {
    const { cmd, args } = command();
    const version = await run(cmd, [...args, '--version'], { timeout: 15000 });
    if (!version.endsWith(` ${CODEX_RUNTIME.version}`)) throw new Error(`Expected Codex ${CODEX_RUNTIME.version}; found ${version}`);
  }
  function install() {
    if (installing) return installing;
    error = '';
    installing = (async () => {
      fs.mkdirSync(root, { recursive: true });
      await run('npm', ['install', '--prefix', root, '--no-save', '--no-audit', '--no-fund', `${CODEX_RUNTIME.package}@${CODEX_RUNTIME.version}`]);
      await check();
    })().catch(e => { error = e.message; throw e; }).finally(() => { installing = null; });
    return installing;
  }
  return { command, status, install, check };
}

// The only wire boundary. Stdout carries JSONL; stderr is never forwarded to the browser.
export class CodexRpc extends EventEmitter {
  constructor(installation) {
    super();
    this.installation = installation;
    this.pending = new Map();
    this.nextId = 1;
  }
  start() {
    if (this.starting) return this.starting;
    this.starting = this.open().catch(e => { this.starting = null; throw e; });
    return this.starting;
  }
  async open() {
    await this.installation.check();
    const { cmd, args } = this.installation.command();
    const proc = this.proc = spawn(cmd, [...args, 'app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.setEncoding('utf8');
    proc.stderr.resume();
    proc.stdin.on('error', () => {}); // exit closes the pending requests
    proc.stdout.on('data', lines(line => {
      let message;
      try { message = JSON.parse(line); } catch { proc.kill(); return; }
      if (message.method) this.emit(message.id == null ? 'notification' : 'request', message);
      else {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(Object.assign(new Error(`Codex ${p.method}: ${message.error.message}`), { code: message.error.code }));
        else p.resolve(message.result);
      }
    }));
    let ended = false;
    const end = why => {
      if (ended) return;
      ended = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
      this.pending.clear();
      if (this.proc === proc) { this.proc = null; this.starting = null; }
      this.emit('exit', why);
    };
    proc.on('error', e => end(e.message));
    proc.on('exit', (code, signal) => end(`Codex runtime stopped (${signal || code})`));
    this.done = new Promise(resolve => proc.once('close', resolve));
    try {
      await this.request('initialize', { clientInfo: { name: 'irowell', title: 'IroWell', version: '0.0.2' }, capabilities: { experimentalApi: true } });
    } catch (e) { await this.stop(); throw e; }
    this.write({ method: 'initialized', params: {} });
  }
  write(message) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error('Codex runtime is not connected');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 25000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} did not answer; its result may be unknown`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async call(method, params, timeout) { await this.start(); return this.request(method, params, timeout); }
  answer(id, result) { this.write({ id, result }); }
  reject(id, message) { this.write({ id, error: { code: -32601, message } }); }
  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    await this.done;
    clearTimeout(timer);
  }
}
