/**
 * localStorage wrapper that surfaces quota failures instead of letting
 * zustand persist swallow them. Full-scope assessments with attached
 * community procedures store meaningful text volume; if the browser quota
 * is ever hit, the user must know their latest changes are NOT saved.
 */
import toast from 'react-hot-toast';
import { quotaToastText } from './modeCopy';

let quotaWarningShown = false;

export const quotaSafeLocalStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      console.error(`Persist failed for "${key}" (browser storage quota?):`, error);
      if (!quotaWarningShown) {
        quotaWarningShown = true;
        toast.error(quotaToastText(), { duration: 10000 });
      }
    }
  },
  removeItem: (key) => window.localStorage.removeItem(key)
};

// Test hook: lets the quota-warning latch reset between test cases.
export const __resetQuotaWarningForTests = () => {
  quotaWarningShown = false;
};
