/**
 * Token-aware text chunker. Splits text into windows of <= maxTokens tokens
 * with ~overlapTokens overlap between consecutive chunks.
 *
 * Strategy: paragraph-first; if a paragraph exceeds maxTokens, fall back to
 * sentence boundaries; if a sentence exceeds maxTokens, hard-cut on token
 * boundary as last resort. Token counts use the embedder's tokenizer so they
 * align with the embedding model's 512-token window.
 */

import { embedder } from './embed.ts';
import { events } from './events.ts';

export type Chunk = {
  text: string;
  tokenCount: number;
};

export type ChunkOptions = {
  maxTokens?: number;
  overlapTokens?: number;
  sourceUrl?: string;
};

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP = 80;

/** Split into paragraphs. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Split a paragraph into sentences (heuristic, not perfect). */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Hard-cut a single overly-long sentence on token boundaries. */
async function hardCut(sentence: string, maxTokens: number): Promise<string[]> {
  // Coarse approximation: split on whitespace into runs, pack runs by token count.
  const words = sentence.split(/(\s+)/); // keep separators
  const out: string[] = [];
  let cur = '';
  let curTokens = 0;
  for (const w of words) {
    const wTokens = (await embedder.tokenize(w)).length;
    if (curTokens + wTokens > maxTokens && cur) {
      out.push(cur);
      cur = w;
      curTokens = wTokens;
    } else {
      cur += w;
      curTokens += wTokens;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Pack a list of "atoms" (paragraphs or sentences) into chunks of <= maxTokens.
 * Atoms larger than maxTokens get split with hardCut.
 */
async function pack(atoms: string[], maxTokens: number, overlapTokens: number): Promise<Chunk[]> {
  // Pre-tokenize each atom once.
  const tokenLens = await Promise.all(atoms.map((a) => embedder.tokenize(a).then((t) => t.length)));

  // Expand any oversized atom into a list of smaller atoms.
  const expanded: { text: string; tokens: number }[] = [];
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i]!;
    const len = tokenLens[i]!;
    if (len <= maxTokens) {
      expanded.push({ text: atom, tokens: len });
      continue;
    }
    // Try sentence-level split first.
    const sentences = splitSentences(atom);
    if (sentences.length > 1) {
      const sLens = await Promise.all(sentences.map((s) => embedder.tokenize(s).then((t) => t.length)));
      for (let j = 0; j < sentences.length; j++) {
        const s = sentences[j]!;
        const sl = sLens[j]!;
        if (sl <= maxTokens) {
          expanded.push({ text: s, tokens: sl });
        } else {
          for (const piece of await hardCut(s, maxTokens)) {
            expanded.push({ text: piece, tokens: (await embedder.tokenize(piece)).length });
          }
        }
      }
    } else {
      // Single oversized sentence → hard-cut.
      for (const piece of await hardCut(atom, maxTokens)) {
        expanded.push({ text: piece, tokens: (await embedder.tokenize(piece)).length });
      }
    }
  }

  // Pack expanded atoms into chunks.
  const chunks: Chunk[] = [];
  let buffer: { text: string; tokens: number }[] = [];
  let bufTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({
      text: buffer.map((a) => a.text).join('\n\n'),
      tokenCount: bufTokens,
    });
  };

  for (const atom of expanded) {
    if (bufTokens + atom.tokens > maxTokens && buffer.length > 0) {
      flush();
      // Apply overlap by retaining trailing atoms whose token sum ≤ overlapTokens.
      const tail: { text: string; tokens: number }[] = [];
      let tailTokens = 0;
      for (let i = buffer.length - 1; i >= 0 && tailTokens + buffer[i]!.tokens <= overlapTokens; i--) {
        tail.unshift(buffer[i]!);
        tailTokens += buffer[i]!.tokens;
      }
      buffer = tail;
      bufTokens = tailTokens;
    }
    buffer.push(atom);
    bufTokens += atom.tokens;
  }
  flush();
  return chunks;
}

export async function chunkText(text: string, opts: ChunkOptions = {}): Promise<Chunk[]> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP;

  const inputChars = text.length;
  const totalTokens = (await embedder.tokenize(text)).length;

  if (totalTokens <= maxTokens) {
    const chunks = [{ text: text.trim(), tokenCount: totalTokens }];
    await events.emit({
      kind: 'chunk.split',
      layer: 'L3',
      payload: {
        ...(opts.sourceUrl ? { url: opts.sourceUrl } : {}),
        inputChars,
        chunkCount: 1,
        totalTokens,
      },
    });
    return chunks;
  }

  const paragraphs = splitParagraphs(text);
  const chunks = await pack(paragraphs, maxTokens, overlapTokens);

  await events.emit({
    kind: 'chunk.split',
    layer: 'L3',
    payload: {
      ...(opts.sourceUrl ? { url: opts.sourceUrl } : {}),
      inputChars,
      chunkCount: chunks.length,
      totalTokens,
    },
  });

  return chunks;
}
