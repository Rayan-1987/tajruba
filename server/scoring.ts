// PREMs: satisfaction scoring on collected Likert/NPS answers.
// PROMs: clinical-outcome instrument scoring (sum-based, with severity bands and MCID).

export interface QuestionScore {
  questionId: string;
  n: number;
  mean: number | null;
  topBoxPercent: number | null;
}

export type SampleConfidenceTier = 'insufficient' | 'directional' | 'reliable' | 'public_reporting';

export interface DomainScore {
  domainId: string;
  n: number;
  mean: number | null;
  topBoxPercent: number | null;
  /** Benchmark expressed as a Top-Box percentage (HCAHPS convention), not a 1-5 mean. */
  benchmarkTopBoxPercent: number | null;
  /** topBoxPercent - benchmarkTopBoxPercent, in percentage points. */
  diffPercentPoints: number | null;
  confidenceTier: SampleConfidenceTier;
  /** @deprecated kept for backward compatibility with the n<30 badge; prefer confidenceTier. */
  smallSample: boolean;
}

// Sample-size confidence tiers, matching HCAHPS/CAHPS practice: n<30 has no statistical
// footing even for a directional read; 30-99 is directional only; 100-299 is reliable for
// internal comparison; 300+ (over 4 rolling quarters) is CMS's threshold for public reporting.
export const SMALL_SAMPLE_THRESHOLD = 30;
export const RELIABLE_SAMPLE_THRESHOLD = 100;
export const PUBLIC_REPORTING_SAMPLE_THRESHOLD = 300;
const LIKERT_TOP_BOX_VALUE = 5;

export function sampleConfidenceTier(n: number): SampleConfidenceTier {
  if (n < SMALL_SAMPLE_THRESHOLD) return 'insufficient';
  if (n < RELIABLE_SAMPLE_THRESHOLD) return 'directional';
  if (n < PUBLIC_REPORTING_SAMPLE_THRESHOLD) return 'reliable';
  return 'public_reporting';
}

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
 * Domain score = mean + top-box percentage over all raw answer values belonging to questions
 * in the domain (flattened, not a mean-of-means), so questions with more responses aren't
 * under-weighted. Primary reported metric is topBoxPercent (HCAHPS convention: % of
 * respondents giving the maximum Likert rating), not the raw mean.
 */
export function scoreDomain(domainId: string, allValues: number[], benchmarkTopBoxPercent: number | null): DomainScore {
  const clean = allValues.filter((v) => Number.isFinite(v));
  const n = clean.length;
  const confidenceTier = sampleConfidenceTier(n);
  if (n === 0) {
    return {
      domainId,
      n: 0,
      mean: null,
      topBoxPercent: null,
      benchmarkTopBoxPercent,
      diffPercentPoints: null,
      confidenceTier,
      smallSample: true
    };
  }
  const mean = round2(clean.reduce((sum, v) => sum + v, 0) / n);
  const topBoxCount = clean.filter((v) => v >= LIKERT_TOP_BOX_VALUE).length;
  const topBoxPercent = round2((topBoxCount / n) * 100);
  const diffPercentPoints = benchmarkTopBoxPercent != null ? round2(topBoxPercent - benchmarkTopBoxPercent) : null;
  return {
    domainId,
    n,
    mean,
    topBoxPercent,
    benchmarkTopBoxPercent,
    diffPercentPoints,
    confidenceTier,
    smallSample: n < SMALL_SAMPLE_THRESHOLD
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface RatingDistribution {
  veryGoodPercent: number;
  goodPercent: number;
  fairPercent: number;
  poorPercent: number;
  veryPoorPercent: number;
}

/** Buckets raw 1-5 Likert values into Very Good/Good/Fair/Poor/Very Poor percentages. */
export function scoreDistribution(values: number[]): RatingDistribution | null {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return null;
  const pct = (target: number) => round2((clean.filter((v) => v === target).length / n) * 100);
  return {
    veryGoodPercent: pct(5),
    goodPercent: pct(4),
    fairPercent: pct(3),
    poorPercent: pct(2),
    veryPoorPercent: pct(1)
  };
}

/** Pearson correlation coefficient over paired (questionValue, overallValue) observations. */
export function pearsonCorrelation(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / n;
  let num = 0;
  let denomX = 0;
  let denomY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return null;
  return round2(num / Math.sqrt(denomX * denomY));
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
