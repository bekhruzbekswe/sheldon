/**
 * CLI: bun run research [options] "<task>"
 *
 * Modes:
 *   first run:  bun run research "<task>" --deadline <dur> [--seeds N] [--max-iters N]
 *   resume:     bun run research --resume
 *   wipe + new: bun run research --fresh "<task>" --deadline <dur>
 *
 * Debug:
 *   --kill-after <dur>   process.exit(137) after the given delay (simulates a hard crash)
 */

import { runResearch } from './research.ts';
import { parseDeadline } from './phase.ts';
import { detectInterruptedRun, clearAll } from './resume.ts';
import { events } from './events.ts';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

type Args = {
  task: string;
  deadline?: string;
  maxIters?: number;
  seeds?: number;
  resume?: boolean;
  fresh?: boolean;
  killAfter?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { task: '' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--deadline' && next !== undefined) {
      out.deadline = next;
      i++;
    } else if (a === '--max-iters' && next !== undefined) {
      out.maxIters = Number(next);
      i++;
    } else if (a === '--seeds' && next !== undefined) {
      out.seeds = Number(next);
      i++;
    } else if (a === '--kill-after' && next !== undefined) {
      out.killAfter = next;
      i++;
    } else if (a === '--resume') {
      out.resume = true;
    } else if (a === '--fresh') {
      out.fresh = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        `Usage:\n  bun run research "<task>" [--deadline <dur>] [--seeds N] [--max-iters N]\n  bun run research --resume\n  bun run research --fresh "<task>" --deadline <dur>\n\n  --deadline    wall-clock budget (5h, 90m, 30s; min 60s)\n  --resume      continue an interrupted run (task and deadline come from saved state)\n  --fresh       wipe .sheldon/ except reports/ then start fresh\n  --kill-after  debug: hard-exit after duration (simulates a crash)`,
      );
      process.exit(0);
    } else if (a !== undefined) {
      positional.push(a);
    }
  }
  out.task = positional.join(' ').trim();
  return out;
}

const args = parseArgs(process.argv.slice(2));

// --resume: load and reuse the persisted run.
if (args.resume) {
  const state = detectInterruptedRun();
  if (!state) {
    console.error(
      'No interrupted run found. Either no `.sheldon/sheldon.db` exists, the prior run completed (phase=done), or it expired the 24h grace window.',
    );
    process.exit(1);
  }
  await events.emit({
    kind: 'resume.detected',
    layer: 'L7',
    payload: {
      task: state.task.slice(0, 120),
      phase: state.phase,
      ageMs: Date.now() - state.startedAt,
      deadlineRemainingMs: state.deadlineAt - Date.now(),
    },
  });
  const ageMin = Math.floor((Date.now() - state.startedAt) / 60000);
  const remainingSec = Math.floor((state.deadlineAt - Date.now()) / 1000);
  const remainingFmt =
    remainingSec > 60
      ? `${Math.floor(remainingSec / 60)}m${remainingSec % 60}s`
      : `${remainingSec}s`;
  console.error(
    yellow(
      `Resuming run "${state.task.slice(0, 80)}" — started ${ageMin}m ago · phase=${state.phase} · deadline ${remainingSec > 0 ? 'in ' + remainingFmt : 'expired ' + (-remainingSec) + 's ago'}`,
    ),
  );

  scheduleKillAfter(args.killAfter);

  try {
    const summary = await runResearch(state.task, { resume: true });
    printSummary(summary);
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

// --fresh: wipe everything except reports/, then continue with normal flow.
if (args.fresh) {
  await clearAll();
  console.error(yellow('--fresh: wiped .sheldon/ (reports/ preserved)'));
}

// Default flow: first run. If an interrupted run is detected, refuse to proceed
// without an explicit --resume or --fresh flag.
if (!args.fresh) {
  const interrupted = detectInterruptedRun();
  if (interrupted) {
    const ageMin = Math.floor((Date.now() - interrupted.startedAt) / 60000);
    console.error(
      yellow(
        `Found interrupted run: "${interrupted.task.slice(0, 80)}" (started ${ageMin}m ago, phase=${interrupted.phase}).`,
      ),
    );
    console.error(`Use ${bold('bun run research --resume')} to continue, or ${bold('bun run research --fresh "<new task>" --deadline <dur>')} to start over.`);
    process.exit(1);
  }
}

if (!args.task) {
  console.error('Usage: bun run research "<task>" [--deadline <dur>] [--seeds N] [--max-iters N]');
  process.exit(1);
}

const opts: { maxIters?: number; seedCount?: number; deadlineAt?: number } = {};

if (args.deadline) {
  try {
    opts.deadlineAt = parseDeadline(args.deadline, Date.now());
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

if (args.maxIters !== undefined) {
  opts.maxIters = args.maxIters;
} else if (!args.deadline) {
  opts.maxIters = 10;
}

if (args.seeds !== undefined) opts.seedCount = args.seeds;

console.error(dim(`task: ${args.task}`));
const cfgBits = [
  `seeds=${args.seeds ?? 12}`,
  `max-iters=${opts.maxIters === Number.POSITIVE_INFINITY ? '∞' : opts.maxIters ?? '∞'}`,
];
if (opts.deadlineAt) {
  const remaining = ((opts.deadlineAt - Date.now()) / 1000).toFixed(0);
  cfgBits.push(`deadline=${new Date(opts.deadlineAt).toISOString()} (in ${remaining}s)`);
}
console.error(dim(`config: ${cfgBits.join('  ')}\n`));

scheduleKillAfter(args.killAfter);

try {
  const summary = await runResearch(args.task, opts);
  printSummary(summary);
} catch (err) {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
}

// ---------- helpers ----------

function parseShortDuration(input: string): number {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) throw new Error(`Invalid duration "${input}" (use 30s, 5m, 2h, 500ms)`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return n * mult;
}

function scheduleKillAfter(input: string | undefined) {
  if (!input) return;
  const ms = parseShortDuration(input);
  console.error(yellow(`--kill-after: process will hard-exit in ${(ms / 1000).toFixed(0)}s`));
  setTimeout(() => {
    console.error(yellow('--kill-after fired: process.exit(137)'));
    process.exit(137);
  }, ms);
}

type ResearchSummary = Awaited<ReturnType<typeof runResearch>>;

function printSummary(summary: ResearchSummary) {
  const elapsedSec = (summary.elapsedMs / 1000).toFixed(1);
  console.log(bold('\n— research summary —'));
  console.log(`  task                 : ${summary.task}`);
  console.log(`  iterations           : ${summary.iterations}`);
  console.log(`  questions seeded     : ${summary.questionsSeeded}`);
  console.log(`  questions proposed   : ${summary.questionsProposed}`);
  console.log(`  proposals deduped    : ${summary.proposalsDeduped}`);
  console.log(`  facts added (total)  : ${summary.factsAddedTotal}`);
  console.log(`  claims extracted     : ${summary.claimsExtractedTotal}`);
  console.log(`  pending remaining    : ${summary.pendingRemaining}`);
  console.log(`  phase reached        : ${summary.phaseReached}`);
  console.log(`  elapsed              : ${elapsedSec}s`);
  if (summary.reportPath) {
    console.log(`  report               : ${summary.reportPath}`);
  }
  console.log(dim('\nUse `bun run inspect --frontier` to see the queue.'));
  console.log(dim('Use `bun run inspect --limit 30` to see recent facts.'));
  if (summary.reportPath) {
    console.log(dim(`Open the report: less ${summary.reportPath}`));
  }
}
