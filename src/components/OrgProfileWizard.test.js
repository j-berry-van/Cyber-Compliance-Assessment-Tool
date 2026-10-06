import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import OrgProfileWizard from './OrgProfileWizard';

// The original local-mode text, collapsed to single spaces as the browser renders it.
const LOCAL_NOTE =
  "This profile — especially crown jewels and tooling — is sensitive. It stays in this browser's local storage, " +
  'is never included in share exports (tailored procedure text is swapped back to the community version), ' +
  'and rides complete backups only. Password-protect backups that carry it.';

const findNote = () => {
  for (let i = 0; i < 6; i += 1) {
    const el = screen.queryByText((_, node) => node.tagName === 'DIV' && /This profile — especially/.test(node.textContent) && node.className.includes('amber'));
    if (el) return el.textContent.replace(/\s+/g, ' ').trim();
    const skip = screen.queryByTitle('Skip this question');
    if (!skip) break;
    fireEvent.click(skip);
  }
  return null;
};

describe('OrgProfileWizard sensitivity note', () => {
  const prev = process.env.REACT_APP_SERVER_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.REACT_APP_SERVER_MODE; else process.env.REACT_APP_SERVER_MODE = prev;
  });

  test('local mode text is exactly the original', () => {
    delete process.env.REACT_APP_SERVER_MODE;
    render(<OrgProfileWizard onClose={() => {}} />);
    expect(findNote()).toBe(LOCAL_NOTE);
  });

  test('server mode text differs and says the profile is on the server', () => {
    process.env.REACT_APP_SERVER_MODE = 'true';
    render(<OrgProfileWizard onClose={() => {}} />);
    const text = findNote();
    expect(text).not.toBe(LOCAL_NOTE);
    expect(text).toMatch(/saved on your organization’s server and is visible to every account/);
    expect(text).not.toMatch(/local storage/);
    expect(text).toMatch(/never included in share exports/);
  });
});
