export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

const base = () => `${process.env.REACT_APP_API_URL || ''}/api`;

export async function api(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, json);
  }
  return json;
}
