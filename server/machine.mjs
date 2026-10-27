// The server's state, for a plugin's api.machine() (the machine plugin: plugins/machine), read by its daemon
// (daemon.mjs, "machine"): CPU per core, memory, swap, load, the processes (as htop lists them) and the NVIDIA
// GPUs with their processes (as nvitop; `gpus` is null when there is no nvidia-smi).
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const NVIDIA_SMI = process.env.IRO_NVIDIA_SMI || 'nvidia-smi'; // (the tests: a fake one)
const MIN_GAP = 500; // ms: a read sooner than this after the last one gets the last CPU numbers again
const NO_GPU_RETRY = 30_000; // ms before nvidia-smi is looked for again, once it wasn't there

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 16 << 20 },
  (err, out) => resolve(err ? { err } : { out })));
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

// Each core's share busy since the last read (0–1).
let cpuLast = null; // { at, times: [{ busy, all }], usage: [...] }
const cpuTimes = () => os.cpus().map(({ times: t }) => ({ busy: t.user + t.nice + t.sys + t.irq, all: t.user + t.nice + t.sys + t.irq + t.idle }));
async function cpuUsage() {
  if (!cpuLast) { cpuLast = { at: Date.now(), times: cpuTimes() }; await new Promise((r) => setTimeout(r, 250)); }
  if (cpuLast.usage && Date.now() - cpuLast.at < MIN_GAP) return cpuLast.usage;
  const times = cpuTimes();
  const usage = times.map((t, i) => {
    const p = cpuLast.times[i];
    const all = p ? t.all - p.all : 0;
    return all > 0 ? Math.min(1, Math.max(0, (t.busy - p.busy) / all)) : 0;
  });
  cpuLast = { at: Date.now(), times, usage };
  return usage;
}

// Memory and swap in bytes: { mem: { total, used }, swap: { total, used } }. "Used" is what programs hold,
// not what the system keeps as cache (Linux: MemAvailable; macOS: Activity Monitor's app + wired + compressed).
async function memory() {
  const total = os.totalmem();
  if (process.platform === 'linux') {
    try {
      const m = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
        .map((l) => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((x) => [x[1], Number(x[2]) * 1024]));
      return { mem: { total: m.MemTotal, used: m.MemTotal - (m.MemAvailable ?? m.MemFree) }, swap: { total: m.SwapTotal || 0, used: (m.SwapTotal || 0) - (m.SwapFree || 0) } };
    } catch {}
  }
  if (process.platform === 'darwin') {
    const [vm, sw] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage'])]);
    if (vm.out) {
      const page = Number(vm.out.match(/page size of (\d+)/)?.[1]) || 4096;
      const pages = (name) => Number(vm.out.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1]) || 0;
      const used = (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
      const mb = (k) => (num(sw.out?.match(new RegExp(`${k} = ([\\d.]+)M`))?.[1]) || 0) * 1024 * 1024;
      return { mem: { total, used: Math.min(total, used) }, swap: { total: mb('total'), used: mb('used') } };
    }
  }
  return { mem: { total, used: total - os.freemem() }, swap: { total: 0, used: 0 } };
}

