/**
 * Tail .sheldon/events.jsonl, render one colored line per event.
 *
 * Polling-based follower (200ms interval). Cross-platform reliable; fs.watch
 * is flaky on macOS for append-only files.
 *
 * Flags:
 *   --kind  llm.*,search.query   (comma-separated, trailing * is glob)
 *   --layer L0,L2                (comma-separated, exact match)
 *   --since 5m | 1h | 30s        (events older than this are skipped)
 */

import { open } from 'node:fs/promises';
import type { Event } from './events.ts';
import { EVENT_LOG_PATH } from './events.ts';

const POLL_INTERVAL_MS = 200;

// ---- ANSI color helpers ----
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

function colorForKind(kind: string): (s: string) => string {
  const family = kind.split('.')[0];
  switch (family) {
    case 'llm':
      return cyan;
    case 'search':
      return blue;
    case 'scrape':
      return magenta;
    case 'fact':
      return green;
    case 'frontier':
      return yellow;
    default:
      return (s) => s;
  }
}

// ---- Filter parsing ----
type Filters = {
  kind?: { exact: Set<string>; prefixes: string[] };
  layer?: Set<string>;
  sinceMs?: number;
};

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) throw new Error(`Invalid --since duration: ${s} (use 30s, 5m, 2h, 500ms)`);
  const n = Number(m[1]);
  const unit = m[2]!;
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return n * mult;
}

function parseArgs(argv: string[]): Filters {
  const filters: Filters = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--kind' && next) {
      const parts = next.split(',').map((s) => s.trim()).filter(Boolean);
      const exact = new Set<string>();
      const prefixes: string[] = [];
      for (const p of parts) {
        if (p.endsWith('*')) prefixes.push(p.slice(0, -1));
        else exact.add(p);
      }
      filters.kind = { exact, prefixes };
      i++;
    } else if (a === '--layer' && next) {
      filters.layer = new Set(next.split(',').map((s) => s.trim()).filter(Boolean));
      i++;
    } else if (a === '--since' && next) {
      filters.sinceMs = parseDuration(next);
      i++;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return filters;
}

function printHelp() {
  console.log(`Usage: bun run watch [--kind <list>] [--layer <list>] [--since <duration>]

Tails .sheldon/events.jsonl in real time.

  --kind   comma-separated kinds, supports trailing * (e.g. llm.*,search.query)
  --layer  comma-separated layer ids (e.g. L0,L2)
  --since  duration window (e.g. 30s, 5m, 1h)`);
}

function passesFilter(ev: Event, filters: Filters, nowMs: number): boolean {
  if (filters.kind) {
    const exact = filters.kind.exact.has(ev.kind);
    const prefix = filters.kind.prefixes.some((p) => ev.kind.startsWith(p));
    if (!exact && !prefix) return false;
  }
  if (filters.layer && !filters.layer.has(ev.layer)) return false;
  if (filters.sinceMs !== undefined) {
    const tsMs = Date.parse(ev.ts);
    if (Number.isFinite(tsMs) && nowMs - tsMs > filters.sinceMs) return false;
  }
  return true;
}

// ---- Formatting ----
function shortPayload(ev: Event): string {
  if (ev.payload && typeof ev.payload === 'object') {
    const obj = ev.payload as Record<string, unknown>;
    if (typeof obj.error === 'string') return red(`ERR: ${truncate(obj.error, 70)}`);
    if (typeof obj.prompt === 'string') {
      const usage =
        typeof obj.total_tokens === 'number'
          ? dim(` (${obj.completion_tokens}/${obj.total_tokens} tok)`)
          : '';
      return `"${truncate(obj.prompt, 60)}"` + usage;
    }
    return truncate(JSON.stringify(obj), 80);
  }
  return truncate(JSON.stringify(ev.payload ?? ''), 80);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8);
}

function renderLine(ev: Event): string {
  const color = colorForKind(ev.kind);
  const time = dim(formatTime(ev.ts));
  const kind = bold(color(ev.kind.toUpperCase().padEnd(14)));
  const layer = dim(`[${ev.layer}]`);
  const dur =
    ev.durationMs !== undefined ? dim(`(${ev.durationMs}ms)`.padStart(9)) : '         ';
  const body = shortPayload(ev);
  return `${time} ${kind} ${layer} ${dur} ${body}`;
}

// ---- Tail loop ----
async function fileSize(path: string): Promise<number> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return -1;
    return f.size;
  } catch {
    return -1;
  }
}

async function readSlice(path: string, fromOffset: number, toOffset: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const len = toOffset - fromOffset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, fromOffset);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

async function tail(filters: Filters) {
  const path = EVENT_LOG_PATH;
  let printedFile = false;
  let offset = 0;

  // One-shot: read whatever exists first.
  let initialSize = await fileSize(path);
  if (initialSize < 0) {
    console.log(dim(`waiting for ${path} …`));
  } else {
    const text = await readSlice(path, 0, initialSize);
    emitLines(text, filters);
    offset = initialSize;
    printedFile = true;
  }

  // Poll loop.
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const size = await fileSize(path);
    if (size < 0) continue;
    if (!printedFile) {
      console.log(dim(`tailing ${path}`));
      printedFile = true;
    }
    if (size <= offset) continue;
    const slice = await readSlice(path, offset, size);
    offset = size;
    emitLines(slice, filters);
  }
}

function emitLines(chunk: string, filters: Filters) {
  const now = Date.now();
  for (const raw of chunk.split('\n')) {
    if (!raw.trim()) continue;
    let ev: Event;
    try {
      ev = JSON.parse(raw) as Event;
    } catch {
      // Malformed line (rare; partial last line during a write race). Skip.
      continue;
    }
    if (!passesFilter(ev, filters, now)) continue;
    console.log(renderLine(ev));
  }
}

const filters = parseArgs(process.argv.slice(2));
await tail(filters);
