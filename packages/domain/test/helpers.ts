import { readFileSync } from 'node:fs';
import { ContractGuardService, InMemoryStore, type Clock, type JobQueue } from '@contractguard/domain';

export const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8');

export class TestClock implements Clock {
  constructor(public t = new Date('2026-03-15T12:00:00Z')) {}
  now() { return new Date(this.t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}

export interface Harness { svc: ContractGuardService; store: InMemoryStore; clock: TestClock; queued: Array<{ comparisonId: string; orgId: string }>; runQueue(): Promise<void>; failQueue: boolean }

export function harness(): Harness {
  const store = new InMemoryStore();
  const clock = new TestClock();
  const queued: Harness['queued'] = [];
  const h: Harness = { svc: undefined as any, store, clock, queued, failQueue: false, async runQueue() { while (queued.length) await h.svc.processComparison(queued.shift()!.comparisonId); } };
  const queue: JobQueue = { async enqueueComparison(job) { if (h.failQueue) throw new Error('redis down'); queued.push(job); } };
  h.svc = new ContractGuardService({ store, queue, clock });
  return h;
}

let n = 0;
export async function newUser(h: Harness, name = 'User') {
  const email = `user${++n}@example.com`;
  const { user, org } = await h.svc.signup({ email, password: 'correct-horse-battery', name });
  return { user, org, actor: { userId: user.id }, email };
}
