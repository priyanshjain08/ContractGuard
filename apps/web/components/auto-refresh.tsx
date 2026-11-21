'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
/** Polls the server component tree while an analysis job is queued or running. */
export function AutoRefresh({ active, everyMs = 2000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => { if (!active) return; const t = setInterval(() => router.refresh(), everyMs); return () => clearInterval(t); }, [active, everyMs, router]);
  return null;
}
