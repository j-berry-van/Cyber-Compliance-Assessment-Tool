import { registerStoreForRehydrate } from './rehydrateOnRemote';
import useAssessmentsStore from '../stores/assessmentsStore';
import useControlsStore from '../stores/controlsStore';
import useFindingsStore from '../stores/findingsStore';
import useArtifactStore from '../stores/artifactStore';
import useCommentsStore from '../stores/commentsStore';
import useAuditLogStore from '../stores/auditLogStore';
import useEvaluationsStore from '../stores/evaluationsStore';
import useFrameworksStore from '../stores/frameworksStore';
import useRequirementsStore from '../stores/requirementsStore';
import useMetricsStore from '../stores/metricsStore';
import useInventoryStore from '../stores/inventoryStore';
import useOrgProfileStore from '../stores/orgProfileStore';
import useUserStore from '../stores/userStore';

[
  useAssessmentsStore, useControlsStore, useFindingsStore, useArtifactStore, useCommentsStore,
  useAuditLogStore, useEvaluationsStore, useFrameworksStore, useRequirementsStore, useMetricsStore,
  useInventoryStore, useOrgProfileStore, useUserStore
].forEach(registerStoreForRehydrate);