// The processes: [{ pid, user, cpu (% of one core), mem (% of memory), rss (bytes), time, state, command,
// prog }]: `prog` is the start of `command` that names the program (its path may hold spaces, as macOS apps'
// do), `command` is cut at CMD_MAX. On Linux `cpu` is measured between reads from /proc (ps gives the
// average over the process's life).
const CMD_MAX = 400;
let procLast = null; // { at, ticks: Map(pid → ticks), cpu: Map(pid → %) }
const CLK_TCK = 100;
function linuxCpu(pids) {
  if (procLast?.cpu && Date.now() - procLast.at < MIN_GAP) return procLast.cpu;
  const at = Date.now(), ticks = new Map(), cpu = new Map();
  for (const pid of pids) {
    try {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' '); // (the name, in parentheses, may hold spaces)
      ticks.set(pid, Number(f[11]) + Number(f[12])); // utime + stime
    } catch {}
  }
  if (procLast) {
    const secs = (at - procLast.at) / 1000;
    for (const [pid, t] of ticks) if (procLast.ticks.has(pid)) cpu.set(pid, ((t - procLast.ticks.get(pid)) / CLK_TCK / secs) * 100);
  }
  procLast = { at, ticks, cpu: procLast ? cpu : null };
  return cpu;
}
async function processes() {
  const [{ out }, names] = await Promise.all([
    run('ps', ['axww', '-o', 'pid=,user=,pcpu=,pmem=,rss=,time=,state=,args=']),
    run('ps', ['axww', '-o', 'pid=,comm=']), // (the program alone: on macOS its whole path)
  ]);
  if (!out) return [];
  const comm = new Map();
  for (const line of (names.out || '').split('\n')) { const m = line.match(/^\s*(\d+)\s+(.*?)\s*$/); if (m) comm.set(Number(m[1]), m[2]); }
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]), command = m[8], c = comm.get(pid);
    const prog = c && command.startsWith(c) ? c : command.split(' ')[0];
    list.push({ pid, user: m[2], cpu: Number(m[3]), mem: Number(m[4]), rss: Number(m[5]) * 1024, time: m[6], state: m[7], command: command.slice(0, CMD_MAX), prog });
  }
  if (process.platform === 'linux') {
    const cpu = linuxCpu(list.map((p) => p.pid));
    if (cpu) for (const p of list) p.cpu = Math.round((cpu.get(p.pid) ?? 0) * 10) / 10;
  }
  return list;
}

// The NVIDIA GPUs: [{ index, name, util (%), memUsed, memTotal (bytes), temp (°C), power, powerLimit (W),
// fan (%), procs: [{ pid, mem (bytes) }] }]; null when there is no nvidia-smi (or it fails).
let noGpuSince = 0;
async function gpus() {
  if (noGpuSince && Date.now() - noGpuSince < NO_GPU_RETRY) return null;
  const MB = 1024 * 1024;
  const [g, a] = await Promise.all([
    run(NVIDIA_SMI, ['--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed', '--format=csv,noheader,nounits']),
    run(NVIDIA_SMI, ['--query-compute-apps=gpu_uuid,pid,used_memory', '--format=csv,noheader,nounits']),
  ]);
  if (!g.out) { noGpuSince = Date.now(); return null; }
  noGpuSince = 0;
  const rows = (text) => (text || '').split('\n').filter((l) => l.trim()).map((l) => l.split(',').map((s) => s.trim()));
  const list = rows(g.out).filter((r) => r.length >= 10).map(([index, uuid, name, util, memUsed, memTotal, temp, power, powerLimit, fan]) => ({
    index: Number(index), uuid, name, util: num(util), memUsed: (num(memUsed) ?? 0) * MB, memTotal: (num(memTotal) ?? 0) * MB,
    temp: num(temp), power: num(power), powerLimit: num(powerLimit), fan: num(fan), procs: [],
  }));
  for (const [uuid, pid, mem] of rows(a.out)) {
    const gpu = list.find((x) => x.uuid === uuid);
    if (gpu && Number(pid)) gpu.procs.push({ pid: Number(pid), mem: (num(mem) ?? 0) * MB });
  }
  for (const x of list) delete x.uuid;
  return list;
}

// One read: { at, host, cpus: [0–1 per core], load: [1, 5, 15 min], uptime (s), mem, swap, gpus, procs? }.
// `procs`: the process list too (the plugin's page asks for it; its tile doesn't).
export async function machine({ procs = false } = {}) {
  const [cpus, mm, gs, ps] = await Promise.all([cpuUsage(), memory(), gpus(), procs ? processes() : null]);
  return { at: Date.now(), host: os.hostname(), cpus, load: os.loadavg(), uptime: os.uptime(), ...mm, gpus: gs, ...(ps ? { procs: ps } : {}) };
}
