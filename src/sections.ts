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
- Your job: write a 200-500 word, well-organized section that defends a clear claim about the section's theme in service of the original task.

OPENING
- Open with a SINGLE THESIS SENTENCE stating the section's claim — what is true about this theme that the user should take away. Not framing fluff.
- Forbidden openings: "This section explores…", "In recent years…", "Outsourcing companies face many challenges…", and any other generic preamble.

BODY
- Rank your supporting points by importance — the most load-bearing claim first, weakest last.
- If two facts contradict, surface the disagreement explicitly and cite both sides.
- If a claim is supported by fewer than 3 distinct facts or only one source, HEDGE explicitly ("Evidence is thin, but…", "One source argues…", "Only one analyst reports…"). Do NOT assert hedged claims with full confidence.
- If a claim is only weakly supported and you cannot frame it usefully even when hedged, OMIT it entirely. Do not paraphrase weak evidence.

CITATIONS
- Cite EVERY factual claim with a "[N]" matching the localId of the supporting fact. Multiple citations like "[1][2]" are fine.
- Only cite numbers that actually appear in the input. Never invent a citation.
- Do NOT introduce facts not present in the input.

CLOSING
- The section ends on the body's final point. There is NO closing transitional sentence and NO meta-summary.
- The first word of any closing paragraph MUST NOT be "Furthermore", "Consequently", or "Ultimately".

STYLE
- Clear, journalistic prose. Short paragraphs. Occasional bullet lists when they actually improve scannability.
- Do NOT include a heading or title — the stitcher adds the H2 separately.
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

const BANNED_CLOSER_REPLACEMENTS = ['As such,', 'In sum,', 'That is,'] as const;
let bannedCloserCounter = 0;

/**
 * Deterministic post-processor: when the LAST paragraph's first word is one
 * of the banned closer-words ("Furthermore" / "Consequently" / "Ultimately"),
 * regex-rewrite that opener to a neutral connector. The model treats the
 * prompt rule as soft; this is the hard backstop. Mid-body uses are allowed.
 */
function removeBannedClosers(body: string): string {
  const paragraphs = body.split(/\n\n+/);
  if (paragraphs.length === 0) return body;
  const lastIdx = paragraphs.length - 1;
  const last = paragraphs[lastIdx]!;
  const m = last.match(/^(Furthermore|Consequently|Ultimately)([,]?\s+)/);
  if (!m) return body;
  const replacement = BANNED_CLOSER_REPLACEMENTS[bannedCloserCounter % BANNED_CLOSER_REPLACEMENTS.length]!;
  bannedCloserCounter++;
  paragraphs[lastIdx] = `${replacement} ${last.slice(m[0]!.length)}`;
  return paragraphs.join('\n\n');
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
  const cleanedBody = removeBannedClosers(filteredBody);
  const used = Array.from(extractCitations(cleanedBody)).filter((n) => validIds.has(n)).sort((a, b) => a - b);

  await events.emit({
    kind: 'section.written',
    layer: 'L6',
    durationMs: Math.round(performance.now() - startedAt),
    payload: {
      label: input.label,
      wordCount: wordCount(cleanedBody),
      citationCount: used.length,
      factCount: input.facts.length,
    },
  });

  return {
    label: input.label,
    body: cleanedBody,
    factIds: [],
    usedLocalIds: used,
  };
}

// ─── S2 thesis-driven path ──────────────────────────────────────────────────

