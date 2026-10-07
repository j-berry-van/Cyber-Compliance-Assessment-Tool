// In server mode the stores hold shared data, so mount-time seed loaders (which replace state
// from a bundled CSV) must only run on an empty workspace. Local mode always loads, as before.
export const shouldLoadSeed = ({ serverMode, existingCount }) => !serverMode || !(existingCount > 0);
