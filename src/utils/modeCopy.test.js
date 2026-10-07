import {
  firstVisitStorageNote, backupReminderCopy, orgProfileStorageNote, packDataNote,
  orgProfileSavedToast, orgProfileClearConfirm, quotaToastText, metricsCatalogueNote
} from './modeCopy';

const withMode = (mode, fn) => {
  const prev = process.env.REACT_APP_SERVER_MODE;
  if (mode) process.env.REACT_APP_SERVER_MODE = 'true'; else delete process.env.REACT_APP_SERVER_MODE;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.REACT_APP_SERVER_MODE; else process.env.REACT_APP_SERVER_MODE = prev;
  }
};

describe('modeCopy', () => {
  test('local mode keeps the browser-storage wording', () => {
    withMode(false, () => {
      expect(firstVisitStorageNote()).toMatch(/local storage/);
      expect(backupReminderCopy().title).toMatch(/Back Up Your Data/);
      expect(orgProfileStorageNote()).toBe('Stored only in this browser.');
      expect(packDataNote()).toMatch(/stays on this machine/);
      expect(orgProfileSavedToast()).toMatch(/only in this browser/);
      expect(orgProfileClearConfirm()).toMatch(/from this browser/);
      expect(quotaToastText()).toMatch(/NOT being saved/);
      expect(metricsCatalogueNote()).toBe('stays on this machine');
    });
  });

  test('server mode says data is on the server and visible to every account', () => {
    withMode(true, () => {
      expect(firstVisitStorageNote()).toMatch(/server/);
      expect(backupReminderCopy().body).toMatch(/administrator/);
      expect(orgProfileStorageNote()).toMatch(/server and visible to every account/);
      expect(packDataNote()).toMatch(/server and is visible to every account/);
      expect(orgProfileSavedToast()).toMatch(/server/);
      expect(orgProfileClearConfirm()).toMatch(/for everyone/);
      expect(quotaToastText()).toMatch(/server/);
      expect(metricsCatalogueNote()).toMatch(/saved to your organization.s server/);
    });
  });
});
