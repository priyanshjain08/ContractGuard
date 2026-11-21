'use client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { call } from '@/lib/client';
import { Button } from '@/components/ui/button';
import { Card, Input, Label } from '@/components/ui/primitives';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    const f = new FormData(e.currentTarget);
    try {
      await call('POST', `/auth/${mode}`, { email: f.get('email'), password: f.get('password'), name: f.get('name') });
      router.replace('/dashboard'); router.refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div><h1 className="text-2xl font-semibold">ContractGuard</h1><p className="text-sm text-muted">{mode === 'login' ? 'Sign in to your workspace' : 'Create your workspace'}</p></div>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          {mode === 'signup' && <div><Label htmlFor="name">Name</Label><Input id="name" name="name" required maxLength={80} autoComplete="name" /></div>}
          <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" required autoComplete="email" /></div>
          <div><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" required minLength={mode === 'signup' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</Button>
        </form>
      </Card>
      <p className="text-center text-sm text-muted">{mode === 'login' ? <>No account? <Link className="text-brand" href="/signup">Sign up</Link></> : <>Have an account? <Link className="text-brand" href="/login">Sign in</Link></>}</p>
    </main>
  );
}
