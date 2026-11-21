'use client';
/** Browser API helper. Same-origin (`/api` is proxied by Next), so the HttpOnly session cookie is sent automatically. */
export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body && !isForm ? { 'content-type': 'application/json' } : undefined, body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
