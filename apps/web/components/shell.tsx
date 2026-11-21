'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import { cn } from '@/lib/utils';

const NAV = [['Dashboard', '/dashboard'], ['Projects', '/projects'], ['Policies', '/policies'], ['Team', '/team'], ['Notifications', '/notifications'], ['Settings', '/settings']] as const;

export function Shell({ user, orgs, activeOrgId, unread, children }: { user: { name: string; email: string }; orgs: Array<{ id: string; name: string; role: string }>; activeOrgId: string; unread: number; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const switchOrg = (id: string) => { document.cookie = `cg_org=${id}; path=/; max-age=31536000; samesite=lax`; router.push('/dashboard'); router.refresh(); };
  const logout = async () => { await call('POST', '/auth/logout'); router.replace('/login'); router.refresh(); };
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-line bg-panel p-4 md:w-60 md:border-b-0 md:border-r">
        <div className="mb-4 text-lg font-semibold">ContractGuard</div>
        <label className="mb-1 block text-xs text-muted" htmlFor="org">Organization</label>
        <select id="org" aria-label="Organization switcher" className="mb-4 h-9 w-full rounded-md border border-line bg-bg px-2 text-sm" value={activeOrgId} onChange={(e) => switchOrg(e.target.value)}>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.role.toLowerCase()})</option>)}
        </select>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map(([label, href]) => (
            <Link key={href} href={href} className={cn('whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-panel-2', path.startsWith(href) && 'bg-panel-2 text-brand')}>
              {label}{label === 'Notifications' && unread > 0 && <span className="ml-2 rounded-full bg-brand px-1.5 text-[10px] text-black">{unread}</span>}
            </Link>
          ))}
        </nav>
        <div className="mt-6 border-t border-line pt-3 text-xs text-muted"><div className="truncate">{user.name}</div><div className="truncate">{user.email}</div>
          <button onClick={logout} className="mt-2 text-brand hover:underline">Sign out</button></div>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
