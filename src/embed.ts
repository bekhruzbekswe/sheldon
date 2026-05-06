/**
 * In-process sentence embeddings via @xenova/transformers running
 * Xenova/all-MiniLM-L6-v2 (384 dims, L2-normalized).
 *
 * Lazy-loads the pipeline on first use; reuses across calls.
 * Also exposes a tokenize() helper for the chunker.
 */

import { events } from './events.ts';

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIM = 384;
const MAX_BATCH = 32;

type FeatureExtractor = (
  texts: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

type Tokenizer = (text: string) => { input_ids: { data: BigInt64Array | number[] | Int32Array } };

let pipelinePromise: Promise<FeatureExtractor> | null = null;
let tokenizerPromise: Promise<Tokenizer> | null = null;

async function getPipeline(): Promise<FeatureExtractor> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return (await pipeline('feature-extraction', MODEL_NAME)) as unknown as FeatureExtractor;
    })();
  }
  return pipelinePromise;
}

async function getTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const { AutoTokenizer } = await import('@xenova/transformers');
      const tok = await AutoTokenizer.from_pretrained(MODEL_NAME);
      return ((text: string) => tok(text)) as unknown as Tokenizer;
    })();
  }
  return tokenizerPromise;
}

function unpackEmbeddings(out: { data: Float32Array; dims: number[] }, batchSize: number): Float32Array[] {
  // out.dims = [batchSize, EMBED_DIM]; data is contiguous Float32Array of length batchSize*EMBED_DIM.
  const result: Float32Array[] = [];
  for (let i = 0; i < batchSize; i++) {
    const slice = new Float32Array(EMBED_DIM);
    for (let j = 0; j < EMBED_DIM; j++) {
      slice[j] = out.data[i * EMBED_DIM + j]!;
    }
    result.push(slice);
  }
  return result;
}

export const embedder = {
  /**
   * Embed an array of strings. Returns one Float32Array(384) per input,
   * L2-normalized so cosine similarity reduces to dot product.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = await getPipeline();
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const startedAt = performance.now();
      const result = await pipe(batch, { pooling: 'mean', normalize: true });
      const durationMs = Math.round(performance.now() - startedAt);
      const embeddings = unpackEmbeddings(result, batch.length);
      out.push(...embeddings);
      await events.emit({
        kind: 'embed.batch',
        layer: 'L3',
        durationMs,
        payload: { count: batch.length },
      });
    }

    return out;
  },

  /**
   * Token-id sequence for a string, matching the embedder's tokenizer.
   * Used by the chunker so chunk boundaries align with embedding boundaries.
   */
  async tokenize(text: string): Promise<number[]> {
    const tok = await getTokenizer();
    const enc = tok(text);
    const data = enc.input_ids.data;
    if (data instanceof BigInt64Array) {
      return Array.from(data, (n) => Number(n));
    }
    return Array.from(data as Int32Array | number[], (n) => Number(n));
  },

  EMBED_DIM,
};
