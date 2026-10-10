// The IroWell UI skills in this checkout's skills/ (the UI Skills page reads and writes them here; a server
// only ever gets them from this client, on install or Update server): system-prompt.md, appended to Claude
// Code's system prompt, and skills/<name>/SKILL.md with the files beside it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PROMPT = 'system-prompt.md';
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/; // a skill's name: also its folder, and /irowell:<name>
const version = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
// Written next to it first, then moved over it: a session starting meanwhile reads the old file or the new one.
function write(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---- SKILL.md: a `---` frontmatter of `key: value` lines (as Claude Code reads it) and the body

function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields = []; // { key, lines }: a line that starts no key (a list item, a block scalar) belongs to the one above
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (k || !fields.length) fields.push({ key: k?.[1] ?? null, lines: [line] });
    else fields.at(-1).lines.push(line);
  }
  return { fields, body: text.slice(m[0].length) };
}
function valueOf(fields, key) {
  const f = fields.find((x) => x.key === key);
  if (!f) return null;
  const first = f.lines[0].slice(key.length + 1).trim();
  const rest = f.lines.slice(1).map((l) => l.trim()).filter(Boolean);
  if (/^[>|][+-]?$/.test(first)) return rest.join(first[0] === '>' ? ' ' : '\n');
  if (first.startsWith('"')) { try { return JSON.parse(first); } catch {} }
  if (first.length > 1 && first.startsWith("'") && first.endsWith("'")) return first.slice(1, -1).replace(/''/g, "'");
  return [first, ...rest].join(' ');
}
// A plain YAML scalar when it reads as one, else double-quoted (a JSON string is a valid one).
const scalar = (s) => (/^[^\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/: |\s#|:$|\s$/.test(s) ? s : JSON.stringify(s));
// Sets (or, for null, removes) `key`, leaving every other line as it was.
function setField(fields, key, value) {
  const i = fields.findIndex((x) => x.key === key);
  if (value == null) { if (i >= 0) fields.splice(i, 1); return; }
  const f = { key, lines: [`${key}: ${value}`] };
  if (i >= 0) fields[i] = f;
  else fields.push(f);
}

// How a skill is used, from its two switches (Claude Code's defaults: both on).
//   passive – Claude loads it on its own; not a / command      (user-invocable: false)
//   both    – Claude loads it, and /irowell:<name> runs it
//   command – only /irowell:<name>; Claude doesn't see it      (disable-model-invocation: true)
//   off     – neither                                           (both)
const MODES = { passive: [false, false], both: [true, false], command: [true, true], off: [false, true] };
function modeOf(fields) {
  const user = valueOf(fields, 'user-invocable') !== 'false', hidden = valueOf(fields, 'disable-model-invocation') === 'true';
  return Object.keys(MODES).find((k) => MODES[k][0] === user && MODES[k][1] === hidden);
}

// ---- the page's commands

function skillOf(dir, name) {
  const text = read(path.join(dir, name, 'SKILL.md'));
  if (text == null) return null;
  const { fields, body } = parse(text);
  const files = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, name, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && r !== 'SKILL.md' && e.name !== '.DS_Store') files.push(r);
    }
  };
  walk('');
  return { name, description: valueOf(fields, 'description') ?? '', mode: modeOf(fields), body: body.replace(/^\n+/, ''), files: files.sort(), version: version(text) };
}

export function listSkills(dir) {
  const prompt = read(path.join(dir, PROMPT)) ?? '';
  const skills = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME.test(e.name))
    .map((e) => skillOf(dir, e.name)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { prompt: { text: prompt, version: version(prompt) }, skills };
}

// `version`: the file as the page read it. Saving over a file changed since (in an editor, by Claude) is
// refused rather than losing that change.
function check(file, ver) {
  const now = read(file) ?? '';
  if (version(now) !== ver) throw new Error(`${path.basename(path.dirname(file))}/${path.basename(file)} was changed on disk since this page loaded it. Reload it (your edit stays as a draft) and save again.`);
  return now;
}

export function savePrompt(dir, { text, version: ver }) {
  const file = path.join(dir, PROMPT);
  check(file, ver);
  write(file, text.replace(/\s*$/, '\n'));
}

export function saveSkill(dir, { name, description, mode, body, version: ver }) {
  if (!NAME.test(name || '')) throw new Error('No such skill');
  const file = path.join(dir, name, 'SKILL.md');
  const { fields } = parse(check(file, ver));
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  if (!desc) throw new Error('The description can\'t be empty: it is how Claude knows when to use the skill.');
  if (!MODES[mode]) throw new Error(`Unknown mode: ${mode}`);
  setField(fields, 'name', name);
  setField(fields, 'description', scalar(desc));
  setField(fields, 'user-invocable', MODES[mode][0] ? null : 'false');
  setField(fields, 'disable-model-invocation', MODES[mode][1] ? 'true' : null);
  const head = fields.flatMap((f) => f.lines).join('\n');
  write(file, `---\n${head}\n---\n\n${String(body || '').replace(/^\n+/, '').replace(/\s*$/, '\n')}`);
}

// A new skill starts off, so its placeholder description never reaches Claude.
export function newSkill(dir, { name }) {
  if (!NAME.test(name || '') || name.length > 64) throw new Error('A skill name is lowercase letters, digits and dashes (like show-files), up to 64 characters.');
  const folder = path.join(dir, name);
  if (fs.existsSync(folder)) throw new Error(`There is already a skill named ${name}.`);
  fs.mkdirSync(folder);
  write(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Say when Claude should use this skill.\nuser-invocable: false\ndisable-model-invocation: true\n---\n\n# ${name}\n`);
}

// A file beside a skill's SKILL.md, to look at (the page doesn't edit these).
export function skillFile(dir, { name, file }) {
  const s = NAME.test(name || '') && skillOf(dir, name);
  if (!s || !s.files.includes(file)) throw new Error('No such file');
  return read(path.join(dir, name, file));
}
