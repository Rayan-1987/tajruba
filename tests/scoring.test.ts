import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHQ9,
  VAS_PAIN,
  computeInstrumentRaw,
  scoreDomain,
  scoreInstrument,
  scoreNps,
  scoreQuestion
} from '../server/scoring.ts';

test('scoreQuestion computes mean and top-box percentage', () => {
  const result = scoreQuestion('q1', [5, 5, 4, 3, 5]);
  assert.equal(result.n, 5);
  assert.equal(result.mean, 4.4);
  assert.equal(result.topBoxPercent, 60);
});

test('scoreQuestion handles no responses', () => {
  const result = scoreQuestion('q1', []);
  assert.equal(result.n, 0);
  assert.equal(result.mean, null);
  assert.equal(result.topBoxPercent, null);
});

test('scoreNps computes promoters minus detractors', () => {
  const result = scoreNps([10, 9, 9, 6, 3, 8]);
  // promoters (>=9): 3, detractors (<=6): 2, n=6 => (3-2)/6*100 = 16.67
  assert.equal(result.n, 6);
  assert.equal(result.score, 16.67);
});

test('scoreDomain flags small samples under the threshold', () => {
  const small = scoreDomain('d1', [4, 5, 3], 75.0);
  assert.equal(small.smallSample, true);
  assert.equal(small.confidenceTier, 'insufficient');
  const large = scoreDomain(
    'd1',
    Array.from({ length: 31 }, () => 4),
    75.0
  );
  assert.equal(large.smallSample, false);
  assert.equal(large.confidenceTier, 'directional');
  assert.equal(large.topBoxPercent, 0);
  assert.equal(large.diffPercentPoints, -75);
});

test('scoreDomain computes top-box percentage and benchmark diff', () => {
  const result = scoreDomain('d1', [5, 5, 5, 3], 75.0);
  assert.equal(result.mean, 4.5);
  assert.equal(result.topBoxPercent, 75);
  assert.equal(result.diffPercentPoints, 0);
});

test('scoreDomain reports sample confidence tiers matching HCAHPS thresholds', () => {
  assert.equal(scoreDomain('d1', Array.from({ length: 29 }, () => 5), 75).confidenceTier, 'insufficient');
  assert.equal(scoreDomain('d1', Array.from({ length: 99 }, () => 5), 75).confidenceTier, 'directional');
  assert.equal(scoreDomain('d1', Array.from({ length: 299 }, () => 5), 75).confidenceTier, 'reliable');
  assert.equal(scoreDomain('d1', Array.from({ length: 300 }, () => 5), 75).confidenceTier, 'public_reporting');
});

test('computeInstrumentRaw applies reverse scoring', () => {
  const raw = computeInstrumentRaw([
    { code: 'a', value: 2, reverseScored: false, scaleMax: 3 },
    { code: 'b', value: 1, reverseScored: true, scaleMax: 3 }
  ]);
  // 2 + (3 - 1) = 4
  assert.equal(raw, 4);
});

test('scoreInstrument bands PHQ-9 correctly and reports no delta without baseline', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ code: `PHQ9-${i + 1}`, value: 2, reverseScored: false, scaleMax: 3 }));
  const result = scoreInstrument(PHQ9, items, null);
  assert.equal(result.raw, 18);
  assert.equal(result.band, 'moderately_severe');
  assert.equal(result.delta, null);
  assert.equal(result.mcidMet, null);
});

test('scoreInstrument computes MCID for a lower-is-better instrument (VAS pain)', () => {
  const baselineItems = [{ code: 'VAS-1', value: 8, reverseScored: false, scaleMax: 10 }];
  const baseline = scoreInstrument(VAS_PAIN, baselineItems, null);

  const improvedItems = [{ code: 'VAS-1', value: 5, reverseScored: false, scaleMax: 10 }];
  const improved = scoreInstrument(VAS_PAIN, improvedItems, baseline.raw);
  assert.equal(improved.delta, 3);
  assert.equal(improved.mcidMet, true); // MCID threshold is 2

  const barelyImproved = scoreInstrument(VAS_PAIN, [{ code: 'VAS-1', value: 7, reverseScored: false, scaleMax: 10 }], baseline.raw);
  assert.equal(barelyImproved.delta, 1);
  assert.equal(barelyImproved.mcidMet, false);
});
