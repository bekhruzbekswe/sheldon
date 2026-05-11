/**
 * Single-shot search loop.
 *
 * question → SearXNG (1 query, top 3) → scrape in parallel
 *          → drop nulls → assemble prompt → llm.fast → write last-summary.md
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { searxngClient } from './search.ts';
import { scraper, type ScrapeOk } from './scrape.ts';
import { llm, type Message } from './llm.ts';
import { events } from './events.ts';
import { chunkText } from './chunker.ts';
import { extractor } from './extract.ts';
import { embedder } from './embed.ts';
import { factStore } from './facts.ts';
import { extractDomain, lookupSource, classifySource } from './classify.ts';

const TOP_N = 3;
const SUMMARY_PATH = '.sheldon/last-summary.md';

const SYSTEM_PROMPT =
  'You are summarizing search results to answer a user question. ' +
  'Be concise (≤300 words) and structured. ' +
  'Cite every claim with the source index in square brackets, e.g. [1] [2]. ' +
  'If sources disagree, note the disagreement and cite both. ' +
  'Do not invent facts that aren\'t in the provided sources.';

function buildUserMessage(question: string, sources: ScrapeOk[]): string {
  const blocks = sources
    .map(
      (s, i) =>
        `<result index=${i + 1} url="${s.url}" title=${JSON.stringify(s.title || '(untitled)')}>\n${s.text}\n</result>`,
    )
    .join('\n\n');
  return `<user_question>${question}</user_question>\n\n<sources>\n${blocks}\n</sources>\n\nWrite the summary now.`;
}

async function writeSummary(text: string) {
  await mkdir(dirname(SUMMARY_PATH), { recursive: true });
  await writeFile(SUMMARY_PATH, text, 'utf8');
}

export type IndexOutcome = {
  factsAdded: number;
  claimsExtracted: number;
};

/**
 * Chunk → extract claims → embed each claim's text → factStore.insert.
 * Per-source errors must NOT abort the loop; they're logged and the source skipped.
 *
 * Returns counts so callers (L4 research loop) can report iteration outcomes.
 * Optional `questionId` links extracted claims to the frontier entry that
 * spawned the search.
 */
export async function indexSource(
  source: ScrapeOk,
  question: string,
  questionId?: number,
): Promise<IndexOutcome> {
  let factsAdded = 0;
  let claimsExtracted = 0;
  try {
    // Classify the source's domain on first encounter (cached per-domain in the `sources` table).
    const domain = extractDomain(source.url);
    if (lookupSource(domain) === null) {
      await classifySource(domain, source.text);
    }

    const chunks = await chunkText(source.text, { sourceUrl: source.url });
    for (const chunk of chunks) {
      const claims = await extractor.extract(chunk.text, {
        question,
        sourceUrl: source.url,
        sourceTitle: source.title,
      });
      if (claims.length === 0) continue;
      claimsExtracted += claims.length;

      const embeddings = await embedder.embed(claims.map((c) => c.text));
      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i]!;
        const embedding = embeddings[i]!;
        const insertedId = await factStore.insert({
          claim: claim.text,
          sourceUrl: source.url,
          sourceTitle: source.title || undefined,
          rawExcerpt: chunk.text.slice(0, 800),
          embedding,
          ...(claim.topicTag ? { topicTag: claim.topicTag } : {}),
          confidence: claim.confidence,
          ...(questionId !== undefined ? { questionId } : {}),
        });
        if (insertedId !== null) factsAdded++;
      }
    }
  } catch (err) {
    console.error(`[loop] indexSource failed for ${source.url}: ${(err as Error).message}`);
  }
  return { factsAdded, claimsExtracted };
}

export const searchLoop = {
  async answer(question: string): Promise<string> {
    if (!question.trim()) {
      throw new Error('searchLoop: empty question');
    }

    const results = await searxngClient.query(question);
    const top = results.slice(0, TOP_N);

    const scraped = await Promise.all(top.map((r) => scraper.fetch(r.url)));
    const sources = scraped.filter((s): s is ScrapeOk => s !== null);

    if (sources.length === 0) {
      throw new Error('searchLoop: no usable sources (all top-3 scrapes failed)');
    }

    // L3: chunk, extract, embed, store — in parallel across surviving sources.
    // Awaited before the summary call so the user sees facts already populated when ask returns.
    await Promise.all(sources.map((s) => indexSource(s, question)));

    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(question, sources) },
    ];

    const response = await llm.fast(messages, { maxTokens: 1024 });
    const summary = response.content.trim();

    await writeSummary(summary);

    await events.emit({
      kind: 'summary.write',
      layer: 'L2',
      payload: {
        question: question.slice(0, 80),
        sourceCount: sources.length,
        bytes: Buffer.byteLength(summary, 'utf8'),
      },
    });

    return summary;
  },
};

export const SUMMARY_FILE = SUMMARY_PATH;
