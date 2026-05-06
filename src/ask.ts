/**
 * CLI: bun run ask "<question>"
 *
 * Runs the L2 search loop end-to-end and prints the summary.
 */

import { searchLoop, SUMMARY_FILE } from './loop.ts';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('Usage: bun run ask "<your question>"');
  process.exit(1);
}

console.error(dim(`question: ${question}\n`));

try {
  const summary = await searchLoop.answer(question);
  console.log(bold('\n— summary —'));
  console.log(summary);
  console.error(dim(`\n(also written to ${SUMMARY_FILE})`));
} catch (err) {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
}
