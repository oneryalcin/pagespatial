import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMergedOutput } from '../scripts/evaluation/score_gpu_merged_output.mjs';

const manifest = [{
  page: 'doc#1', png: 'page.png', sha256: 'b'.repeat(64), pngWidth: 200, pngHeight: 200
}];

function baseRecord() {
  return {
    objectId: 'doc',
    pageNumber: 1,
    source: { pageCount: 1 },
    pageSpatial: {
      documentId: 'doc', revisionId: 'r', documentSha256: 'a'.repeat(64),
      geometry: { width: 200, height: 200 },
      nativeObservations: [{
        id: 'native', pageNumber: 1, text: 'Revenue date 2023-04-04', box: [10, 20, 180, 40],
        mcid: null, structureRole: null, geometryMethod: 'rendered-input-v1'
      }],
      unreadInkRegions: undefined,
      secondOpinion: undefined,
      diagnostics: {
        thresholds: {
          lowOcrConfidence: 0.5, minimumRelationConfidence: 0.7, maximumRelationAmbiguity: 0.25,
          uncorroboratedOcrMinimumCount: 8, uncorroboratedOcrMaximumCoverage: 0.5
        },
        escalationReasons: []
      },
      provenance: { nativeAdapter: 'native', renderer: 'renderer' }
    }
  };
}

function arm(id, text, box = [10, 20, 180, 40]) {
  return armLines(id, [{ text, score: 0.99, box }]);
}

function armLines(id, lines) {
  return {
    arm: { name: id },
    repetitions: [1, 2].map((repeat) => ({
      repeat,
      pages: [{ page: 'doc#1', lines }]
    }))
  };
}

const adjudications = {
  schemaVersion: 'pagespatial-gpu-merged-output-adjudications-v1',
  values: [
    {
      page: 'doc#1', side: 'candidate', token: '2022-04-04', occurrence: 0,
      observationBox: [10, 20, 180, 40], verdict: 'incorrect', correctToken: '2023-04-04',
      adjudicationImage: 'evidence.png',
      inputSha256: 'b'.repeat(64), adjudicationImageSha256: 'c'.repeat(64),
      documentSha256: 'a'.repeat(64)
    },
    {
      page: 'doc#1', side: 'control', token: '2023-04-04', occurrence: 0,
      observationBox: [10, 20, 180, 40], verdict: 'missing',
      adjudicationImage: 'evidence.png',
      inputSha256: 'b'.repeat(64), adjudicationImageSha256: 'c'.repeat(64),
      documentSha256: 'a'.repeat(64)
    }
  ]
};

const adjudicationEvidenceHashes = new Map([['evidence.png', 'c'.repeat(64)]]);

test('passes when an incorrect candidate value is caught by native conflict and escalated', () => {
  const result = evaluateMergedOutput({
    control: arm('control', 'Revenue date 2023-04-04'),
    candidate: arm('candidate', 'Revenue date 2022-04-04'),
    baseRecords: new Map([['doc#1', baseRecord()]]),
    manifest,
    adjudications,
    adjudicationEvidenceHashes
  });
  assert.equal(result.verdict.pass, true);
  assert.equal(result.repeatConsistency, true);
  const value = result.repetitions[0].pages[0].candidateOnlyCritical[0];
  assert.equal(value.caughtByNativeConflict, true);
  assert.equal(result.repetitions[0].pages[0].candidate.nonEscalated, false);
});

test('fails when an incorrect candidate value can enter non-escalated output', () => {
  const result = evaluateMergedOutput({
    control: arm('control', 'Revenue date 2023-04-04'),
    candidate: arm('candidate', 'Revenue date 2022-04-04', [10, 100, 180, 120]),
    baseRecords: new Map([['doc#1', baseRecord()]]),
    manifest,
    adjudications: {
      ...adjudications,
      values: [
        { ...adjudications.values[0], observationBox: [10, 100, 180, 120] },
        adjudications.values[1]
      ]
    },
    adjudicationEvidenceHashes
  });
  assert.equal(result.verdict.pass, false);
  assert.equal(result.repetitions[0].verdict.incorrectOrUnresolvedTrustedValues, 1);
  assert.equal(result.repetitions[0].verdict.incorrectValuesNotCaughtByNativeConflict, 1);
});

