import React, { useEffect, useState } from 'react';
import useAuthStore from '../storage/authStore';
import { isServerMode } from '../storage/createStorage';
import { whenAllHydrated } from '../storage/rehydrateOnRemote';
import { isWorkspaceEmpty } from '../storage/syncEngine';
import { hasLocalData, IMPORT_DECLINED_KEY, IMPORT_DONE_KEY } from '../storage/importLocalData';
import ImportLocalDataPrompt from './ImportLocalDataPrompt';
import Login from '../pages/Login';

const Centered = ({ children }) => <div className="min-h-screen flex items-center justify-center text-gray-600">{children}</div>;

const localFlag = (key) => { try { return !!localStorage.getItem(key); } catch { return false; } };

export default function AuthGate({ children }) {
  const serverMode = isServerMode();
  const status = useAuthStore((s) => s.status);
  const init = useAuthStore((s) => s.init);
  const [hydrated, setHydrated] = useState(false);
  const [importNeeded, setImportNeeded] = useState(false);

  useEffect(() => { if (serverMode && status === 'unknown') init(); }, [serverMode, status, init]);
  useEffect(() => {
    if (!serverMode) return undefined;
    if (status !== 'authenticated') { setHydrated(false); setImportNeeded(false); return undefined; }
    let cancelled = false;
    whenAllHydrated().then(() => {
      if (cancelled) return;
      // Decide before children mount: their seed effects would otherwise fill the workspace first.
      setImportNeeded(isWorkspaceEmpty() && hasLocalData() && !localFlag(IMPORT_DONE_KEY) && !localFlag(IMPORT_DECLINED_KEY));
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [serverMode, status]);

  if (!serverMode) return children;
  if (status === 'unknown') return <Centered>Loading…</Centered>;
  if (status === 'needsSetup') return <Login mode="setup" />;
  if (status === 'anonymous') return <Login mode="login" />;
  if (!hydrated) return <Centered>Loading workspace…</Centered>;
  if (importNeeded) return <ImportLocalDataPrompt onResolved={() => setImportNeeded(false)} />;
  return children;
}
