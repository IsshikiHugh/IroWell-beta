// The fake Claude's replies for branch.mjs: an edit to rewind (the fake keeps a checkpoint of the file before it).
export default [
  { match: /^Change "(\w+)" to "(\w+)" in (\S+)\./, steps: (m) => [{ tool: 'Edit', input: { file_path: m[3], old_string: m[1], new_string: m[2] }, ask: false }, { text: 'done' }] },
];