test('refuses an unadjudicated candidate-only critical value', () => {
  assert.throws(() => evaluateMergedOutput({
    control: arm('control', 'Revenue date 2023-04-04'),
    candidate: arm('candidate', 'Revenue date 2022-04-04', [10, 100, 180, 120]),
    baseRecords: new Map([['doc#1', baseRecord()]]),
    manifest,
    adjudications: { ...adjudications, values: [] },
    adjudicationEvidenceHashes
  }), /Unadjudicated candidate-only critical value on trusted page/u);
});

test('refuses an adjudication whose evidence file does not match its pinned hash', () => {
  assert.throws(() => evaluateMergedOutput({
    control: arm('control', 'Revenue date 2023-04-04'),
    candidate: arm('candidate', 'Revenue date 2022-04-04'),
    baseRecords: new Map([['doc#1', baseRecord()]]),
    manifest,
    adjudications,
    adjudicationEvidenceHashes: new Map([['evidence.png', 'd'.repeat(64)]])
  }), /evidence image hash does not match/u);
});

test('refuses an adjudication verdict outside the closed vocabulary', () => {
  assert.throws(() => evaluateMergedOutput({
    control: arm('control', 'Revenue date 2023-04-04'),
    candidate: arm('candidate', 'Revenue date 2022-04-04'),
    baseRecords: new Map([['doc#1', baseRecord()]]),
    manifest,
    adjudications: {
      ...adjudications,
      values: [{ ...adjudications.values[0], verdict: 'probably-fine' }, adjudications.values[1]]
    },
    adjudicationEvidenceHashes
  }), /unsupported adjudication verdict/u);
});

test('fails when a candidate silently clears a control blocking route', () => {
  const routeAdjudications = {
    ...adjudications,
    values: [
      {
        ...adjudications.values[0],
        token: '2023-04-04',
        verdict: 'correct',
        correctToken: '2023-04-04'
      },
      {
        ...adjudications.values[1],
        token: '2022-04-04'
      }
    ]
  };
  const result = evaluateMergedOutput({
    control: arm('control', 'Revenue date 2022-04-04'),
    candidate: arm('candidate', 'Revenue date 2023-04-04'),
    baseRecords: new Map([['doc#1', baseRecord()]]),
    manifest,
    adjudications: routeAdjudications,
    adjudicationEvidenceHashes
  });
  assert.equal(result.verdict.pass, false);
  assert.deepEqual(result.repetitions[0].verdict.clearedControlBlockingRoutes, ['doc#1']);
});

test('refuses a critical value deleted from native-starved trusted output', () => {
  const record = baseRecord();
  record.pageSpatial.nativeObservations = [];
  assert.throws(() => evaluateMergedOutput({
    control: arm('control', 'Invoice date 2023-04-04'),
    candidate: arm('candidate', 'Invoice date'),
    baseRecords: new Map([['doc#1', record]]),
    manifest,
    adjudications: { ...adjudications, values: [] },
    adjudicationEvidenceHashes
  }), /Unadjudicated control-only critical value on trusted page/u);
});

test('compatible split tails and later duplicate tokens cancel at the matching boxes', () => {
  const values = [{
    ...adjudications.values[0], token: '1|mayor', verdict: 'correct', correctToken: '1|mayor',
    observationBox: [10, 60, 100, 80]
  }];
  const result = evaluateMergedOutput({
    control: armLines('control', [
      { text: 'Version: 1', score: 0.99, box: [10, 20, 100, 40] },
      { text: '1 City Clerk', score: 0.99, box: [10, 100, 100, 120] },
      { text: 'Page 1', score: 0.99, box: [100, 160, 150, 180] }
    ]),
    candidate: armLines('candidate', [
      { text: 'Version: 1', score: 0.99, box: [10, 20, 100, 40] },
      { text: '1 Mayor', score: 0.99, box: [10, 60, 100, 80] },
      { text: '1', score: 0.99, box: [10, 100, 30, 120] },
      { text: 'City Clerk', score: 0.99, box: [35, 100, 100, 120] },
      { text: 'Page 1', score: 0.99, box: [100, 160, 150, 180] }
    ]),
    baseRecords: new Map([['doc#1', baseRecord()]]),
    manifest,
    adjudications: { ...adjudications, values },
    adjudicationEvidenceHashes
  });
  assert.equal(result.verdict.pass, true);
  const page = result.repetitions[0].pages[0];
  assert.deepEqual(page.candidateOnlyCritical.map((entry) => entry.token), ['1|mayor']);
  assert.deepEqual(page.controlOnlyCritical, []);
});
