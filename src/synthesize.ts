/**
 * L6 synthesis orchestrator + report stitcher.
 *
 * Default flow (S2 thesis path): draftThesis → triangulate per claim →
 * per-claim fact retrieval → writeSectionFromClaim → brutal-editor pass →
 * stitch.
 *
 * Fallback flow (S1 cluster path): clusterFacts → trimToCentroid → writeSection
 * per cluster → stitch. Triggered when corpus is sparse (<MIN_FACTS_FOR_THESIS)
 * or thesis-drafting fails. Emits `synthesis.fallback` with the reason.
 *
 * The stitcher is a pure function exported as `stitchReport`; the
 * orchestrator wraps it with I/O.
 */

import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { factStore } from './facts.ts';
import { clusterFacts, type Cluster } from './cluster.ts';
import {
  writeSection,
  writeSectionFromClaim,
  writeIntro,
  writeOutro,
  type Section,
  type SectionFact,
  type RunStats,
} from './sections.ts';
import { getRunState } from './phase.ts';
import { events } from './events.ts';
import { getDb } from './db.ts';
import { draftThesis, type ThesisClaim, type ResearchThesis } from './thesize.ts';
import { triangulateClaims, type ClaimTriangulation } from './triangulate.ts';
import { evaluateSection } from './rubric.ts';
import { extractDomain, lookupSource, type SourceClassification } from './classify.ts';

const MAX_FACTS_PER_SECTION = 12;

// S2 orchestrator constants. Tuneable starting values; revise from telemetry.
const MIN_FACTS_FOR_THESIS = 30;
const FACTS_PER_CLAIM = 10;
const SOURCE_WEIGHT_FACTOR = 0.15;
const DOMAIN_REPEAT_PENALTY = 0.05;
const MIN_CLAIM_SUPPORT_THRESHOLD = 0.30;
const MIN_CLAIM_SUPPORT_FRACTION = 0.80;
// Triangulation now uses a per-claim budget enforced inside triangulate.ts (PER_CLAIM_BUDGET_MS).
// The orchestrator no longer computes or passes a global budget — total wall-clock is bounded
// by claims.length * PER_CLAIM_BUDGET_MS, which is ≤7 min for typical thesis sizes.
type BrutalEditMode = 'drop' | 'flag';
const BRUTAL_EDIT_MODE: BrutalEditMode = 'drop';

function sourceWeight(c: SourceClassification | null): number {
  if (!c) return 0.0;
  switch (c.sourceType) {
    case 'academic':
    case 'regulator':
      return 1.0;
    case 'analyst':
    case 'trade-pub':
      return 0.6;
    case 'vc-blog':
    case 'personal-blog':
      return 0.3;
    case 'vendor':
      return 0.1;
    case 'forum':
    case 'other':
    default:
      return 0.0;
  }
}

const INITIALISMS = new Set([
  'ai', 'genai', 'llm', 'gpt', 'ml', 'mlops',
  'bpo', 'rag', 'roi', 'sla', 'api', 'csr',
  'bot', 'bott', 'it', 'kpi', 'crm', 'gdpr', 'ccpa', 'hipaa',
]);

/**
 * Convert a kebab-case cluster slug into a human-readable Title-Case heading,
 * preserving known initialisms (AI, BPO, RAG, …) in all-uppercase.
 */
