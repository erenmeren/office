export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}: ${JSON.stringify(body)}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // only set a JSON content type when there is a body: Fastify rejects empty JSON bodies
  const headers = init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers;
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
    throw new ApiError(res.status, body);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export const del = (path: string) => api<undefined>(path, { method: 'DELETE' });
