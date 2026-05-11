/**
 * Research contract drafting + per-run cached lookups (task embedding,
 * out-of-scope embeddings) consulted by the L3 relevance gate.
 */

import { llm, type Message } from './llm.ts';
import { embedder } from './embed.ts';
import { events } from './events.ts';
import { getDb } from './db.ts';

export type ResearchContract = {
  core_question: string;
  sub_questions: string[];
  good_answer_contains: string[];
  out_of_scope: string[];
};

const SYSTEM_PROMPT = `You translate a user's research task into a structured research contract that will guide an autonomous research agent.

OUTPUT FIELDS
- core_question: a one-sentence sharpening of the user's task.
- sub_questions: 3-5 specific angles a careful analyst would investigate. Each must be searchable on the open web.
- good_answer_contains: 3-7 specific things a satisfying answer would contain — mechanisms, named players, quantitative signals, or decisions the user could make.
- out_of_scope: 3-5 explicit exclusions. Each MUST be a CONCRETE short phrase (≤8 words), specific enough to embed usefully as a rejection signal.

OUT-OF-SCOPE RULES
- Each item names a topic that is *semantically adjacent but irrelevant* to the actual question. Generic vague phrases like "irrelevant content" or "off-topic" are FORBIDDEN.
- Pick exclusions from realistic confusable adjacencies. For a research task on "best Italian restaurants in NYC" you might exclude "Italian language learning resources" or "Italian olive oil supply chain" — close in vocabulary, irrelevant to the actual question.

OUTPUT
Return JSON: {"core_question":"...","sub_questions":["..."],"good_answer_contains":["..."],"out_of_scope":["..."]}.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'contract',
    schema: {
      type: 'object',
      properties: {
        core_question: { type: 'string' },
        sub_questions: { type: 'array', items: { type: 'string' } },
        good_answer_contains: { type: 'array', items: { type: 'string' } },
        out_of_scope: { type: 'array', items: { type: 'string' } },
      },
      required: ['core_question', 'sub_questions', 'good_answer_contains', 'out_of_scope'],
    },
  },
} as const;

function tryParseContract(content: string): ResearchContract | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.core_question !== 'string') return null;
  const filterStrings = (arr: unknown): string[] =>
    Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as string[]).map((s) => s.trim()).filter(Boolean) : [];
  return {
    core_question: obj.core_question.trim(),
    sub_questions: filterStrings(obj.sub_questions),
    good_answer_contains: filterStrings(obj.good_answer_contains),
    out_of_scope: filterStrings(obj.out_of_scope),
  };
}

function emptyContract(task: string): ResearchContract {
  return { core_question: task, sub_questions: [], good_answer_contains: [], out_of_scope: [] };
}

export async function draftContract(task: string): Promise<ResearchContract> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `<research_task>${task}</research_task>\n\nProduce the contract JSON now.` },
  ];

  const startedAt = performance.now();
  let contract: ResearchContract | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.fast(messages, { responseFormat: RESPONSE_FORMAT, maxTokens: 1024 });
      contract = tryParseContract(res.content);
      if (contract) break;
      lastError = `malformed JSON: ${res.content.slice(0, 120)}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);

  if (!contract) {
    await events.emit({
      kind: 'contract.drafted',
      layer: 'L5',
      durationMs,
      payload: {
        subQuestionCount: 0,
        goodAnswerCount: 0,
        outOfScopeCount: 0,
        error: lastError ?? 'unknown contract drafting failure',
      },
    });
    return emptyContract(task);
  }

  await events.emit({
    kind: 'contract.drafted',
    layer: 'L5',
    durationMs,
    payload: {
      subQuestionCount: contract.sub_questions.length,
      goodAnswerCount: contract.good_answer_contains.length,
      outOfScopeCount: contract.out_of_scope.length,
    },
  });

  return contract;
}

// Per-run caches keyed on run_state.started_at — a fresh run auto-invalidates.

let contractCache: { startedAt: number; contract: ResearchContract | null } | null = null;
let taskEmbCache: { startedAt: number; embedding: Float32Array | null } | null = null;
let oosEmbCache: { startedAt: number; embeddings: Float32Array[] } | null = null;

type RunStateRow = {
  started_at: number;
  contract_json: string | null;
  task_embedding: Buffer | Uint8Array | null;
};

function readRunStateRow(): RunStateRow | null {
  return (
    (getDb()
      .query('SELECT started_at, contract_json, task_embedding FROM run_state WHERE id = 1')
      .get() as RunStateRow | null) ?? null
  );
}

