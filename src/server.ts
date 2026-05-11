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

type SynthesisState = {
  substep:
    | 'idle'
    | 'thesis-drafting'
    | 'triangulating'
    | 'writing'
    | 'editing'
    | 'stitching'
    | 'done'
    | 'fallback';
  thesisClaimCount: number | null;
  claims: Array<{
    headline: string;
    corroborations: number;
    contradictions: number;
    contested: boolean;
  }> | null;
  sectionsWritten: number;
  sectionsDropped: number;
  reportPath: string | null;
  fallbackReason: string | null;
};

/**
 * Derive the L6 synthesis substep + per-claim metadata from the events log.
 * Walks events from the most-recent `run.start` forward (or all events if no
 * run.start is present). Substep is the "latest terminal signal" in priority
 * order: fallback > done > stitching > editing > writing > triangulating >
 * thesis-drafting > idle.
 */
function deriveSynthesisState(events: Event[]): SynthesisState {
  // Walk backward for the latest run.start to scope our search.
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind === 'run.start') {
      startIdx = i;
      break;
    }
  }
  const slice = events.slice(startIdx);

  let thesisClaimCount: number | null = null;
  let thesisIdx = -1;
  const claimsByHeadline = new Map<
    string,
    { headline: string; corroborations: number; contradictions: number; contested: boolean }
  >();
  let sectionsWritten = 0;
  let sectionsDropped = 0;
  const rubricForHeadline = new Set<string>();
  const writtenForHeadline = new Set<string>();
  let reportPath: string | null = null;
  let fallbackReason: string | null = null;

  // First pass: find the most-recent thesis.drafted and scope subsequent counts after it.
  for (let i = slice.length - 1; i >= 0; i--) {
    if (slice[i]?.kind === 'thesis.drafted') {
      thesisIdx = i;
      const p = (slice[i]?.payload ?? {}) as Record<string, unknown>;
      if (typeof p.claimCount === 'number') thesisClaimCount = p.claimCount;
      break;
    }
  }

  // Second pass: collect post-thesis (or full-slice if no thesis) signals.
  const postThesisSlice = thesisIdx >= 0 ? slice.slice(thesisIdx) : slice;
  for (const ev of postThesisSlice) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.kind) {
      case 'claim.triangulated': {
        const headline = typeof p.claimHeadline === 'string' ? p.claimHeadline : '';
        if (!headline) break;
        claimsByHeadline.set(headline, {
          headline,
          corroborations: typeof p.corroborations === 'number' ? p.corroborations : 0,
          contradictions: typeof p.contradictions === 'number' ? p.contradictions : 0,
          contested: Boolean(p.contested),
        });
        break;
      }
      case 'section.written': {
        const label = typeof p.label === 'string' ? p.label : '';
        if (!label) break;
        if (!writtenForHeadline.has(label)) {
          writtenForHeadline.add(label);
          sectionsWritten++;
        }
        break;
      }
      case 'section.dropped':
        sectionsDropped++;
        break;
      case 'section.rubric': {
        const headline = typeof p.headline === 'string' ? p.headline : '';
        if (headline && writtenForHeadline.has(headline)) {
          // Rubric for a section that has already been written → editing pass.
          rubricForHeadline.add(headline);
        }
        break;
      }
      case 'report.written':
        reportPath = typeof p.path === 'string' ? p.path : null;
        break;
      case 'synthesis.fallback':
        fallbackReason = typeof p.reason === 'string' ? p.reason : 'unknown';
        // Track fallback's section.written counts globally for the fallback path
        // since they happen outside the thesis-drafted scope.
        break;
    }
  }

  // If we saw a fallback, also count sections from the WHOLE post-fallback slice.
  if (fallbackReason !== null) {
    // Find fallback index; count section events after it.
    let fallbackIdx = -1;
    for (let i = postThesisSlice.length - 1; i >= 0; i--) {
      if (postThesisSlice[i]?.kind === 'synthesis.fallback') {
        fallbackIdx = i;
        break;
      }
    }
    if (fallbackIdx >= 0) {
      sectionsWritten = 0;
      sectionsDropped = 0;
      writtenForHeadline.clear();
      for (let i = fallbackIdx; i < postThesisSlice.length; i++) {
        const ev = postThesisSlice[i]!;
        const p = (ev.payload ?? {}) as Record<string, unknown>;
        if (ev.kind === 'section.written') {
          const label = typeof p.label === 'string' ? p.label : '';
          if (label && !writtenForHeadline.has(label)) {
            writtenForHeadline.add(label);
            sectionsWritten++;
          }
        } else if (ev.kind === 'section.dropped') {
          sectionsDropped++;
        }
      }
    }
  }

  // Substep classification in priority order.
  let substep: SynthesisState['substep'] = 'idle';
  if (fallbackReason !== null && reportPath === null) {
    substep = 'fallback';
  } else if (reportPath !== null) {
    substep = 'done';
  } else if (thesisClaimCount !== null && sectionsWritten >= thesisClaimCount && thesisClaimCount > 0) {
    substep = 'stitching';
  } else if (rubricForHeadline.size > 0) {
    substep = 'editing';
  } else if (sectionsWritten > 0) {
    substep = 'writing';
  } else if (claimsByHeadline.size > 0) {
    substep = 'triangulating';
  } else if (thesisIdx >= 0) {
    substep = 'thesis-drafting';
  }

  const claims = claimsByHeadline.size > 0 ? Array.from(claimsByHeadline.values()) : null;

  return {
    substep,
    thesisClaimCount,
    claims,
    sectionsWritten,
    sectionsDropped,
    reportPath,
    fallbackReason,
  };
}

