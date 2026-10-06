// Which persisted stores sync to the server, and how. Stores absent from this map
// (or marked `local: true`) stay in this browser's localStorage in every mode.
// collections: field -> key (property name, or function returning a unique string id)
// localFields: per-browser fields kept in localStorage even in server mode
export const STORE_CONFIGS = {
  'csf-assessments-storage': { collections: { assessments: 'id' }, localFields: ['currentAssessmentId'] },
  'csf-controls-storage': { collections: { controls: 'controlId' } },
  'csf-findings-storage': { collections: { findings: 'id' } },
  'csf-artifacts-storage': { collections: { artifacts: 'id' } },
  'csf-comments-storage': { collections: { comments: 'id' } },
  'csf-audit-log': { collections: { entries: 'id' } },
  'csf-evaluations-storage': { collections: { evaluations: 'id' } },
  'csf-frameworks-storage': { collections: { frameworks: 'id' } },
  'csf-requirements-storage': { collections: { requirements: (r) => `${r.frameworkId}::${r.id}` } },
  'csf-metrics-storage': { collections: { metrics: (m) => `${m.catalogSlug}::${m.id}` } },
  'csf-inventory-storage': { collections: { systems: 'id' } },
  // cloudConsent is a per-browser opt-in to cloud AI; the profile itself syncs.
  'csf-org-profile-storage': { localFields: ['cloudConsent'] },
  'csf-users-storage': { collections: { users: 'id' }, localFields: ['currentUserId'] },
  'csf-ui-storage': { local: true },
  'csf-ai-storage': { local: true },
  'csf-data-storage': { local: true }
};