const SECTION_FROM_CLAIM_SYSTEM_PROMPT = `You are writing one section of a research report. The section DEFENDS A SPECIFIC CLAIM using the ranked evidence provided.

INPUT
- The user's original research task.
- The section's headline (becomes the H2 separately; do NOT repeat it).
- The CLAIM the section must defend (one sentence).
- A triangulation summary: counts of corroborating and contradicting evidence found via independent searches, plus a "contested" boolean.
- A numbered list of supporting facts, pre-ranked by importance — index 1 is the most load-bearing, the last index is the weakest.

OPENING
- Open with a SINGLE THESIS SENTENCE that asserts the CLAIM. Not framing fluff. Not "this section explores...".

BODY
- Rank the supporting points by importance — the prose ordering should follow the input fact order (fact 1 first, etc.).
- If a fact in the input does NOT actually support the claim, OMIT it — do not paraphrase weak evidence.

TRIANGULATION DIRECTIVES
- corroborations >= 2 AND contested === false: assert the claim with normal confidence. No hedging in the opening.
- corroborations < 2 OR fewer than 3 input facts: HEDGE explicitly ("Evidence is thin, but…", "One source argues…", "Only one analyst reports…"). Do not assert thin claims with full confidence.
- contested === true: explicitly surface the contention ("Sources disagree: X argues …, while Y reports …") and cite both sides if possible.

CITATIONS
- Cite EVERY factual claim with [N] matching the input fact's localId. Multiple citations like [1][2] are fine.
- Only cite numbers that actually appear in the input. Never invent a citation.
- Do NOT introduce facts not present in the input.

CLOSING
- The section ends on the body's final point. There is NO closing transitional sentence and NO meta-summary.
- The first word of any closing paragraph MUST NOT be "Furthermore", "Consequently", or "Ultimately".

STYLE
- Clear, journalistic prose. Short paragraphs. Occasional bullet lists when they actually improve scannability.
- Do NOT include a heading or title — the stitcher adds the H2 separately.
- Do NOT mention "the section", "the cluster", or "this report" in the body.

OUTPUT
Plain Markdown body only. No leading "# heading", no "**Section: ...**", just the prose with [N] citations inline.`;

export type SectionFromClaimInput = {
  claim: string;
  headline: string;
  rankedFacts: SectionFact[]; // already sorted; localId in 1..N order
  triangulation: {
    corroborations: number;
    contradictions: number;
    contested: boolean;
  };
};

function buildSectionFromClaimUserMessage(
  input: SectionFromClaimInput,
  ctx: SectionContext,
  feedback?: string,
): string {
  const facts = input.rankedFacts
    .map(
      (f) =>
        `<fact id=${f.localId} url=${JSON.stringify(f.sourceUrl)} title=${JSON.stringify(f.sourceTitle ?? '')}>\n${f.claim}\n</fact>`,
    )
    .join('\n');
  const tri = input.triangulation;
  const parts = [
    `<original_task>${ctx.originalTask}</original_task>`,
    `<headline>${input.headline}</headline>`,
    `<claim>${input.claim}</claim>`,
    `<triangulation>corroborations=${tri.corroborations} contradictions=${tri.contradictions} contested=${tri.contested}</triangulation>`,
    `<facts>\n${facts}\n</facts>`,
  ];
  if (feedback) {
    parts.push(`<editor_feedback>This section was rejected on first pass. Specific issue: ${feedback}\nRevise the body to address it. Keep facts and citations from the input list only.</editor_feedback>`);
  }
  parts.push(
    `Write the section body now. Cite every claim with [N] matching the fact ids above. Local citation space is 1..${input.rankedFacts.length}.`,
  );
  return parts.join('\n\n');
}

export async function writeSectionFromClaim(
  input: SectionFromClaimInput,
  ctx: SectionContext,
  feedback?: string,
): Promise<Section> {
  const startedAt = performance.now();
  const messages: Message[] = [
    { role: 'system', content: SECTION_FROM_CLAIM_SYSTEM_PROMPT },
    { role: 'user', content: buildSectionFromClaimUserMessage(input, ctx, feedback) },
  ];

  let body = '';
  let lastErr: string | null = null;
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
        label: input.headline,
        error: lastErr ?? 'unknown failure',
        factCount: input.rankedFacts.length,
      },
    });
    return {
      label: input.headline,
      body: '',
      factIds: [],
      usedLocalIds: [],
    };
  }

  const validIds = new Set(input.rankedFacts.map((f) => f.localId));
  const filteredBody = filterCitations(body, validIds);
  const cleanedBody = removeBannedClosers(filteredBody);
  const used = Array.from(extractCitations(cleanedBody)).filter((n) => validIds.has(n)).sort((a, b) => a - b);

  await events.emit({
    kind: 'section.written',
    layer: 'L6',
    durationMs: Math.round(performance.now() - startedAt),
    payload: {
      label: input.headline,
      wordCount: wordCount(cleanedBody),
      citationCount: used.length,
      factCount: input.rankedFacts.length,
    },
  });

  return {
    label: input.headline,
    body: cleanedBody,
    factIds: [],
    usedLocalIds: used,
  };
}

// ─── Intro / outro: thesis-aware path ───────────────────────────────────────

