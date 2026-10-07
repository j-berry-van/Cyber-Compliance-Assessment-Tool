import { STORE_CONFIGS } from './storeConfigs';
import { toRecords } from './diff';

const ALL_PERSIST_NAMES = [
  'csf-assessments-storage', 'csf-controls-storage', 'csf-findings-storage', 'csf-artifacts-storage',
  'csf-comments-storage', 'csf-audit-log', 'csf-evaluations-storage', 'csf-frameworks-storage',
  'csf-requirements-storage', 'csf-metrics-storage', 'csf-inventory-storage', 'csf-org-profile-storage',
  'csf-users-storage', 'csf-ui-storage', 'csf-ai-storage', 'csf-data-storage'
];

test('every persisted store has an explicit sync decision', () => {
  ALL_PERSIST_NAMES.forEach((n) => expect(STORE_CONFIGS).toHaveProperty([n]));
});

test('per-browser stores are marked local', () => {
  ['csf-ui-storage', 'csf-ai-storage', 'csf-data-storage'].forEach((n) => expect(STORE_CONFIGS[n].local).toBe(true));
});

test('cloud AI consent stays per-browser while the org profile syncs', () => {
  expect(STORE_CONFIGS['csf-org-profile-storage'].local).toBeFalsy();
  expect(STORE_CONFIGS['csf-org-profile-storage'].localFields).toEqual(['cloudConsent']);
});

// Default (seed) state of every synced collection must carry unique keys, or syncing would drop data.
const loaders = {
  'csf-assessments-storage': () => require('../stores/assessmentsStore').default,
  'csf-controls-storage': () => require('../stores/controlsStore').default,
  'csf-findings-storage': () => require('../stores/findingsStore').default,
  'csf-artifacts-storage': () => require('../stores/artifactStore').default,
  'csf-comments-storage': () => require('../stores/commentsStore').default,
  'csf-audit-log': () => require('../stores/auditLogStore').default,
  'csf-evaluations-storage': () => require('../stores/evaluationsStore').default,
  'csf-frameworks-storage': () => require('../stores/frameworksStore').default,
  'csf-requirements-storage': () => require('../stores/requirementsStore').default,
  'csf-metrics-storage': () => require('../stores/metricsStore').default,
  'csf-inventory-storage': () => require('../stores/inventoryStore').default,
  'csf-users-storage': () => require('../stores/userStore').default
};

Object.entries(loaders).forEach(([name, load]) => {
  test(`${name}: default state items all have unique keys`, () => {
    const store = load();
    const options = store.persist.getOptions();
    const partial = options.partialize ? options.partialize(store.getState()) : store.getState();
    const { problems } = toRecords(name, STORE_CONFIGS[name], { state: partial, version: options.version ?? 0 });
    expect(problems).toEqual([]);
  });
});

describe('metrics sync key', () => {
  const cfg = STORE_CONFIGS['csf-metrics-storage'];
  const run = (metrics) => toRecords('csf-metrics-storage', cfg, { state: { metrics }, version: 1 });

  test('same id in two catalogues is two distinct records', () => {
    const { records, problems } = run([{ id: 'M1', catalogSlug: 'a' }, { id: 'M1', catalogSlug: 'b' }]);
    expect(problems).toEqual([]);
    expect(Object.values(records).filter((r) => r.id.includes('::')).map((r) => r.id).sort()).toEqual(['a::M1', 'b::M1']);
  });

  test('same slug and id twice is a problem', () => {
    const { problems } = run([{ id: 'M1', catalogSlug: 'a' }, { id: 'M1', catalogSlug: 'a' }]);
    expect(problems).toHaveLength(1);
  });
});