function bufToFloatArr(buf: Buffer | Uint8Array): Float32Array {
  const out = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function getContract(): ResearchContract | null {
  const row = readRunStateRow();
  if (!row) return null;
  if (contractCache && contractCache.startedAt === row.started_at) return contractCache.contract;
  let parsed: ResearchContract | null = null;
  if (row.contract_json) {
    try {
      const obj = JSON.parse(row.contract_json) as Partial<ResearchContract>;
      if (typeof obj.core_question === 'string' && Array.isArray(obj.out_of_scope)) {
        parsed = {
          core_question: obj.core_question,
          sub_questions: Array.isArray(obj.sub_questions) ? obj.sub_questions : [],
          good_answer_contains: Array.isArray(obj.good_answer_contains) ? obj.good_answer_contains : [],
          out_of_scope: obj.out_of_scope,
        };
      }
    } catch {
      parsed = null;
    }
  }
  contractCache = { startedAt: row.started_at, contract: parsed };
  return parsed;
}

export function getTaskEmbedding(): Float32Array | null {
  const row = readRunStateRow();
  if (!row) return null;
  if (taskEmbCache && taskEmbCache.startedAt === row.started_at) return taskEmbCache.embedding;
  const emb = row.task_embedding ? bufToFloatArr(row.task_embedding) : null;
  taskEmbCache = { startedAt: row.started_at, embedding: emb };
  return emb;
}

export async function getOutOfScopeEmbeddings(): Promise<Float32Array[]> {
  const row = readRunStateRow();
  if (!row) return [];
  if (oosEmbCache && oosEmbCache.startedAt === row.started_at) return oosEmbCache.embeddings;
  const contract = getContract();
  const items = contract?.out_of_scope ?? [];
  const embeddings = items.length > 0 ? await embedder.embed(items) : [];
  oosEmbCache = { startedAt: row.started_at, embeddings };
  return embeddings;
}

/** Test/util: clear in-process caches. Not used at runtime. */
export function _resetContractCaches(): void {
  contractCache = null;
  taskEmbCache = null;
  oosEmbCache = null;
}

// ─── S3: phase-boundary contract revision ──────────────────────────────────

const REVISE_SYSTEM_PROMPT = `You revise the out_of_scope list of an active research contract based on what the run has learned at a phase boundary.

INPUT
- The current contract (especially core_question and current out_of_scope).
- A sample of facts the relevance gate dropped (showing what was rejected and why).
- A sample of borderline claims that were inserted but score near the gate threshold (showing adjacencies that snuck in).

OUTPUT FIELD
- out_of_scope: 3-5 concrete short phrases (≤8 words each), specific enough to embed usefully as rejection signals.

REVISION RULES
- KEEP an existing out_of_scope item unless gathered evidence has proven it irrelevant (i.e., legitimate adjacent content was being rejected by it). When you remove an item, you are saying "this exclusion was a mistake — those facts are actually on-topic."
- ADD a new out_of_scope item ONLY when adjacent content consistently slipped through the gate and turned out to be off-topic. Don't add items based on guesses.
- Do NOT introduce vague phrases like "irrelevant content", "off-topic material". Concrete adjacencies only.
- It is OK to return the input list unchanged when nothing has obviously changed.

OUTPUT
Return JSON: {"out_of_scope": ["...", "..."]}.`;

const REVISE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'revised_out_of_scope',
    schema: {
      type: 'object',
      properties: {
        out_of_scope: { type: 'array', items: { type: 'string' } },
      },
      required: ['out_of_scope'],
    },
  },
} as const;

export type DroppedFactSample = {
  claim: string;
  score: number;
  taskSimilarity: number;
  maxOosSimilarity: number;
};

export type BorderlineFactSample = {
  claim: string;
  score: number;
};

function tryParseRevisedOos(content: string): string[] | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = (parsed as { out_of_scope?: unknown }).out_of_scope;
  if (!Array.isArray(arr)) return null;
  return (arr.filter((x) => typeof x === 'string') as string[])
    .map((s) => s.trim())
    .filter(Boolean);
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

export async function reviseContract(
  phaseTransition: string,
  currentContract: ResearchContract,
  droppedSamples: DroppedFactSample[],
  borderlineSamples: BorderlineFactSample[],
): Promise<ResearchContract> {
  const startedAt = performance.now();

  const droppedBlock = droppedSamples
    .slice(0, 10)
    .map(
      (d, i) =>
        `(${i + 1}) [score=${d.score.toFixed(3)} task=${d.taskSimilarity.toFixed(2)} oos=${d.maxOosSimilarity.toFixed(2)}] ${trunc(d.claim, 200)}`,
    )
    .join('\n');
  const borderlineBlock = borderlineSamples
    .slice(0, 10)
    .map((b, i) => `(${i + 1}) [score=${b.score.toFixed(3)}] ${trunc(b.claim, 200)}`)
    .join('\n');

  const userMessage = [
    `<current_contract>\n${JSON.stringify(currentContract, null, 2)}\n</current_contract>`,
    `<dropped_samples>\n${droppedBlock || '(none)'}\n</dropped_samples>`,
    `<borderline_samples>\n${borderlineBlock || '(none)'}\n</borderline_samples>`,
    `Revise the out_of_scope list now. Return JSON.`,
  ].join('\n\n');

  const messages: Message[] = [
    { role: 'system', content: REVISE_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  let revisedOos: string[] | null = null;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.fast(messages, { responseFormat: REVISE_RESPONSE_FORMAT, maxTokens: 512 });
      revisedOos = tryParseRevisedOos(res.content);
      if (revisedOos) break;
      lastError = `malformed JSON: ${res.content.slice(0, 120)}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const oosBefore = currentContract.out_of_scope;

  if (!revisedOos) {
    await events.emit({
      kind: 'contract.revised',
      layer: 'L5',
      durationMs,
      payload: {
        phaseTransition,
        oosBefore,
        oosAfter: oosBefore,
        removed: [],
        added: [],
        error: lastError ?? 'unknown contract revision failure',
      },
    });
    return currentContract;
  }

  const beforeSet = new Set(oosBefore);
  const afterSet = new Set(revisedOos);
  const removed = oosBefore.filter((s) => !afterSet.has(s));
  const added = revisedOos.filter((s) => !beforeSet.has(s));

  const updatedContract: ResearchContract = {
    ...currentContract,
    out_of_scope: revisedOos,
  };

  // Persist back to run_state.contract_json and invalidate caches.
  getDb()
    .prepare('UPDATE run_state SET contract_json = ? WHERE id = 1')
    .run(JSON.stringify(updatedContract));
  contractCache = null;
  oosEmbCache = null;

  await events.emit({
    kind: 'contract.revised',
    layer: 'L5',
    durationMs,
    payload: {
      phaseTransition,
      oosBefore,
      oosAfter: revisedOos,
      removed,
      added,
    },
  });

  return updatedContract;
}
