/**
 * CLI: bun run synthesize
 *
 * Standalone synthesis against the existing fact DB. Useful for:
 *   - re-running synthesis after a crash
 *   - regenerating the report with prompt tweaks
 *   - testing L6 without spending hours on research
 */

import { synthesize } from './synthesize.ts';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

try {
  const result = await synthesize();
  if (!result) {
    console.error('synthesize: nothing to write (no facts, or no clusters survived).');
    process.exit(1);
  }
  console.log(bold('— report —'));
  console.log(`  path        : ${result.reportPath}`);
  console.log(`  latest      : ${result.latestPath}`);
  console.log(`  sections    : ${result.sectionCount}`);
  console.log(`  facts used  : ${result.factCount}`);
  console.log(`  size        : ${(result.bytes / 1024).toFixed(1)} KB`);
  console.log(dim(`\nOpen: less ${result.latestPath}`));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