const INTRO_THESIS_SYSTEM_PROMPT = `You are writing the introduction (1-2 short paragraphs) for a research report whose body defends an explicit thesis with numbered claims.

INPUT
- The user's original research task.
- The thesis sentences (3-5 sentences that, read together, are the report's actual claim).
- The headlines of the claim-sections in order.
- A few summary stats.

RULES
- State the thesis directly. The intro should read like the opening of a real research argument, not a description of the report's structure.
- Reference the claim headlines naturally if helpful, but DO NOT paraphrase them as a list. ("This report explores X, Y, Z" is FORBIDDEN.)
- DO NOT cite anything (no [N]).
- DO NOT include a heading or title.
- 80-150 words total.

OUTPUT
Plain Markdown prose only.`;

const OUTRO_THESIS_SYSTEM_PROMPT = `You are writing the conclusion (1 short paragraph) for a research report.

INPUT
- The user's original research task.
- The thesis sentences.
- The claim headlines and per-claim metadata. Headlines marked "[CONTESTED]" are the only ones flagged as contested.

RULES
- Synthesize what the report concluded. Do NOT introduce new facts.
- ONLY claim headlines explicitly marked "[CONTESTED]" in the input may be described as contested, divided, disputed, or open questions. Do NOT invent contention. If NO headline is marked [CONTESTED], do NOT use the words "contested", "disputed", "divided", or "remains open" anywhere in the conclusion.
- DO NOT cite anything.
- DO NOT include a heading or title.
- 60-120 words.

OUTPUT
Plain Markdown prose only.`;

export type IntroThesisContext = {
  thesisSentences: string[];
  claimHeadlines: string[];
};

export type OutroThesisContext = {
  thesisSentences: string[];
  claimHeadlines: string[];
  claimMetadata: Array<{ headline: string; contested: boolean }>;
};

export async function writeIntro(
  task: string,
  sectionLabels: string[],
  runStats: RunStats,
  thesis?: IntroThesisContext,
): Promise<string> {
  const useThesis = thesis !== undefined;
  const systemPrompt = useThesis ? INTRO_THESIS_SYSTEM_PROMPT : INTRO_SYSTEM_PROMPT;
  const userParts: string[] = [`<original_task>${task}</original_task>`];
  if (useThesis) {
    userParts.push(
      `<thesis_sentences>\n${thesis.thesisSentences.map((s) => `- ${s}`).join('\n')}\n</thesis_sentences>`,
    );
    userParts.push(`<claim_headlines>${thesis.claimHeadlines.join(' · ')}</claim_headlines>`);
  } else {
    userParts.push(`<section_labels>${sectionLabels.join(', ')}</section_labels>`);
  }
  userParts.push(
    `<stats>iterations=${runStats.iterations} facts=${runStats.factCount} elapsed_minutes=${(runStats.elapsedMs / 60000).toFixed(1)}</stats>`,
  );
  userParts.push(`Write the intro now (80-150 words).`);

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userParts.join('\n\n') },
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
  thesis?: OutroThesisContext,
): Promise<string> {
  const useThesis = thesis !== undefined;
  const systemPrompt = useThesis ? OUTRO_THESIS_SYSTEM_PROMPT : OUTRO_SYSTEM_PROMPT;
  const userParts: string[] = [`<original_task>${task}</original_task>`];
  if (useThesis) {
    userParts.push(
      `<thesis_sentences>\n${thesis.thesisSentences.map((s) => `- ${s}`).join('\n')}\n</thesis_sentences>`,
    );
    const metaLine = thesis.claimMetadata
      .map((m) => `${m.headline}${m.contested ? ' [CONTESTED]' : ''}`)
      .join(' · ');
    userParts.push(`<claim_headlines>${metaLine}</claim_headlines>`);
  } else {
    userParts.push(`<section_labels>${sectionLabels.join(', ')}</section_labels>`);
  }
  userParts.push(
    `<stats>iterations=${runStats.iterations} facts=${runStats.factCount} elapsed_minutes=${(runStats.elapsedMs / 60000).toFixed(1)}</stats>`,
  );
  userParts.push(`Write the conclusion now (60-120 words).`);

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userParts.join('\n\n') },
  ];
  try {
    const res = await llm.fast(messages, { maxTokens: 600 });
    return res.content.trim();
  } catch {
    return '';
  }
}
