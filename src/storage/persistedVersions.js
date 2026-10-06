const versions = {};
export const setPersistedVersion = (key, version) => { versions[key] = version; };
export const getPersistedVersion = (key) => (typeof versions[key] === 'number' ? versions[key] : null);
