// "workplace <args>": the session runs the irowell:workplace skill's script with them, as its Bash would.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'workplace', 'workplace.mjs');
export default [
  { match: /^workplace (.+)$/, steps: (m) => [{ tool: 'Bash', ask: false, input: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} ${m[1]}`, description: 'Workplace' } }, { text: 'done' }] },
];
