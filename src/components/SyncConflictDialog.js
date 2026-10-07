import React from 'react';
import { useSyncStatus, resolveConflict } from '../storage/syncEngine';
import { diffPaths } from '../storage/merge';

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
        <div className="text-xs">
          <div className="font-semibold mb-1">Fields that differ</div>
          {c.mine == null || c.theirs == null
            ? <p>{c.mine == null ? 'You deleted this record, but a teammate changed it.' : 'A teammate deleted this record, but you changed it.'}</p>
            : (
              <table className="w-full text-left">
                <thead><tr><th className="pr-2">Field</th><th className="pr-2">Yours</th><th>Theirs</th></tr></thead>
                <tbody>
                  {diffPaths(c.mine, c.theirs).map((d) => (
                    <tr key={d.path} className="align-top">
                      <td className="pr-2 font-mono break-all">{d.path}</td>
                      <td className="pr-2 font-mono break-all">{d.mine}</td>
                      <td className="font-mono break-all">{d.theirs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 border rounded" onClick={() => resolveConflict(c.key, 'theirs')}>Take theirs</button>
          <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={() => resolveConflict(c.key, 'mine')}>Keep mine</button>
        </div>
      </div>
    </div>
  );
}
