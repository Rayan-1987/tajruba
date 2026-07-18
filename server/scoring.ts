// PREMs: satisfaction scoring on collected Likert/NPS answers.
// PROMs: clinical-outcome instrument scoring (sum-based, with severity bands and MCID).

export interface QuestionScore {
  questionId: string;
  n: number;
  mean: number | null;
  topBoxPercent: number | null;
}

export interface DomainScore {
  domainId: string;
  n: number;
  mean: number | null;
  benchmark: number | null;
  diff: number | null;
  smallSample: boolean;
}

export const SMALL_SAMPLE_THRESHOLD = 30;
const LIKERT_TOP_BOX_VALUE = 5;

/** Mean + top-box (% answering the maximum Likert value) for one question's raw values. */
export function scoreQuestion(questionId: string, values: number[]): QuestionScore {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return { questionId, n: 0, mean: null, topBoxPercent: null };
  const mean = clean.reduce((sum, v) => sum + v, 0) / n;
  const topBoxCount = clean.filter((v) => v >= LIKERT_TOP_BOX_VALUE).length;
  return { questionId, n, mean: round2(mean), topBoxPercent: round2((topBoxCount / n) * 100) };
}

/** NPS = %promoters(9-10) - %detractors(0-6), on a 0-10 scale. */
export function scoreNps(values: number[]): { n: number; score: number | null } {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return { n: 0, score: null };
  const promoters = clean.filter((v) => v >= 9).length;
  const detractors = clean.filter((v) => v <= 6).length;
  const score = ((promoters - detractors) / n) * 100;
  return { n, score: round2(score) };
}

/** % of respondents who answered "yes" (1) to a gate/yes-no question. */
export function scoreYesNo(values: number[]): { n: number; yesPercent: number | null } {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return { n: 0, yesPercent: null };
  const yesCount = clean.filter((v) => v === 1).length;
  return { n, yesPercent: round2((yesCount / n) * 100) };
}

/**
 * Domain score = mean over all raw answer values belonging to questions in the domain
 * (flattened, not a mean-of-means), so questions with more responses aren't under-weighted.
 */
export function scoreDomain(domainId: string, allValues: number[], benchmark: number | null): DomainScore {
  const clean = allValues.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return { domainId, n: 0, mean: null, benchmark, diff: null, smallSample: true };
  const mean = round2(clean.reduce((sum, v) => sum + v, 0) / n);
  const diff = benchmark != null ? round2(mean - benchmark) : null;
  return { domainId, n, mean, benchmark, diff, smallSample: n < SMALL_SAMPLE_THRESHOLD };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// PROMs instrument scoring
// ---------------------------------------------------------------------------

export type BandFn = (raw: number) => string;

export interface InstrumentDefinition {
  code: string;
  minItems: number;
  maxItems: number;
  higherIsBetter: boolean;
  mcidThreshold: number;
  band?: BandFn;
}

export const PHQ9: InstrumentDefinition = {
  code: 'PHQ9',
  minItems: 9,
  maxItems: 9,
  higherIsBetter: false,
  mcidThreshold: 5,
  band: (raw) => {
    if (raw <= 4) return 'minimal';
    if (raw <= 9) return 'mild';
    if (raw <= 14) return 'moderate';
    if (raw <= 19) return 'moderately_severe';
    return 'severe';
  }
};

export const GAD7: InstrumentDefinition = {
  code: 'GAD7',
  minItems: 7,
  maxItems: 7,
  higherIsBetter: false,
  mcidThreshold: 4,
  band: (raw) => {
    if (raw <= 4) return 'minimal';
    if (raw <= 9) return 'mild';
    if (raw <= 14) return 'moderate';
    return 'severe';
  }
};

export const VAS_PAIN: InstrumentDefinition = {
  code: 'VAS_PAIN',
  minItems: 1,
  maxItems: 1,
  higherIsBetter: false,
  mcidThreshold: 2
};

export const OXFORD_KNEE: InstrumentDefinition = {
  code: 'OXFORD_KNEE',
  minItems: 12,
  maxItems: 12,
  higherIsBetter: true,
  mcidThreshold: 5,
  band: (raw) => {
    if (raw >= 42) return 'excellent';
    if (raw >= 34) return 'good';
    if (raw >= 27) return 'fair';
    return 'poor';
  }
};

/**
 * Raw sum across all 10 items (after reverse-scoring pain/fatigue/emotional-distress items),
 * NOT the official PROMIS T-score. Official norm-based T-scores require the scoring tables
 * published by HealthMeasures and must be integrated before this is used clinically.
 */
export const PROMIS_GH10: InstrumentDefinition = {
  code: 'PROMIS_GH10',
  minItems: 10,
  maxItems: 10,
  higherIsBetter: true,
  mcidThreshold: 5
};

export const INSTRUMENTS: Record<string, InstrumentDefinition> = {
  PHQ9,
  GAD7,
  VAS_PAIN,
  OXFORD_KNEE,
  PROMIS_GH10
};

export interface InstrumentItemValue {
  code: string;
  value: number;
  reverseScored: boolean;
  scaleMax: number;
}

export interface PromScoreResult {
  raw: number;
  band: string | null;
  baseline: number | null;
  delta: number | null;
  mcidMet: boolean | null;
}

/** Sum of item values, applying reverse-scoring (scaleMax - value) where flagged. */
export function computeInstrumentRaw(items: InstrumentItemValue[]): number {
  return items.reduce((sum, item) => sum + (item.reverseScored ? item.scaleMax - item.value : item.value), 0);
}

/**
 * Scores one instrument administration. `baseline` is the raw score from the patient's
 * first (pre-treatment) timepoint in the same care pathway, if this isn't the baseline itself.
 */
export function scoreInstrument(
  definition: InstrumentDefinition,
  items: InstrumentItemValue[],
  baseline: number | null
): PromScoreResult {
  const raw = computeInstrumentRaw(items);
  const band = definition.band ? definition.band(raw) : null;
  if (baseline == null) {
    return { raw, band, baseline: null, delta: null, mcidMet: null };
  }
  const rawDelta = definition.higherIsBetter ? raw - baseline : baseline - raw;
  const mcidMet = rawDelta >= definition.mcidThreshold;
  return { raw, band, baseline, delta: round2(rawDelta), mcidMet };
}
