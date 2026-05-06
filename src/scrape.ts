/**
 * Web scraper: fetch URL → jsdom → Mozilla Readability → cleaned plaintext.
 *
 * Never throws. Network failures, non-HTML responses, Readability misses —
 * all return null and emit a `scrape.skip` event with a reason.
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { events } from './events.ts';

export type ScrapeOk = {
  url: string;
  title: string;
  text: string;
  charCount: number;
  truncated: boolean;
};

export type ScrapeResult = ScrapeOk | null;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 24_000;

async function emitSkip(url: string, durationMs: number, reason: string) {
  await events.emit({
    kind: 'scrape.skip',
    layer: 'L2',
    durationMs,
    payload: { url, reason },
  });
}

export const scraper = {
  async fetch(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ScrapeResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const startedAt = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
      });
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      const isAbort = (err as Error).name === 'AbortError';
      await emitSkip(url, durationMs, isAbort ? 'timeout' : (err as Error).message);
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const durationMs = Math.round(performance.now() - startedAt);
      await emitSkip(url, durationMs, `HTTP ${res.status}`);
      return null;
    }

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().startsWith('text/html')) {
      const durationMs = Math.round(performance.now() - startedAt);
      await emitSkip(url, durationMs, `non-html (${ct.split(';')[0]})`);
      return null;
    }

    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      await emitSkip(url, durationMs, `body read failed: ${(err as Error).message}`);
      return null;
    }

    let title = '';
    let text = '';
    try {
      // Silence jsdom's parse warnings — we don't care about CSS errors etc.
      const virtualConsole = new VirtualConsole();
      const dom = new JSDOM(html, { url, virtualConsole });
      const article = new Readability(dom.window.document).parse();
      if (!article || !article.textContent || !article.textContent.trim()) {
        const durationMs = Math.round(performance.now() - startedAt);
        await emitSkip(url, durationMs, 'readability returned empty');
        return null;
      }
      title = (article.title ?? '').trim();
      text = article.textContent.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      await emitSkip(url, durationMs, `readability error: ${(err as Error).message}`);
      return null;
    }

    const truncated = text.length > MAX_TEXT_CHARS;
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS);

    const durationMs = Math.round(performance.now() - startedAt);
    await events.emit({
      kind: 'scrape.fetch',
      layer: 'L2',
      durationMs,
      payload: {
        url,
        title: title.slice(0, 80),
        charCount: text.length,
        truncated,
      },
    });

    return { url, title, text, charCount: text.length, truncated };
  },
};
