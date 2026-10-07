import React, { useState } from 'react';
import toast from 'react-hot-toast';
import useAuthStore from '../storage/authStore';
import {
  collectLocalRecords, importLocalData, buildLocalBackup, IMPORT_DECLINED_KEY, IMPORT_DONE_KEY
} from '../storage/importLocalData';
import { downloadJSON } from '../utils/dataExport';

const setFlag = (key) => { try { localStorage.setItem(key, '1'); } catch { /* best effort */ } };

// Full-screen blocking step shown by AuthGate before the app mounts (so seed effects cannot fill
// the workspace first). AuthGate decides whether it is needed; `onResolved` lets the app mount.
export default function ImportLocalDataPrompt({ onResolved }) {
  const userId = useAuthStore((s) => s.user)?.id;
  const [busy, setBusy] = useState(false);
  const [backupReady, setBackupReady] = useState(false);
  const [needsReload, setNeedsReload] = useState(null);
  const [problemCount] = useState(() => collectLocalRecords().problems.length);

  const backup = () => {
    try {
      downloadJSON(buildLocalBackup(), `csf_browser_data_backup_${new Date().toISOString().split('T')[0]}.json`);
      setBackupReady(true);
      toast.success('Backup downloaded');
    } catch {
      toast.error('Could not download the backup. You can skip it if you still want to import.');
    }
  };

  const notNow = () => { setFlag(IMPORT_DECLINED_KEY); onResolved(); };

  const doImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await importLocalData({ userId });
      setFlag(IMPORT_DONE_KEY);
      toast.success(`Imported ${res?.imported ?? 0} records`);
      onResolved();
    } catch (err) {
      if (err?.refreshFailed) {
        setFlag(IMPORT_DONE_KEY);
        const n = err.result?.imported ?? 0;
        toast.success(`Imported ${n} records. Reload the page to see them.`);
        setNeedsReload(n);
      } else if (err?.status === 409 && err?.body?.error === 'workspace-not-empty') {
        setFlag(IMPORT_DECLINED_KEY);
        toast.error("This workspace already has data, so your browser's data was not imported. It is still saved in this browser.");
        onResolved();
      } else if (err?.status === 413) {
        toast.error('Your browser data is too large to import in one step (limit 25 MB).');
        setBusy(false);
      } else {
        toast.error('Import failed. Your browser data was not changed.');
        setBusy(false);
      }
    }
  };

  const shell = (children) => (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50 dark:bg-gray-900">
      <div role="region" aria-labelledby="import-local-heading" className="max-w-lg w-full bg-white dark:bg-gray-800 rounded-lg shadow border p-6 space-y-4">
        {children}
      </div>
    </div>
  );

  if (needsReload !== null) {
    return shell(
      <>
        <h2 id="import-local-heading" className="text-lg font-semibold">Imported {needsReload} records</h2>
        <p className="text-sm">Your data is saved on the server, but this page could not refresh itself. Reload the page to see it.</p>
        <div className="flex justify-end">
          <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </>
    );
  }

  return shell(
    <>
      <h2 id="import-local-heading" className="text-lg font-semibold">Import this browser&apos;s data into the server?</h2>
      <p className="text-sm">
        This browser has assessment data saved locally and the shared workspace is empty. You can copy your
        data into the workspace now. Your browser copy is kept either way, and only an empty workspace accepts an import.
      </p>
      <p className="text-sm">
        The backup is a raw copy of this browser&apos;s data (not restorable through Settings → Import).
      </p>
      {problemCount > 0 && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          {problemCount} item(s) in this browser&apos;s data cannot be synced (missing or duplicate id) and will stay only in this browser.
        </p>
      )}
      <div className="flex flex-wrap gap-2 justify-end">
        <button className="px-3 py-1 border rounded" disabled={busy} onClick={backup}>Download a backup first</button>
        {!backupReady && (
          <button className="px-3 py-1 border rounded" disabled={busy} onClick={() => setBackupReady(true)}>Skip backup</button>
        )}
        <button className="px-3 py-1 border rounded" disabled={busy} onClick={notNow}>Not now</button>
        <button className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-50" disabled={busy || !backupReady} onClick={doImport}>Import into server</button>
      </div>
    </>
  );
}
