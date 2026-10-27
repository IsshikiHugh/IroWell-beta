// What the fake Claude of layout, commands, statusline and btw shares: long canned answers.

// `n` numbered one-line facts about `topic` (a long answer to scroll through).
export const facts = (n, topic) => Array.from({ length: n }, (_, i) =>
  `${i + 1}. Fact ${i + 1} about ${topic}: one plain sentence, long enough to fill most of a line in the feed.`).join('\n');

// `text` as `parts` messages `ms` apart, so the reply comes in while the page is watched.
export function streamed(text, parts = 4, ms = 200) {
  const lines = text.split('\n'), per = Math.ceil(lines.length / parts), out = [];
  for (let i = 0; i < lines.length; i += per) {
    if (out.length) out.push({ sleep: ms });
    out.push({ text: lines.slice(i, i + per).join('\n') });
  }
  return out;
}

// The rule for "list N numbered … facts about X".
export const factsRule = { match: /list (\d+) numbered .*?facts about (\w+)/i, steps: (m) => streamed(facts(Number(m[1]), m[2])) };
