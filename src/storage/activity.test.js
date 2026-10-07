import { getAssessmentActivity, belongsToAssessment, formatRelativeTime } from './activity';
import * as engine from './syncEngine';
import { api } from './serverClient';

jest.mock('./serverClient', () => ({ api: jest.fn(), ApiError: class extends Error {}, setUnauthorizedHandler: jest.fn() }));

const directory = new Map([[1, { displayName: 'Ann' }], [2, { displayName: 'Bo' }]]);
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const R = (collection, id, data, updatedBy, h) => ({ collection, id, data, version: 1, updatedBy, updatedAt: hoursAgo(h) });
const FIND = 'csf-findings-storage.findings';
const EVAL = 'csf-evaluations-storage.evaluations';
const ART = 'csf-artifacts-storage.artifacts';
const CTL = 'csf-controls-storage.controls';

const load = async (records) => { engine.reset(); api.mockReset(); api.mockResolvedValueOnce({ cursor: 1, records }); await engine.bootstrap(); };

beforeEach(() => load([
  R('csf-assessments-storage.assessments', 'A1', { id: 'A1' }, 1, 30),
  R(FIND, 'f1', { id: 'f1', assessmentId: 'A1' }, 2, 1),
  R(FIND, 'f2', { id: 'f2', assessmentId: 'OTHER' }, 1, 0.1)
]));

test('reports the last editor across the assessment and its linked records', () => {
  const a = getAssessmentActivity('A1', directory);
  expect(a.lastEditor).toBe('Bo');
  expect(new Date(a.lastEditedAt).getTime()).toBeGreaterThan(Date.now() - 2 * 3600 * 1000);
});

test('recent editors are limited to the last 24 hours and exclude other assessments', () => {
  expect(getAssessmentActivity('A1', directory).recentEditors).toEqual(['Bo']);
});

test('an assessment with no server activity has no editor', () => {
  expect(getAssessmentActivity('NOPE', directory)).toEqual({ lastEditor: null, lastEditedAt: null, recentEditors: [] });
});

test('an editor missing from the directory shows as Unknown user; own unsynced writes (updatedBy null) are ignored', async () => {
  await load([R(FIND, 'f1', { assessmentId: 'A1' }, 99, 1), { ...R(FIND, 'f2', { assessmentId: 'A1' }, null, 0.01), updatedAt: null }]);
  expect(getAssessmentActivity('A1', directory).lastEditor).toBe('Unknown user');
});

test('evaluations, artifacts and findings link by their real fields; collections without links contribute nothing', async () => {
  await load([
    R(EVAL, 'EVAL-A1-GV.OC-01-Q1', { id: 'EVAL-A1-GV.OC-01-Q1' }, 1, 5),
    R(ART, 'art1', { linkedEvaluationIds: ['EVAL-A1-GV.OC-01-Q1'] }, 2, 2),
    R('csf-other.x', 'z', { assessmentId: 'A1' }, 1, 0.01)
  ]);
  const a = getAssessmentActivity('A1', directory);
  expect(a.lastEditor).toBe('Bo');
  expect(a.recentEditors).toEqual(['Bo', 'Ann']);
});

describe('belongsToAssessment', () => {
  test('controls and findings by assessmentId', () => {
    expect(belongsToAssessment(CTL, { assessmentId: 'A1' }, 'A1')).toBe(true);
    expect(belongsToAssessment(CTL, { assessmentId: 'A2' }, 'A1')).toBe(false);
    expect(belongsToAssessment(CTL, {}, 'A1')).toBe(false);
    expect(belongsToAssessment(FIND, { assessmentId: 'A1' }, 'A1')).toBe(true);
  });
  test('findings without assessmentId fall back to evaluationId prefix; a set assessmentId wins', () => {
    expect(belongsToAssessment(FIND, { evaluationId: 'EVAL-A1-C-Q1' }, 'A1')).toBe(true);
    expect(belongsToAssessment(FIND, { assessmentId: 'A2', evaluationId: 'EVAL-A1-C-Q1' }, 'A1')).toBe(false);
  });
  test('evaluations by assessmentId or id prefix', () => {
    expect(belongsToAssessment(EVAL, { assessmentId: 'A1' }, 'A1')).toBe(true);
    expect(belongsToAssessment(EVAL, { id: 'EVAL-A1-C-Q1' }, 'A1')).toBe(true);
    expect(belongsToAssessment(EVAL, { id: 'EVAL-A1-C-Q1', assessmentId: 'A2' }, 'A2')).toBe(true);
  });
  test('the EVAL- prefix cannot match an assessment whose id merely starts the same', () => {
    expect(belongsToAssessment(EVAL, { id: 'EVAL-ASM-10-C-Q1' }, 'ASM-1')).toBe(false);
    expect(belongsToAssessment(FIND, { evaluationId: 'EVAL-ASM-10-C-Q1' }, 'ASM-1')).toBe(false);
    expect(belongsToAssessment(ART, { linkedEvaluationIds: ['EVAL-ASM-10-C-Q1'] }, 'ASM-1')).toBe(false);
    expect(belongsToAssessment(ART, { linkedEvaluationIds: ['EVAL-ASM-1-C-Q1'] }, 'ASM-1')).toBe(true);
  });
  test('artifacts by assessmentId or linked evaluation ids; unknown collection false', () => {
    expect(belongsToAssessment(ART, { assessmentId: 'A1' }, 'A1')).toBe(true);
    expect(belongsToAssessment(ART, {}, 'A1')).toBe(false);
    expect(belongsToAssessment('other', { assessmentId: 'A1' }, 'A1')).toBe(false);
  });
});

test('formatRelativeTime', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  expect(formatRelativeTime('2026-01-10T11:59:40Z', now)).toBe('just now');
  expect(formatRelativeTime('2026-01-10T11:55:00Z', now)).toBe('5 minutes ago');
  expect(formatRelativeTime('2026-01-10T11:00:00Z', now)).toBe('1 hour ago');
  expect(formatRelativeTime('2026-01-08T12:00:00Z', now)).toBe('2 days ago');
});
