import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

/** Server-side API call that forwards the user's session cookie. 401 sends the user to /login. */
export async function api<T>(path: string): Promise<T> {
  const jar = await cookies();
  const res = await fetch(`${API_URL}/api${path}`, { headers: { cookie: jar.toString() }, cache: 'no-store' });
  if (res.status === 401) redirect('/login');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface Me { user: { id: string; email: string; name: string }; orgs: Array<{ id: string; name: string; slug: string; plan: string; role: string }> }

/** Resolves the active organization from the `cg_org` cookie, falling back to the user's first org. */
export async function session() {
  const me = await api<Me>('/auth/me');
  const jar = await cookies();
  const wanted = jar.get('cg_org')?.value;
  const org = me.orgs.find((o) => o.id === wanted) ?? me.orgs[0];
  if (!org) redirect('/login');
  return { ...me, org };
}
