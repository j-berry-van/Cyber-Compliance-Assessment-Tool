import React, { useEffect, useState } from 'react';
import useAuthStore from '../storage/authStore';
import { isServerMode } from '../storage/createStorage';
import { onRemoteChange } from '../storage/syncEngine';
import { getAssessmentActivity, formatRelativeTime } from '../storage/activity';

export default function AssessmentActivity({ assessmentId }) {
  const serverMode = isServerMode();
  const directory = useAuthStore((s) => s.directory);
  const [, bump] = useState(0);
  useEffect(() => (serverMode ? onRemoteChange(() => bump((n) => n + 1)) : undefined), [serverMode]);
  if (!serverMode) return null;
  const a = getAssessmentActivity(assessmentId, directory);
  if (a.lastEditor === null) return null;
  return (
    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="assessment-activity">
      <div>Last edited by {a.lastEditor} · {formatRelativeTime(a.lastEditedAt)}</div>
      {a.recentEditors.length > 0 && <div>Active in the last 24h: {a.recentEditors.join(', ')}</div>}
    </div>
  );
}