// ─── markdown → HTML renderer for /api/report ───────────────────────────────
// Minimal converter (no dependency). Supports H1-H3, paragraphs, bullet + ordered
// lists, inline bold / italic / code / links. Plus a special pass that rewrites
// `[N]` citation tokens to <a> elements using the report's `## Sources` section.

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] || ch);
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] || ch,
  );
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Inline code first (protect from other transforms).
  out = out.replace(/`([^`]+?)`/g, (_, c) => `<code>${c}</code>`);
  // Links [text](url).
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${escapeAttr(u)}" target="_blank" rel="noopener">${t}</a>`);
  // Bold **text**.
  out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  // Italic *text* or _text_ (not consuming bold's leftovers because bold ran first).
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
  return out;
}

function renderMdBody(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let inUl = false;
  let inOl = false;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
    para = [];
  };
  const closeUl = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
  };
  const closeOl = () => {
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\s+$/, '');

    // Blank line ends the current block.
    if (line.trim() === '') {
      flushPara();
      closeUl();
      closeOl();
      i++;
      continue;
    }

    // Headings.
    const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      flushPara();
      closeUl();
      closeOl();
      const level = hMatch[1]!.length;
      out.push(`<h${level}>${renderInline(hMatch[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    // Bullet list.
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      closeOl();
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${renderInline(ulMatch[1]!.trim())}</li>`);
      i++;
      continue;
    }

    // Numbered list.
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushPara();
      closeUl();
      if (!inOl) {
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${renderInline(olMatch[1]!.trim())}</li>`);
      i++;
      continue;
    }

    // Default: accumulate into a paragraph.
    closeUl();
    closeOl();
    para.push(line.trim());
    i++;
  }

  flushPara();
  closeUl();
  closeOl();
  return out.join('\n');
}

type SourceEntry = { n: number; title: string; url: string };

function renderReportMarkdown(md: string): { html: string; sources: SourceEntry[] } {
  // Separate body from Sources section.
  const sourcesIdx = md.search(/^##\s+Sources\s*$/m);
  const body = sourcesIdx >= 0 ? md.slice(0, sourcesIdx) : md;
  const sourcesText = sourcesIdx >= 0 ? md.slice(sourcesIdx).replace(/^##\s+Sources\s*\n?/, '') : '';

  // Parse Sources entries: "[N] Title — URL" OR "[N] URL".
  const sources: SourceEntry[] = [];
  const urlByN = new Map<number, string>();
  for (const lineRaw of sourcesText.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    const withTitle = line.match(/^\[(\d+)\]\s+(.+?)\s+[—–-]\s+(https?:\/\/\S+)\s*$/);
    const urlOnly = line.match(/^\[(\d+)\]\s+(https?:\/\/\S+)\s*$/);
    if (withTitle) {
      const n = Number(withTitle[1]);
      const title = withTitle[2]!.trim();
      const url = withTitle[3]!.trim();
      sources.push({ n, title, url });
      urlByN.set(n, url);
    } else if (urlOnly) {
      const n = Number(urlOnly[1]);
      const url = urlOnly[2]!.trim();
      sources.push({ n, title: '', url });
      urlByN.set(n, url);
    }
  }

  // Render body to HTML, then rewrite [N] citation tokens.
  let bodyHtml = renderMdBody(body);
  bodyHtml = bodyHtml.replace(/\[(\d+)\]/g, (full, nStr) => {
    const n = Number(nStr);
    const url = urlByN.get(n);
    if (!url) return full;
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="citation">[${n}]</a>`;
  });

  // Render sources section as an ordered list.
  const sourcesHtml =
    sources.length > 0
      ? `<h2>Sources</h2>\n<ol class="sources-list">\n${sources
          .map(
            (s) =>
              `<li id="src-${s.n}">${
                s.title ? escapeHtml(s.title) + ' — ' : ''
              }<a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.url)}</a></li>`,
          )
          .join('\n')}\n</ol>`
      : '';

  return { html: bodyHtml + (sourcesHtml ? '\n' + sourcesHtml : ''), sources };
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

  app.get('/api/contract', (c) => {
    const db = getDb();
    const row = db
      .query('SELECT contract_json FROM run_state WHERE id = 1')
      .get() as { contract_json: string | null } | null;
    if (!row || !row.contract_json) return c.json(null);
    try {
      const obj = JSON.parse(row.contract_json) as Record<string, unknown>;
      if (typeof obj.core_question !== 'string' || !Array.isArray(obj.out_of_scope)) {
        return c.json(null);
      }
      return c.json({
        core_question: obj.core_question,
        sub_questions: Array.isArray(obj.sub_questions) ? obj.sub_questions : [],
        good_answer_contains: Array.isArray(obj.good_answer_contains) ? obj.good_answer_contains : [],
        out_of_scope: obj.out_of_scope,
      });
    } catch {
      return c.json(null);
    }
  });

  app.get('/api/synthesis-state', async (c) => {
    const events = await readEventLog();
    return c.json(deriveSynthesisState(events));
  });

  app.get('/api/report', async (c) => {
    const state = getRunState();
    const candidates: string[] = [];
    if (state) candidates.push(`.sheldon/reports/${state.startedAt}.md`);
    candidates.push('.sheldon/reports/latest.md');
    let chosen: string | null = null;
    let text = '';
    for (const p of candidates) {
      try {
        const f = Bun.file(p);
        if (await f.exists()) {
          text = await f.text();
          chosen = p;
          break;
        }
      } catch {
        // fall through to next candidate
      }
    }
    if (!chosen) return c.json(null);
    const { html, sources } = renderReportMarkdown(text);
    return c.json({ path: chosen, html, sources });
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
                payload: ev.payload,
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
