/**
 * User-facing wording that depends on where the data lives.
 * Local mode: everything is in this browser. Server mode (REACT_APP_SERVER_MODE=true):
 * assessment data is saved to the organization's own server and shared between accounts.
 * Evaluated at call time so each render/test reads the current mode.
 */
import { isServerMode } from '../storage/createStorage';

export const quotaToastText = () =>
  isServerMode()
    ? 'Browser storage is full — settings kept in this browser (display and AI preferences) could not be saved. ' +
      'Your assessment data is saved on the server and is not affected.'
    : 'Browser storage is full — your latest changes are NOT being saved. ' +
      'Export a backup now (Settings → Data Export), then remove old assessments.';

export const firstVisitStorageNote = () =>
  isServerMode()
    ? 'Your work is saved to your organization’s server and shared with the other accounts. ' +
      'Backups of the server are the administrator’s responsibility.'
    : 'Data lives in your browser\'s local storage — export CSV backups as you work ' +
      '(Settings has reminders).';

export const backupReminderCopy = () =>
  isServerMode()
    ? {
        title: 'Your data is saved on the server',
        body: 'Changes are saved to the server automatically. Backing up the server’s database is ' +
          'the administrator’s responsibility; you can still export a copy of what you can see.'
      }
    : {
        title: 'Time to Back Up Your Data',
        body: 'It\'s been a while since your last export. Protect your assessment work by creating a backup now.'
      };

export const orgProfileStorageNote = () =>
  isServerMode()
    ? 'Saved to your organization’s server and visible to every account. Sending it to a cloud AI ' +
      'provider is still a per-browser choice (the checkbox above).'
    : 'Stored only in this browser.';

export const packDataNote = () =>
  isServerMode()
    ? 'Imported pack data is saved to your organization’s server and is visible to every account; it is still excluded from shareable exports by default.'
    : 'Pack data stays on this machine and is excluded from shareable exports by default.';

export const orgProfileSavedToast = () =>
  isServerMode()
    ? 'Organization profile saved (to the server, visible to every account)'
    : 'Organization profile saved (stored only in this browser)';

export const orgProfileClearConfirm = () =>
  isServerMode()
    ? 'Clear the organization profile for everyone? It is stored on the server and shared by every account. Tailored text already in assessments is not changed.'
    : 'Clear the organization profile from this browser? Tailored text already in assessments is not changed.';

// Tail of the sentence "...a local CSV file that <note>" on the Metrics empty state and Settings card.
export const metricsCatalogueNote = () =>
  isServerMode()
    ? 'is saved to your organization’s server once imported, visible to every account'
    : 'stays on this machine';
