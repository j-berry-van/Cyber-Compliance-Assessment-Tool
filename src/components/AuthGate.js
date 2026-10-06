import React, { useEffect, useState } from 'react';
import useAuthStore from '../storage/authStore';
import { isServerMode } from '../storage/createStorage';
import { whenAllHydrated } from '../storage/rehydrateOnRemote';
import Login from '../pages/Login';

const Centered = ({ children }) => <div className="min-h-screen flex items-center justify-center text-gray-600">{children}</div>;

export default function AuthGate({ children }) {
  const serverMode = isServerMode();
  const status = useAuthStore((s) => s.status);
  const init = useAuthStore((s) => s.init);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => { if (serverMode && status === 'unknown') init(); }, [serverMode, status, init]);
  useEffect(() => {
    if (!serverMode) return undefined;
    if (status !== 'authenticated') { setHydrated(false); return undefined; }
    let cancelled = false;
    whenAllHydrated().then(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [serverMode, status]);

  if (!serverMode) return children;
  if (status === 'unknown') return <Centered>Loading…</Centered>;
  if (status === 'needsSetup') return <Login mode="setup" />;
  if (status === 'anonymous') return <Login mode="login" />;
  if (!hydrated) return <Centered>Loading workspace…</Centered>;
  return children;
}
