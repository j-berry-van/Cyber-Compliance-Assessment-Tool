import { getEntries } from './syncEngine';

const ASSESSMENTS = 'csf-assessments-storage.assessments';
const LINKED = [
  'csf-controls-storage.controls',
  'csf-findings-storage.findings',
  'csf-evaluations-storage.evaluations',
  'csf-artifacts-storage.artifacts'
];
const DAY = 24 * 3600 * 1000;

// Evaluation ids are `EVAL-${assessmentId}-${controlId}-${quarter}`; the trailing hyphen keeps
// an assessment whose id merely starts with the same characters from matching.
const evalBelongs = (evalId, assessmentId) => typeof evalId === 'string' && evalId.startsWith(`EVAL-${assessmentId}-`);

/** Encodes how each synced collection links to an assessment (see the stores' own lookups). */
export function belongsToAssessment(collection, data, assessmentId) {
  if (!data || !assessmentId) return false;
  switch (collection) {
    case 'csf-controls-storage.controls':
      return data.assessmentId === assessmentId;
    case 'csf-findings-storage.findings':
      return data.assessmentId === assessmentId || (!data.assessmentId && evalBelongs(data.evaluationId, assessmentId));
    case 'csf-evaluations-storage.evaluations':
      return data.assessmentId === assessmentId || evalBelongs(data.id, assessmentId);
    case 'csf-artifacts-storage.artifacts':
      return data.assessmentId === assessmentId ||
        (Array.isArray(data.linkedEvaluationIds) && data.linkedEvaluationIds.some((e) => evalBelongs(e, assessmentId)));
    default:
      return false;
  }
}

export function getAssessmentActivity(assessmentId, directory) {
  const touched = [];
  getEntries(ASSESSMENTS).forEach((e) => { if (e.id === assessmentId) touched.push(e); });
  LINKED.forEach((c) => getEntries(c).forEach((e) => { if (belongsToAssessment(c, e.data, assessmentId)) touched.push(e); }));
  const dated = touched.filter((e) => e.updatedAt && e.updatedBy != null)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  if (!dated.length) return { lastEditor: null, lastEditedAt: null, recentEditors: [] };
  const name = (id) => directory.get(id)?.displayName || 'Unknown user';
  const recent = [];
  dated.forEach((e) => {
    if (Date.now() - new Date(e.updatedAt) > DAY) return;
    const n = name(e.updatedBy);
    if (!recent.includes(n)) recent.push(n);
  });
  return { lastEditor: name(dated[0].updatedBy), lastEditedAt: dated[0].updatedAt, recentEditors: recent };
}

export function formatRelativeTime(iso, now = Date.now()) {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (!(mins >= 1)) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
