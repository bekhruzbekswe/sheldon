/**
 * SearXNG client. Reads SEARXNG_BASE_URL from env (default http://localhost:8888).
 *
 * Returns ranked results in the order SearXNG returned them. We don't dedupe
 * or rerank here — that's L3's job.
 */

import { events } from './events.ts';

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type QueryOptions = {
  categories?: string[];
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = 'http://localhost:8888';
const DEFAULT_TIMEOUT_MS = 10_000;

function getBaseURL(): string {
  return (process.env.SEARXNG_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function emitFailure(query: string, durationMs: number, error: string) {
  await events.emit({
    kind: 'search.query',
    layer: 'L2',
    durationMs,
    payload: { query: query.slice(0, 80), error },
  });
}

export const searxngClient = {
  async query(text: string, opts: QueryOptions = {}): Promise<SearchResult[]> {
    if (!text.trim()) {
      throw new Error('searxngClient: empty query');
    }

    const params = new URLSearchParams({
      q: text,
      format: 'json',
      categories: (opts.categories ?? ['general']).join(','),
    });
    const url = `${getBaseURL()}/search?${params.toString()}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const startedAt = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      const isAbort = (err as Error).name === 'AbortError';
      const msg = isAbort ? 'timeout after 10s' : (err as Error).message;
      await emitFailure(text, durationMs, msg);
      throw new Error(`searxngClient: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Math.round(performance.now() - startedAt);

    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      await emitFailure(text, durationMs, msg);
      throw new Error(`searxngClient: ${msg}`);
    }

    const data = (await res.json()) as { results?: SearchResult[] };
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r as { content?: string; snippet?: string }).snippet ??
        (r as { content?: string }).content ?? '',
    }));

    await events.emit({
      kind: 'search.query',
      layer: 'L2',
      durationMs,
      payload: {
        query: text.slice(0, 80),
        resultCount: results.length,
        topUrl: results[0]?.url,
      },
    });

    return results;
  },
};
