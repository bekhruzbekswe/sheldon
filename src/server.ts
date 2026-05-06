/**
 * Hono HTTP server backing the L8 dashboard.
 *
 * REST snapshots of run state, frontier, facts, stats — all read-only.
 * SSE stream of newly appended events.jsonl lines, formatted via format.ts.
 *
 * Bound to 127.0.0.1 only. No mutation endpoints.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, resetDb } from './db.ts';
import { getRunState } from './phase.ts';
import { factStore } from './facts.ts';
import { frontier } from './frontier.ts';
import { EVENT_LOG_PATH, type Event } from './events.ts';
import { formatEvent, isErrorEvent } from './format.ts';

const HTML_PATH = join(import.meta.dir, '..', 'web', 'index.html');

type StatRow = {
  factsCollected: number;
  dedupeRate: number;
  scrapeSuccess: number;
  llmTokens: number;
  sparks: { facts: number[]; dedupe: number[]; scrape: number[]; tokens: number[] };
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function safeParseJSONL(text: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

async function readEventLog(): Promise<Event[]> {
  try {
    const file = Bun.file(EVENT_LOG_PATH);
    if (!(await file.exists())) return [];
    return safeParseJSONL(await file.text());
  } catch {
    return [];
  }
}

/**
 * Find the unix-ms timestamp of the most recent `run.end` event in the log,
 * or null if none exists. Used by /api/run-state to expose `endedAt` so the
 * dashboard can freeze the elapsed clock when phase=done.
 */
async function findLastRunEndAt(): Promise<number | null> {
  try {
    const file = Bun.file(EVENT_LOG_PATH);
    if (!(await file.exists())) return null;
    const text = await file.text();
    // Walk lines from the end backward — typically the last run.end is recent.
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"run.end"')) continue;
      try {
        const ev = JSON.parse(line) as Event;
        if (ev.kind === 'run.end') {
          const t = Date.parse(ev.ts);
          return Number.isFinite(t) ? t : null;
        }
      } catch {
        // skip malformed
      }
    }
    return null;
  } catch {
    return null;
  }
}

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
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, fromOffset);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

function computeStats(events: Event[]): StatRow {
  const totalFacts = factStore.count();

  let writes = 0;
  let dedupes = 0;
  let scrapeOk = 0;
  let scrapeSkip = 0;
  let llmTokens = 0;

  // Sparkline buckets: last 30 minutes, one bucket per minute, [bucket-29 .. bucket-0=now].
  const now = Date.now();
  const bucketMin = (ts: string) => {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return -1;
    const ageMin = Math.floor((now - t) / 60_000);
    if (ageMin < 0 || ageMin >= 30) return -1;
    return 29 - ageMin; // index 29 = newest (now), index 0 = 29 minutes ago
  };

  const factsBucket = new Array<number>(30).fill(0);
  const dedupeBucketTotal = new Array<number>(30).fill(0);
  const dedupeBucketDrop = new Array<number>(30).fill(0);
  const scrapeBucketTotal = new Array<number>(30).fill(0);
  const scrapeBucketOk = new Array<number>(30).fill(0);
  const tokensBucket = new Array<number>(30).fill(0);

  for (const ev of events) {
    const b = bucketMin(ev.ts);
    const pay = (ev.payload && typeof ev.payload === 'object'
      ? (ev.payload as Record<string, unknown>)
      : {});

    switch (ev.kind) {
      case 'fact.write':
        writes++;
        if (b >= 0) factsBucket[b]!++;
        if (b >= 0) {
          dedupeBucketTotal[b]!++;
        }
        break;
      case 'fact.dedupe':
        dedupes++;
        if (b >= 0) dedupeBucketTotal[b]!++;
        if (b >= 0) dedupeBucketDrop[b]!++;
        break;
      case 'scrape.fetch':
        scrapeOk++;
        if (b >= 0) {
          scrapeBucketTotal[b]!++;
          scrapeBucketOk[b]!++;
        }
        break;
      case 'scrape.skip':
        scrapeSkip++;
        if (b >= 0) scrapeBucketTotal[b]!++;
        break;
      case 'llm.fast':
      case 'llm.deep': {
        const t = (typeof pay.total_tokens === 'number' ? pay.total_tokens : 0);
        llmTokens += t;
        if (b >= 0) tokensBucket[b]! += t;
        break;
      }
    }
  }

  const dedupeRateOverall =
    writes + dedupes > 0 ? dedupes / (writes + dedupes) : 0;
  const scrapeSuccessOverall =
    scrapeOk + scrapeSkip > 0 ? scrapeOk / (scrapeOk + scrapeSkip) : 0;

  // Per-minute rate sparks; missing buckets carry forward the prior value.
  const dedupeSpark = new Array<number>(30).fill(0);
  const scrapeSpark = new Array<number>(30).fill(0);
  let lastDedupe = dedupeRateOverall;
  let lastScrape = scrapeSuccessOverall;
  for (let i = 0; i < 30; i++) {
    if (dedupeBucketTotal[i]! > 0) {
      lastDedupe = (dedupeBucketDrop[i] ?? 0) / dedupeBucketTotal[i]!;
    }
    dedupeSpark[i] = lastDedupe;
    if (scrapeBucketTotal[i]! > 0) {
      lastScrape = (scrapeBucketOk[i] ?? 0) / scrapeBucketTotal[i]!;
    }
    scrapeSpark[i] = lastScrape;
  }

  return {
    factsCollected: totalFacts,
    dedupeRate: dedupeRateOverall,
    scrapeSuccess: scrapeSuccessOverall,
    llmTokens,
    sparks: {
      facts: factsBucket,
      dedupe: dedupeSpark,
      scrape: scrapeSpark,
      tokens: tokensBucket,
    },
  };
}

