/** Base URL of the API gateway. Empty means same origin (the Vite proxy in development). */
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const TOKEN_KEY = 'parcel.token';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = 'ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Listener = (token: string | null) => void;

/** The API issues one JWT per login; it lives in localStorage so reloads keep the session. */
export const session = {
  listeners: new Set<Listener>(),
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string | null) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    this.listeners.forEach((l) => l(token));
  },
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  },
};

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = session.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}/api${path}${toQueryString(options.query)}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  // An expired or revoked token ends the session everywhere in the app.
  if (res.status === 401 && token) session.set(null);
  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body?.error ?? {};
    throw new ApiError(
      res.status,
      error.message ?? `Request failed with status ${res.status}`,
      error.code,
      error.details,
    );
  }
  return body as T;
}

function toQueryString(query: RequestOptions['query']) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_ERROR' && Array.isArray(error.details)) {
      const first = error.details[0] as { path?: string; message?: string } | undefined;
      if (first?.message) return first.path ? `${first.path}: ${first.message}` : first.message;
    }
    return error.message;
  }
  if (error instanceof TypeError) return 'Cannot reach the server. Is the API running?';
  return error instanceof Error ? error.message : 'Something went wrong';
}
