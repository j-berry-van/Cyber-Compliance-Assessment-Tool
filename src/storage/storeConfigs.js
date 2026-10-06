// Which persisted stores sync to the server, and how. Stores absent from this map
// (or marked `local: true`) stay in this browser's localStorage in every mode.
// collections: field -> key (property name, or function returning a unique string id)
// localFields: per-browser fields kept in localStorage even in server mode
export const STORE_CONFIGS = {
  'csf-comments-storage': { collections: { comments: 'id' } }
};
