export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly details?: any) {
    super(message);
  }
}

export function getToken() {
  try { return localStorage.getItem('evplan.token'); } catch { return null; }
}
export function setToken(t: string | null) {
  try { t ? localStorage.setItem('evplan.token', t) : localStorage.removeItem('evplan.token'); } catch { /* ignore */ }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') { setToken(null); location.href = '/login'; }
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.code, data?.details);
  }
  return data as T;
}