export function createApp(): Hono {
  const app = new Hono();

  // 405 for non-GET methods on any path
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.text('Method Not Allowed', 405);
    }
    await next();
  });

  // The agent (writer process) may unlink + recreate the DB file via
  // `--fresh` runs while we're alive. macOS returns SQLITE_IOERR_VNODE when
  // querying through a stale vnode. Resetting the DB handle on every REST
  // request (cheap) keeps us synced with the current file. The SSE handler
  // does no DB queries, so this doesn't affect open streams.
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/events') {
      // SSE: don't churn the DB handle; the handler doesn't query.
      await next();
      return;
    }
    resetDb();
    try {
      await next();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (
        typeof e.code === 'string' &&
        e.code.startsWith('SQLITE_IOERR')
      ) {
        // One automatic retry with a fresh handle.
        resetDb();
        await next();
        return;
      }
      throw err;
    }
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/', (c) => {
    try {
      const html = readFileSync(HTML_PATH, 'utf8');
      return c.html(html);
    } catch (err) {
      return c.text(
        `Dashboard HTML missing at ${HTML_PATH}. Run from the sheldon repo root.\n${(err as Error).message}`,
        500,
      );
    }
  });

  app.get('/api/run-state', async (c) => {
    const state = getRunState();
    const facts = factStore.count();
    const all = frontier.listAll();
    const counts = all.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    if (!state) {
      return c.json({
        phase: 'idle',
        task: null,
        startedAt: null,
        deadlineAt: null,
        endedAt: null,
        iterations: 0,
        factsAdded: facts,
        queuePending: counts.pending ?? 0,
        queueDone: counts.done ?? 0,
        queueSkipped: counts.skipped ?? 0,
        queueInProgress: counts['in-progress'] ?? 0,
      });
    }

    const iterations =
      (counts.done ?? 0) +
      (counts.skipped ?? 0) +
      (counts['in-progress'] ?? 0);

    // For finished runs, expose the timestamp of the latest run.end so the
    // dashboard can freeze the elapsed clock at that moment instead of
    // counting forever past `Date.now()`.
    const endedAt = state.phase === 'done' ? await findLastRunEndAt() : null;

    return c.json({
      phase: state.phase,
      task: state.task,
      startedAt: state.startedAt,
      deadlineAt: state.deadlineAt,
      endedAt,
      iterations,
      factsAdded: facts,
      queuePending: counts.pending ?? 0,
      queueDone: counts.done ?? 0,
      queueSkipped: counts.skipped ?? 0,
      queueInProgress: counts['in-progress'] ?? 0,
    });
  });

  app.get('/api/frontier', (c) => {
    const db = getDb();
    const rows = frontier.listAll();
    const factCountStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM facts WHERE question_id = ?',
    );
    const out = rows.map((r) => {
      const factsAdded =
        r.status === 'pending'
          ? 0
          : (factCountStmt.get(r.id) as { n: number } | null)?.n ?? 0;
      return {
        id: r.id,
        q: r.question,
        score: r.score,
        status: r.status,
        depth: r.depth,
        parent: r.parentId,
        factsAdded,
      };
    });
    return c.json(out);
  });

  app.get('/api/facts', (c) => {
    const limitRaw = Number(c.req.query('limit') ?? '20');
    const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : 20, 1, 100);
    const facts = factStore.list({ limit });
    const out = facts.map((f) => ({
      id: f.id,
      claim: f.claim,
      url: f.sourceUrl,
      site: hostname(f.sourceUrl),
      title: f.sourceTitle ?? '',
      topic: f.topicTag ?? '',
      conf: f.confidence ?? 0,
      ts: f.createdAt,
    }));
    return c.json(out);
  });

  app.get('/api/stats', async (c) => {
    const events = await readEventLog();
    return c.json(computeStats(events));
  });

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      let offset = await fileSize(EVENT_LOG_PATH);
      if (offset < 0) offset = 0;
      const KEEPALIVE_MS = 25_000;
      const POLL_MS = 250;
      let lastKeepalive = Date.now();
      let connected = true;

      stream.onAbort(() => {
        connected = false;
      });

      while (connected) {
        try {
          const size = await fileSize(EVENT_LOG_PATH);
          if (size > offset) {
            const slice = await readSlice(EVENT_LOG_PATH, offset, size);
            offset = size;
            for (const raw of slice.split('\n')) {
              if (!raw.trim()) continue;
              let ev: Event;
              try {
                ev = JSON.parse(raw) as Event;
              } catch {
                continue;
              }
              const summary = formatEvent(ev);
              const data = JSON.stringify({
                ts: ev.ts,
                kind: ev.kind,
                layer: ev.layer,
                ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
                summary,
                ...(isErrorEvent(ev) ? { error: true } : {}),
              });
              await stream.writeSSE({ data });
            }
          } else if (size >= 0 && size < offset) {
            // file shrank (rotation/delete) — reset
            offset = 0;
          }
        } catch {
          // best-effort; keep tailing
        }

        if (Date.now() - lastKeepalive > KEEPALIVE_MS) {
          await stream.writeSSE({ data: '', event: 'keepalive' });
          lastKeepalive = Date.now();
        }
        await stream.sleep(POLL_MS);
      }
    });
  });

  return app;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
