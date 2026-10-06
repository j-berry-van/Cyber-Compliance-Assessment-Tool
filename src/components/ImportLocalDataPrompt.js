import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { isServerMode } from '../storage/createStorage';
import useAuthStore from '../storage/authStore';
import {
  hasLocalData, importLocalData, buildLocalBackup, IMPORT_DECLINED_KEY, IMPORT_DONE_KEY
} from '../storage/importLocalData';
import { downloadJSON } from '../utils/dataExport';

const flagged = () => {
  try { return !!(localStorage.getItem(IMPORT_DECLINED_KEY) || localStorage.getItem(IMPORT_DONE_KEY)); } catch { return false; }
};
const setFlag = (key) => { try { localStorage.setItem(key, '1'); } catch { /* best effort */ } };

export default function ImportLocalDataPrompt() {
  const userId = useAuthStore((s) => s.user)?.id;
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backupReady, setBackupReady] = useState(false);
  const [show] = useState(() => isServerMode() && !flagged() && hasLocalData());

  if (!show || hidden) return null;

  const backup = () => {
    try {
      downloadJSON(buildLocalBackup(), `csf_browser_data_backup_${new Date().toISOString().split('T')[0]}.json`);
      setBackupReady(true);
      toast.success('Backup downloaded');
    } catch {
      toast.error('Could not download the backup. You can skip it if you still want to import.');
    }
  };

  const notNow = () => { setFlag(IMPORT_DECLINED_KEY); setHidden(true); };

  const doImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await importLocalData({ userId });
      setFlag(IMPORT_DONE_KEY);
      setHidden(true);
      toast.success(`Imported ${res?.imported ?? 0} records`);
    } catch (err) {
      if (err?.status === 409 && err?.body?.error === 'workspace-not-empty') {
        setFlag(IMPORT_DECLINED_KEY);
        setHidden(true);
        toast.error("This workspace already has data, so your browser's data was not imported. It is still saved in this browser.");
      } else {
        toast.error('Import failed. Your browser data was not changed.');
        setBusy(false);
      }
    }
  };

  return (
    <div role="dialog" aria-label="Import this browser's data" className="fixed bottom-4 right-4 z-40 max-w-md bg-white dark:bg-gray-800 rounded-lg shadow-lg border p-4 space-y-3">
      <h2 className="text-base font-semibold">Import this browser&apos;s data into the server?</h2>
      <p className="text-sm">
        This browser has assessment data saved locally. You can copy it into the shared workspace.
        Your browser copy is kept either way. Only an empty workspace accepts an import.
      </p>
      <div className="flex flex-wrap gap-2 justify-end">
        <button className="px-3 py-1 border rounded" disabled={busy} onClick={backup}>Download a backup first</button>
        {!backupReady && (
          <button className="px-3 py-1 border rounded" disabled={busy} onClick={() => setBackupReady(true)}>Skip backup</button>
        )}
        <button className="px-3 py-1 border rounded" disabled={busy} onClick={notNow}>Not now</button>
        <button className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-50" disabled={busy || !backupReady} onClick={doImport}>Import into server</button>
      </div>
    </div>
  );
}