export function renderHeading(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((tok) => {
      const low = tok.toLowerCase();
      if (INITIALISMS.has(low)) return low.toUpperCase();
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(' ');
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * If a cluster has more than MAX_FACTS_PER_SECTION facts, keep only the ones
 * closest to its centroid. This keeps section prompts small enough that
 * generation finishes inside Cloudflare's edge timeout.
 */
function trimToCentroid(
  factIds: number[],
  centroid: Float32Array,
  factsById: Map<number, { embedding: Float32Array }>,
): number[] {
  if (factIds.length <= MAX_FACTS_PER_SECTION) return factIds;
  const scored = factIds.map((id) => ({
    id,
    sim: dot(factsById.get(id)!.embedding, centroid),
  }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, MAX_FACTS_PER_SECTION).map((s) => s.id);
}

export type SectionInReport = {
  label: string;
  body: string;
  factIds: number[]; // global fact ids (DB ids) in order matching local 1..N positions
};

export type FactById = Map<number, { sourceUrl: string; sourceTitle: string | null }>;

export type StitchInput = {
  task: string;
  intro: string;
  sections: SectionInReport[];
  outro: string;
  factsById: FactById;
  runStats: RunStats;
  generatedAt: number;
  /**
   * `'thesis'` → section.label is a plain-English headline; render verbatim.
   * `'cluster'` → section.label is a kebab-case slug; render through Title-Case.
   * Default `'cluster'` for backward compatibility.
   */
  path?: 'thesis' | 'cluster';
};

export type StitchOutput = {
  markdown: string;
  globalCitationOrder: string[]; // urls in first-appearance order; 1-indexed via array position
};

const REPORTS_DIR = '.sheldon/reports';

/**
 * Pure function: take section bodies with local [N] citations, renumber to
 * globally unique [M] (collapsing duplicate URLs), and render the full report.
 */
export function stitchReport(input: StitchInput): StitchOutput {
  const urlToGlobal = new Map<string, number>();
  const globalOrder: string[] = []; // url at index M-1
  const titleByUrl = new Map<string, string>();

  function globalFor(url: string, title: string | null): number {
    let g = urlToGlobal.get(url);
    if (g === undefined) {
      globalOrder.push(url);
      g = globalOrder.length;
      urlToGlobal.set(url, g);
      titleByUrl.set(url, title ?? '');
    }
    return g;
  }

  function rewriteSection(section: SectionInReport): string {
    return section.body.replace(/\[(\d+)\]/g, (full, n) => {
      const localId = Number(n);
      const factId = section.factIds[localId - 1];
      if (factId === undefined) return ''; // no mapping; drop
      const fact = input.factsById.get(factId);
      if (!fact) return '';
      const g = globalFor(fact.sourceUrl, fact.sourceTitle);
      return `[${g}]`;
    });
  }

  const renderedSections = input.sections.map((s) => ({
    label: s.label,
    body: rewriteSection(s),
  }));

  const date = new Date(input.generatedAt).toISOString().slice(0, 10);
  const elapsedMin = (input.runStats.elapsedMs / 60000).toFixed(1);

  const lines: string[] = [];
  lines.push(`# ${input.task}`);
  lines.push('');
  lines.push(
    `_Generated by Sheldon on ${date}. Researched for ${elapsedMin} min · ${input.runStats.iterations} iterations · ${input.runStats.factCount} facts._`,
  );
  lines.push('');
  if (input.intro.trim()) {
    lines.push(input.intro.trim());
    lines.push('');
  }

  const path: 'thesis' | 'cluster' = input.path ?? 'cluster';
  for (const s of renderedSections) {
    if (!s.body.trim()) continue;
    const heading = path === 'thesis' ? s.label : renderHeading(s.label);
    lines.push(`## ${heading}`);
    lines.push('');
    lines.push(s.body.trim());
    lines.push('');
  }

  if (input.outro.trim()) {
    lines.push('## Conclusion');
    lines.push('');
    lines.push(input.outro.trim());
    lines.push('');
  }

  if (globalOrder.length > 0) {
    lines.push('## Sources');
    lines.push('');
    for (let i = 0; i < globalOrder.length; i++) {
      const url = globalOrder[i]!;
      const title = titleByUrl.get(url) ?? '';
      const display = title ? `${title} — ${url}` : url;
      lines.push(`[${i + 1}] ${display}`);
    }
    lines.push('');
  }

  return { markdown: lines.join('\n'), globalCitationOrder: globalOrder };
}

export type SynthesizeResult = {
  reportPath: string;
  latestPath: string;
  sectionCount: number;
  factCount: number;
  bytes: number;
};

/**
 * Cluster fallback (S1 path). Used when the corpus is sparse or thesis-drafting
 * fails. Produces a sectioned report from k-means clusters.
 */
async function synthesizeViaClusterFallback(
  runState: NonNullable<ReturnType<typeof getRunState>>,
  facts: ReturnType<typeof factStore.listAllWithEmbeddings>,
): Promise<{ sections: SectionInReport[]; runStats: RunStats; intro: string; outro: string; path: 'cluster' }> {
  const clusters = await clusterFacts(
    facts.map((f) => ({
      id: f.id,
      embedding: f.embedding,
      topicTag: f.topicTag,
      claim: f.claim,
    })),
  );

  let workingClusters: Cluster[] = clusters;
  if (workingClusters.length === 0 && facts.length >= 1) {
    workingClusters = [
      {
        label: 'findings',
        factIds: facts.map((f) => f.id),
        centroid: new Float32Array(facts[0]!.embedding),
      },
    ];
  }

  const factById: Map<number, (typeof facts)[number]> = new Map();
  for (const f of facts) factById.set(f.id, f);

  const factsByIdForCentroid = new Map<number, { embedding: Float32Array }>();
  for (const f of facts) factsByIdForCentroid.set(f.id, { embedding: f.embedding });

  const sectionsForReport: SectionInReport[] = [];
  for (const cluster of workingClusters) {
    const trimmedIds = trimToCentroid(cluster.factIds, cluster.centroid, factsByIdForCentroid);
    const factsForSection: SectionFact[] = trimmedIds.map((fid, idx) => {
      const f = factById.get(fid)!;
      return {
        localId: idx + 1,
        claim: f.claim,
        sourceUrl: f.sourceUrl,
        ...(f.sourceTitle ? { sourceTitle: f.sourceTitle } : {}),
        confidence: f.confidence,
      };
    });
    const section = await writeSection(
      { label: cluster.label, facts: factsForSection },
      { originalTask: runState.task },
    );
    if (!section.body.trim()) continue;
    sectionsForReport.push({ label: section.label, body: section.body, factIds: trimmedIds });
  }

  const iterationCount = (
    getDb().query(`SELECT COUNT(*) AS n FROM frontier WHERE status IN ('done','skipped')`).get() as { n: number }
  ).n;
  const runStats: RunStats = {
    iterations: iterationCount,
    factCount: facts.length,
    elapsedMs: Date.now() - runState.startedAt,
  };
  const labels = sectionsForReport.map((s) => s.label);
  const intro = await writeIntro(runState.task, labels, runStats);
  const outro = await writeOutro(runState.task, labels, runStats);
  return { sections: sectionsForReport, runStats, intro, outro, path: 'cluster' };
}

/**
 * Per-claim fact retrieval (S2). For one claim, scores every fact by:
 *   cosine(fact, claim) + α·source_weight − β·domain_repeat
 * Greedy top-K with a per-domain repeat penalty applied as facts are picked.
 */
function pickRankedFactsForClaim(
  claim: ThesisClaim,
  facts: ReturnType<typeof factStore.listAllWithEmbeddings>,
  domainByFactId: Map<number, string>,
  sourceWeightByDomain: Map<string, number>,
): Array<(typeof facts)[number]> {
  // First pass: score every fact without domain penalty (static base score).
  const baseScored = facts.map((f) => {
    const sim = dot(f.embedding, claim.embedding);
    const domain = domainByFactId.get(f.id) ?? '';
    const sw = sourceWeightByDomain.get(domain) ?? 0;
    return { fact: f, base: sim + SOURCE_WEIGHT_FACTOR * sw };
  });
  baseScored.sort((a, b) => b.base - a.base);

  // Second pass: greedy pick, applying domain-repeat penalty as we go.
  const picked: Array<(typeof facts)[number]> = [];
  const domainCount = new Map<string, number>();
  while (picked.length < FACTS_PER_CLAIM) {
    // Find the candidate with the best effective score that isn't yet picked.
    let bestIdx = -1;
    let bestEff = -Infinity;
    for (let i = 0; i < baseScored.length; i++) {
      const cand = baseScored[i]!;
      if (picked.includes(cand.fact)) continue;
      const domain = domainByFactId.get(cand.fact.id) ?? '';
      const reps = domainCount.get(domain) ?? 0;
      const eff = cand.base - DOMAIN_REPEAT_PENALTY * reps;
      if (eff > bestEff) {
        bestEff = eff;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const winner = baseScored[bestIdx]!;
    picked.push(winner.fact);
    const winnerDomain = domainByFactId.get(winner.fact.id) ?? '';
    domainCount.set(winnerDomain, (domainCount.get(winnerDomain) ?? 0) + 1);
  }
  return picked;
}

/**
 * Thesis path (S2 default). draftThesis → triangulate → per-claim retrieval →
 * write per claim → brutal-editor → return assembled sections + intro/outro.
 *
 * Returns null on thesis failure (caller falls back to cluster path).
 */
async function synthesizeViaThesisPath(
  runState: NonNullable<ReturnType<typeof getRunState>>,
  facts: ReturnType<typeof factStore.listAllWithEmbeddings>,
): Promise<
  | {
      sections: SectionInReport[];
      runStats: RunStats;
      intro: string;
      outro: string;
      path: 'thesis';
    }
  | null
> {
  const thesis = await draftThesis(runState.task, runState.contract, facts);
  if (!thesis) return null;

  // Triangulate. Budget is per-claim (enforced inside triangulate.ts), not global.
  const triangulations = await triangulateClaims(thesis.claims);

  // Re-read facts after triangulation (it inserted new ones).
  const factsAfter = factStore.listAllWithEmbeddings();

  // Build per-fact domain + source-weight lookups.
  const domainByFactId = new Map<number, string>();
  const sourceWeightByDomain = new Map<string, number>();
  for (const f of factsAfter) {
    let domain = '';
    try {
      domain = extractDomain(f.sourceUrl);
    } catch {
      domain = '';
    }
    domainByFactId.set(f.id, domain);
    if (!sourceWeightByDomain.has(domain) && domain.length > 0) {
      sourceWeightByDomain.set(domain, sourceWeight(lookupSource(domain)));
    }
  }

  // Draft sections, run brutal-editor pass, collect survivors.
  const sectionsForReport: SectionInReport[] = [];
  for (let i = 0; i < thesis.claims.length; i++) {
    const claim = thesis.claims[i]!;
    const tri = triangulations[i] ?? { corroborations: 0, contradictions: 0, contested: false, queriesRan: 0 };

    const ranked = pickRankedFactsForClaim(claim, factsAfter, domainByFactId, sourceWeightByDomain);
    if (ranked.length === 0) continue;

    // Thin-evidence detection (informational; the writer's own hedging rules cover the actual prose).
    const lowSupport = ranked.filter((f) => dot(f.embedding, claim.embedding) < MIN_CLAIM_SUPPORT_THRESHOLD).length;
    const _thinEvidence = lowSupport / ranked.length >= MIN_CLAIM_SUPPORT_FRACTION;

    const factsForSection: SectionFact[] = ranked.map((f, idx) => ({
      localId: idx + 1,
      claim: f.claim,
      sourceUrl: f.sourceUrl,
      ...(f.sourceTitle ? { sourceTitle: f.sourceTitle } : {}),
      confidence: f.confidence,
    }));
    const factIdsInOrder = ranked.map((f) => f.id);

    let section: Section = await writeSectionFromClaim(
      { claim: claim.claim, headline: claim.headline, rankedFacts: factsForSection, triangulation: tri },
      { originalTask: runState.task },
    );

    // Brutal-editor pass.
    if (section.body.trim()) {
      const rubric = await evaluateSection(section.body, claim);
      const fails =
        (rubric.hasMechanism === false && rubric.hasExample === false) || rubric.defendsHeading === false;
      if (fails) {
        // One revision attempt with the rubric note as feedback.
        const revised = await writeSectionFromClaim(
          { claim: claim.claim, headline: claim.headline, rankedFacts: factsForSection, triangulation: tri },
          { originalTask: runState.task },
          rubric.note,
        );
        if (revised.body.trim()) {
          const rubric2 = await evaluateSection(revised.body, claim);
          const failsAgain =
            (rubric2.hasMechanism === false && rubric2.hasExample === false) || rubric2.defendsHeading === false;
          if (failsAgain) {
            if (BRUTAL_EDIT_MODE === 'drop') {
              await events.emit({
                kind: 'section.dropped',
                layer: 'L6',
                payload: { headline: claim.headline, reason: rubric2.note || 'rubric failed twice' },
              });
              continue;
            }
            // Flag mode: prepend a hedge sentence and keep the section.
            section = {
              ...revised,
              body: `Evidence in this section is uneven: ${rubric2.note || 'see triangulation summary'}.\n\n${revised.body}`,
            };
          } else {
            section = revised;
          }
        } else {
          // Revision returned nothing usable. Fall through with original body.
          section = section.body.trim() ? section : section;
        }
      }
    }

    if (!section.body.trim()) continue;
    sectionsForReport.push({ label: section.label, body: section.body, factIds: factIdsInOrder });
  }

  if (sectionsForReport.length === 0) return null;

  const iterationCount = (
    getDb().query(`SELECT COUNT(*) AS n FROM frontier WHERE status IN ('done','skipped')`).get() as { n: number }
  ).n;
  const runStats: RunStats = {
    iterations: iterationCount,
    factCount: factsAfter.length,
    elapsedMs: Date.now() - runState.startedAt,
  };

  const claimHeadlines = sectionsForReport.map((s) => s.label);
  const claimMetadata = thesis.claims
    .filter((c) => sectionsForReport.some((s) => s.label === c.headline))
    .map((c, i) => {
      const tri = triangulations[thesis.claims.indexOf(c)] ?? {
        corroborations: 0,
        contradictions: 0,
        contested: false,
        queriesRan: 0,
      };
      return { headline: c.headline, contested: tri.contested };
    });

  const intro = await writeIntro(runState.task, claimHeadlines, runStats, {
    thesisSentences: thesis.thesisSentences,
    claimHeadlines,
  });
  const outro = await writeOutro(runState.task, claimHeadlines, runStats, {
    thesisSentences: thesis.thesisSentences,
    claimHeadlines,
    claimMetadata,
  });

  return { sections: sectionsForReport, runStats, intro, outro, path: 'thesis' };
}

export async function synthesize(): Promise<SynthesizeResult | null> {
  const runState = getRunState();
  if (!runState) {
    throw new Error('synthesize: no run_state row — start a run first');
  }

  const facts = factStore.listAllWithEmbeddings();
  if (facts.length === 0) {
    return null;
  }

  let result:
    | { sections: SectionInReport[]; runStats: RunStats; intro: string; outro: string; path: 'thesis' | 'cluster' }
    | null = null;

  // Try the thesis path unless the corpus is too sparse.
  if (facts.length < MIN_FACTS_FOR_THESIS) {
    await events.emit({
      kind: 'synthesis.fallback',
      layer: 'L6',
      payload: { reason: 'sparse_corpus', factCount: facts.length },
    });
    result = await synthesizeViaClusterFallback(runState, facts);
  } else {
    const thesisResult = await synthesizeViaThesisPath(runState, facts);
    if (thesisResult) {
      result = thesisResult;
    } else {
      await events.emit({
        kind: 'synthesis.fallback',
        layer: 'L6',
        payload: { reason: 'thesis_returned_null', factCount: facts.length },
      });
      result = await synthesizeViaClusterFallback(runState, facts);
    }
  }

  if (result.sections.length === 0) {
    return null;
  }

  // Build factsById view for stitcher (use the latest facts snapshot for citation lookups).
  const factsForStitch = factStore.listAllWithEmbeddings();
  const factsByIdForStitch: FactById = new Map();
  for (const f of factsForStitch) {
    factsByIdForStitch.set(f.id, { sourceUrl: f.sourceUrl, sourceTitle: f.sourceTitle });
  }

  const generatedAt = Date.now();
  const { markdown } = stitchReport({
    task: runState.task,
    intro: result.intro,
    sections: result.sections,
    outro: result.outro,
    factsById: factsByIdForStitch,
    runStats: result.runStats,
    generatedAt,
    path: result.path,
  });

  // Write to disk.
  await mkdir(REPORTS_DIR, { recursive: true });
  const runId = String(runState.startedAt);
  let reportPath = join(REPORTS_DIR, `${runId}.md`);
  // If the run-id file already exists (re-synthesizing), suffix with -v2, -v3...
  let v = 2;
  while (await pathExists(reportPath)) {
    reportPath = join(REPORTS_DIR, `${runId}-v${v}.md`);
    v++;
  }
  const latestPath = join(REPORTS_DIR, 'latest.md');
  await writeFile(reportPath, markdown, 'utf8');
  await copyFile(reportPath, latestPath);

  await events.emit({
    kind: 'report.written',
    layer: 'L6',
    payload: {
      path: reportPath,
      sectionCount: result.sections.length,
      factCount: factsForStitch.length,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      path_kind: result.path,
    },
  });

  return {
    reportPath,
    latestPath,
    sectionCount: result.sections.length,
    factCount: factsForStitch.length,
    bytes: Buffer.byteLength(markdown, 'utf8'),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    return await Bun.file(p).exists();
  } catch {
    return false;
  }
}
