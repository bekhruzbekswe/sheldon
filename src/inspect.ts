/**
 * CLI: bun run inspect [--limit N] [--topic X] [--source URL]
 *
 * Prints the most recent facts as a tab-aligned table.
 */

import { factStore } from './facts.ts';
import { frontier } from './frontier.ts';
import { getRunState } from './phase.ts';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

type Args = {
  limit?: number;
  topic?: string;
  source?: string;
  frontier?: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--limit' && next) {
      out.limit = Number(next);
      i++;
    } else if (a === '--topic' && next) {
      out.topic = next;
      i++;
    } else if (a === '--source' && next) {
      out.source = next;
      i++;
    } else if (a === '--frontier') {
      out.frontier = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        `Usage: bun run inspect [--limit N] [--topic <tag>] [--source <url>] [--frontier]\n\nDumps recent facts (default) or the frontier queue from .sheldon/sheldon.db.`,
      );
      process.exit(0);
    }
  }
  return out;
}

function statusBadge(status: string): string {
  switch (status) {
    case 'pending':
      return cyan('pending');
    case 'in-progress':
      return yellow('working');
    case 'done':
      return green('done   ');
    case 'skipped':
      return dim('skipped');
    default:
      return status;
  }
}

function trunc(s: string | null, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function colorByConfidence(c: number | null): (s: string) => string {
  if (c === null) return (s) => s;
  if (c >= 0.85) return green;
  if (c >= 0.5) return yellow;
  return dim;
}

const args = parseArgs(process.argv.slice(2));

function fmtRunState() {
  const s = getRunState();
  if (!s) {
    console.log(dim('no active run'));
    console.log();
    return;
  }
  const remainingMs = s.deadlineAt - Date.now();
  const remaining =
    remainingMs > 0
      ? `${Math.floor(remainingMs / 60000)}m${Math.floor((remainingMs % 60000) / 1000)}s remaining`
      : `expired ${Math.floor(-remainingMs / 60000)}m ago`;
  console.log(
    bold(`run: ${s.task.slice(0, 80)}`) +
      dim(
        `  · phase=${s.phase}  · started=${new Date(s.startedAt).toISOString().slice(11, 19)}  · ${remaining}`,
      ),
  );
  console.log();
}

if (args.frontier) {
  fmtRunState();
  const rows = frontier.listAll();
  const order = { pending: 0, 'in-progress': 1, done: 2, skipped: 3 } as const;
  rows.sort((a, b) => {
    const ord = (order[a.status as keyof typeof order] ?? 4) - (order[b.status as keyof typeof order] ?? 4);
    if (ord !== 0) return ord;
    if (a.status === 'pending') return b.score - a.score;
    if (a.status === 'done' || a.status === 'in-progress') {
      const ap = a.processedAt ?? 0;
      const bp = b.processedAt ?? 0;
      return bp - ap;
    }
    return a.id - b.id;
  });

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    bold(
      `frontier: ${rows.length} total · ` +
        `pending=${counts.pending ?? 0} working=${counts['in-progress'] ?? 0} done=${counts.done ?? 0} skipped=${counts.skipped ?? 0}`,
    ),
  );
  console.log();

  if (rows.length === 0) {
    console.log(dim('frontier is empty.'));
    process.exit(0);
  }

  for (const r of rows) {
    const idStr = dim(`#${String(r.id).padStart(4)}`);
    const sc = r.score.toFixed(3);
    const depthStr = dim(`d=${r.depth}`);
    const parent = r.parentId !== null ? dim(`◀${r.parentId}`) : dim('◀-');
    const q = r.question.length > 110 ? r.question.slice(0, 109) + '…' : r.question;
    console.log(`${idStr}  ${statusBadge(r.status)}  ${sc}  ${depthStr}  ${parent}  ${q}`);
  }
  process.exit(0);
}

const filterOpts: { limit?: number; topicTag?: string; sourceUrl?: string } = {};
if (args.limit !== undefined) filterOpts.limit = args.limit;
if (args.topic !== undefined) filterOpts.topicTag = args.topic;
if (args.source !== undefined) filterOpts.sourceUrl = args.source;

const total = factStore.count();
const rows = factStore.list(filterOpts);

console.log(
  bold(`facts: ${total} total · showing ${rows.length}`) +
    (args.topic ? dim(` · topic=${args.topic}`) : '') +
    (args.source ? dim(` · source=${args.source}`) : ''),
);
console.log();

if (rows.length === 0) {
  console.log(dim('no rows match.'));
  process.exit(0);
}

for (const r of rows) {
  const conf =
    r.confidence !== null
      ? colorByConfidence(r.confidence)(r.confidence.toFixed(2))
      : dim('--');
  const idStr = dim(`#${String(r.id).padStart(4)}`);
  const topic = r.topicTag ? cyan(`[${r.topicTag}]`) : '';
  const claim = trunc(r.claim, 110);
  const source = dim(`(${trunc(r.sourceUrl, 60)})`);
  console.log(`${idStr}  ${conf}  ${topic ? topic + ' ' : ''}${claim}`);
  console.log(`        ${source}`);
}
