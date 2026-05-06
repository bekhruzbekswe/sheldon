import { llm, type LlmResponse } from './llm.ts';

const PROMPT = 'What is 17 * 23? Reply with just the number.';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function show(label: string, color: (s: string) => string, r: LlmResponse) {
  const reasoningLen = r.reasoning.length;
  const reasoningPreview = r.reasoning.slice(0, 80).replace(/\s+/g, ' ');
  console.log(`${color(bold(label))} ${dim(`(${r.latencyMs}ms)`)}`);
  console.log(`  content   : ${JSON.stringify(r.content)}`);
  console.log(
    `  reasoning : ${reasoningLen} chars${reasoningLen ? ` — ${dim(JSON.stringify(reasoningPreview) + (reasoningLen > 80 ? '…' : ''))}` : ''}`,
  );
  console.log(
    `  usage     : prompt=${r.usage.prompt_tokens} completion=${r.usage.completion_tokens} total=${r.usage.total_tokens}`,
  );
  console.log();
}

console.log(dim(`prompt: ${PROMPT}\n`));

const fastRes = await llm.fast([{ role: 'user', content: PROMPT }]);
show('FAST  (enable_thinking: false)', cyan, fastRes);

const deepRes = await llm.deep([{ role: 'user', content: PROMPT }]);
show('DEEP  (enable_thinking: true)', yellow, deepRes);

console.log(dim('— smoke test complete —'));
