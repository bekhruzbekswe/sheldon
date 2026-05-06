/**
 * LLM-driven section / intro / outro writers for L6 synthesis.
 *
 * Sections use llm.deep — synthesis is the rare quality-critical place.
 * Each section receives its cluster's facts numbered 1..N (local citation
 * space). The stitcher renumbers to global citations afterward.
 */

import { llm, type Message } from './llm.ts';
import { events } from './events.ts';

export type SectionFact = {
  localId: number; // 1-indexed within its cluster
  claim: string;
  sourceUrl: string;
  sourceTitle?: string;
  confidence: number | null;
};

export type SectionInput = {
  label: string;
  facts: SectionFact[];
};

export type SectionContext = {
  originalTask: string;
};

export type Section = {
  label: string;
  body: string;
  factIds: number[]; // global fact ids in order matching localId 1..N
  usedLocalIds: number[]; // distinct localIds that survived filtering
};

export type RunStats = {
  iterations: number;
  factCount: number;
  elapsedMs: number;
};

const SECTION_SYSTEM_PROMPT = `You are writing one section of a longer research report.

ROLE
- You will receive the user's original research task, this section's theme label, and a numbered list of factual claims (each tagged with its source).
- Your job: write a 200-500 word, well-organized section that synthesizes these claims to address the section's theme in service of the original task.

RULES
- Cite EVERY factual claim with a "[N]" matching the localId of the supporting fact. Multiple citations like "[1][2]" are fine.
- Only cite numbers that actually appear in the input. Never invent a citation.
- Do NOT introduce facts not present in the input. If you need a transitional sentence that has no specific source, keep it minimal and uncited.
- If two facts contradict, note the disagreement explicitly and cite both.
- Write in clear, journalistic prose. Use short paragraphs and the occasional bullet list when appropriate. Do NOT include a heading or title — the stitcher adds the H2 separately.
- Open with a one-sentence framing of the section's theme. Close with a one-sentence transition or summary.
- Do NOT mention "the section", "the cluster", or "this report" in the body.

OUTPUT
Plain Markdown body only. No leading "# heading", no "**Section: ...**", just the prose with [N] citations inline.`;

const INTRO_SYSTEM_PROMPT = `You are writing the introduction (1-2 short paragraphs) for a research report.

INPUT
- The user's original research task
- The list of section labels in order
- A few summary stats (number of facts gathered, sources, time spent)

RULES
- Frame what the report covers without making any specific factual claim.
- Mention the breadth of the report by name-dropping a few of the section labels naturally.
- DO NOT cite anything. There are no [N] citations in the intro.
- DO NOT include a heading or title.
- 80-150 words total.

OUTPUT
Plain Markdown prose only.`;

const OUTRO_SYSTEM_PROMPT = `You are writing the conclusion (1 short paragraph) for a research report.

INPUT
- The user's original research task
- The list of section labels in order

RULES
- Synthesize what the report covered at a meta level. Do not state new facts.
- DO NOT cite anything.
- DO NOT include a heading or title.
- 60-120 words.

OUTPUT
Plain Markdown prose only.`;

function buildSectionUserMessage(input: SectionInput, ctx: SectionContext): string {
  const facts = input.facts
    .map(
      (f) =>
        `<fact id=${f.localId} url=${JSON.stringify(f.sourceUrl)} title=${JSON.stringify(f.sourceTitle ?? '')}>\n${f.claim}\n</fact>`,
    )
    .join('\n');
  return [
    `<original_task>${ctx.originalTask}</original_task>`,
    `<section_label>${input.label}</section_label>`,
    `<facts>\n${facts}\n</facts>`,
    `Write the section body now. Cite every claim with [N] matching the fact ids above. Local citation space is 1..${input.facts.length}.`,
  ].join('\n\n');
}

function extractCitations(body: string): Set<number> {
  const out = new Set<number>();
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.add(Number(m[1]));
  }
  return out;
}

function filterCitations(body: string, validIds: Set<number>): string {
  return body.replace(/\[(\d+)\]/g, (full, n) => {
    return validIds.has(Number(n)) ? full : '';
  });
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export async function writeSection(
  input: SectionInput,
  ctx: SectionContext,
): Promise<Section> {
  const startedAt = performance.now();
  const messages: Message[] = [
    { role: 'system', content: SECTION_SYSTEM_PROMPT },
    { role: 'user', content: buildSectionUserMessage(input, ctx) },
  ];

  let body = '';
  let lastErr: string | null = null;
  // We use llm.fast (no thinking) for sections. Empirically Qwen3.5-9B in
  // thinking mode burns its entire output budget on reasoning_content for
  // 20-fact prompts and returns zero content. Fast mode produces slightly
  // less polished prose but reliably returns text. A polish pass with deep
  // mode could be added later as its own layer.
  // maxTokens 2500 covers a 200-500 word section with comfortable margin and
  // finishes in ~30-60s — safely inside Cloudflare's 100s edge timeout.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.fast(messages, { maxTokens: 2500 });
      body = res.content.trim();
      if (body.length > 0) break;
      lastErr = 'empty body returned';
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  if (!body) {
    await events.emit({
      kind: 'section.written',
      layer: 'L6',
      durationMs: Math.round(performance.now() - startedAt),
      payload: {
        label: input.label,
        error: lastErr ?? 'unknown failure',
        factCount: input.facts.length,
      },
    });
    return {
      label: input.label,
      body: '',
      factIds: [],
      usedLocalIds: [],
    };
  }

  const validIds = new Set(input.facts.map((f) => f.localId));
  const filteredBody = filterCitations(body, validIds);
  const used = Array.from(extractCitations(filteredBody)).filter((n) => validIds.has(n)).sort((a, b) => a - b);

  await events.emit({
    kind: 'section.written',
    layer: 'L6',
    durationMs: Math.round(performance.now() - startedAt),
    payload: {
      label: input.label,
      wordCount: wordCount(filteredBody),
      citationCount: used.length,
      factCount: input.facts.length,
    },
  });

  return {
    label: input.label,
    body: filteredBody,
    factIds: [],
    usedLocalIds: used,
  };
}

export async function writeIntro(
  task: string,
  sectionLabels: string[],
  runStats: RunStats,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: INTRO_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `<original_task>${task}</original_task>`,
        `<section_labels>${sectionLabels.join(', ')}</section_labels>`,
        `<stats>iterations=${runStats.iterations} facts=${runStats.factCount} elapsed_minutes=${(runStats.elapsedMs / 60000).toFixed(1)}</stats>`,
        `Write the intro now (80-150 words).`,
      ].join('\n\n'),
    },
  ];
  try {
    const res = await llm.fast(messages, { maxTokens: 800 });
    return res.content.trim();
  } catch {
    return `This report addresses the question: ${task}`;
  }
}

export async function writeOutro(
  task: string,
  sectionLabels: string[],
  runStats: RunStats,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: OUTRO_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `<original_task>${task}</original_task>`,
        `<section_labels>${sectionLabels.join(', ')}</section_labels>`,
        `<stats>iterations=${runStats.iterations} facts=${runStats.factCount} elapsed_minutes=${(runStats.elapsedMs / 60000).toFixed(1)}</stats>`,
        `Write the conclusion now (60-120 words).`,
      ].join('\n\n'),
    },
  ];
  try {
    const res = await llm.fast(messages, { maxTokens: 600 });
    return res.content.trim();
  } catch {
    return '';
  }
}
