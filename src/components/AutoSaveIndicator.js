import React from 'react';
import { Cloud, CloudOff, Loader } from 'lucide-react';
import useCSFStore from '../stores/csfStore';
import { useSyncStatus } from '../storage/syncEngine';
import { isServerMode } from '../storage/createStorage';

export function AutoSaveIndicator() {
  // Select each value individually to avoid creating new object references
  const hasUnsavedChanges = useCSFStore((state) => state.hasUnsavedChanges);
  const isSaving = useCSFStore((state) => state.isSaving);
  const lastSaved = useCSFStore((state) => state.lastSaved);

  const formatTime = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const sync = useSyncStatus();
  if (isServerMode()) {
    if (sync.error) return <div className="flex items-center gap-2 text-red-600 text-sm" role="alert"><CloudOff size={14} /><span>{sync.error}</span></div>;
    if (sync.state === 'offline') return <div className="flex items-center gap-2 text-amber-600 text-sm"><CloudOff size={14} /><span>Unsaved changes ({sync.pending}) — retrying</span></div>;
    if (sync.state === 'saving' || sync.pending > 0) return <div className="flex items-center gap-2 text-blue-600 text-sm"><Loader size={14} className="animate-spin" /><span>Saving...</span></div>;
    if (sync.lastSaved) return <div className="flex items-center gap-2 text-green-600 text-sm"><Cloud size={14} /><span>Saved at {formatTime(sync.lastSaved)}</span></div>;
    return null;
  }

  if (isSaving) {
    return (
      <div className="flex items-center gap-2 text-blue-600 text-sm">
        <Loader size={14} className="animate-spin" />
        <span>Saving...</span>
      </div>
    );
  }

  if (hasUnsavedChanges) {
    return (
      <div className="flex items-center gap-2 text-amber-600 text-sm">
        <CloudOff size={14} />
        <span>Unsaved changes</span>
      </div>
    );
  }

  if (lastSaved) {
    return (
      <div className="flex items-center gap-2 text-green-600 text-sm">
        <Cloud size={14} />
        <span>Saved at {formatTime(lastSaved)}</span>
      </div>
    );
  }

  return null;
}

export default AutoSaveIndicator;
