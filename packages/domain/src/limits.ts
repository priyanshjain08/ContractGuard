import { AppError } from './errors.ts';
import type { Plan } from './types.ts';

export interface PlanLimits {
  projects: number; members: number; versionsPerMonth: number; comparisonsPerMonth: number;
  maxSpecBytes: number; aiExplanationsPerMonth: number;
}
const INF = Number.POSITIVE_INFINITY;
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: { projects: 3, members: 3, versionsPerMonth: 50, comparisonsPerMonth: 100, maxSpecBytes: 1 * 1024 * 1024, aiExplanationsPerMonth: 20 },
  PRO: { projects: 50, members: 25, versionsPerMonth: 2000, comparisonsPerMonth: 5000, maxSpecBytes: 5 * 1024 * 1024, aiExplanationsPerMonth: 1000 },
  ENTERPRISE: { projects: INF, members: INF, versionsPerMonth: INF, comparisonsPerMonth: INF, maxSpecBytes: 5 * 1024 * 1024, aiExplanationsPerMonth: INF },
};

export function assertWithinLimit(plan: Plan, metric: keyof PlanLimits, currentUsage: number, adding = 1): void {
  const limit = PLAN_LIMITS[plan][metric];
  if (currentUsage + adding > limit) {
    throw new AppError('LIMIT_EXCEEDED', `The ${plan} plan allows at most ${limit} for "${metric}". Upgrade to continue.`, { metric, limit, plan });
  }
}

export const startOfMonthUtc = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
