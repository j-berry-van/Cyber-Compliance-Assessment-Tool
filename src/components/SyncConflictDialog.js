import React from 'react';
import { useSyncStatus, resolveConflict } from '../storage/syncEngine';

const preview = (v) => {
  if (v == null) return '(deleted)';
  const text = JSON.stringify(v, null, 2);
  if (text === undefined) return '(deleted)';
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

export default function SyncConflictDialog() {
  const conflicts = useSyncStatus((s) => s.conflicts);
  if (!conflicts.length) return null;
  const c = conflicts[0];
  return (
    <div role="dialog" aria-modal="true" aria-label="Someone else changed this" className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow max-w-3xl w-full p-4 space-y-3">
        <h2 className="text-lg font-semibold">Someone else changed this record</h2>
        <p className="text-sm">
          A teammate saved <code>{c.collection.split('.').pop()}</code> “{c.id}” while you were editing it
          ({conflicts.length} conflict{conflicts.length > 1 ? 's' : ''} to review).
        </p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><div className="font-semibold mb-1">Yours</div><pre className="bg-gray-100 dark:bg-gray-900 p-2 overflow-auto max-h-64">{preview(c.mine)}</pre></div>
          <div><div className="font-semibold mb-1">Theirs</div><pre className="bg-gray-100 dark:bg-gray-900 p-2 overflow-auto max-h-64">{preview(c.theirs)}</pre></div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 border rounded" onClick={() => resolveConflict(c.key, 'theirs')}>Take theirs</button>
          <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={() => resolveConflict(c.key, 'mine')}>Keep mine</button>
        </div>
      </div>
    </div>
  );
}
