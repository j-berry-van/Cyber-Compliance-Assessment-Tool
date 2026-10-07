import React, { useEffect, useState } from 'react';
import useAuthStore from '../storage/authStore';
import { isServerMode } from '../storage/createStorage';
import { whenAllHydrated } from '../storage/rehydrateOnRemote';
import { isWorkspaceEmpty, releaseFlush } from '../storage/syncEngine';
import { hasLocalData, IMPORT_DECLINED_KEY, IMPORT_DONE_KEY } from '../storage/importLocalData';
import ImportLocalDataPrompt from './ImportLocalDataPrompt';
import useUserStore from '../stores/userStore';
import Login from '../pages/Login';

const Centered = ({ children }) => <div className="min-h-screen flex items-center justify-center text-gray-600">{children}</div>;

const LAST_ACCOUNT_KEY = 'csf-last-account';
const localValue = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
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
      // Link the account to its participant so comments/audit entries use that identity.
      const account = useAuthStore.getState().user;
      const participantId = account?.participantId;
      const match = participantId != null
        ? useUserStore.getState().users.find((p) => String(p.id) === String(participantId))
        : undefined;
      if (match) {
        useUserStore.getState().setCurrentUser(match.id);
      } else if (account && localValue(LAST_ACCOUNT_KEY) !== String(account.id)) {
        // A different account on this browser must not inherit the previous account's participant.
        useUserStore.getState().setCurrentUser(null);
      }
      if (account) { try { localStorage.setItem(LAST_ACCOUNT_KEY, String(account.id)); } catch { /* best effort */ } }
      // Decide before children mount: their seed effects would otherwise fill the workspace first.
      const needed = isWorkspaceEmpty() && hasLocalData() && !localFlag(IMPORT_DONE_KEY) && !localFlag(IMPORT_DECLINED_KEY);
      if (!needed) releaseFlush();
      setImportNeeded(needed);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [serverMode, status]);

  if (!serverMode) return children;
  if (status === 'unknown') return <Centered>Loading…</Centered>;
  if (status === 'needsSetup') return <Login mode="setup" />;
  if (status === 'anonymous') return <Login mode="login" />;
  if (!hydrated) return <Centered>Loading workspace…</Centered>;
  if (importNeeded) return <ImportLocalDataPrompt onResolved={() => { releaseFlush(); setImportNeeded(false); }} />;
  return children;
}
