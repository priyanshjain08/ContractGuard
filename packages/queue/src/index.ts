// UNVERIFIED: BullMQ/Redis were not installable in the authoring environment.
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobQueue, PullRequestEvent } from '@contractguard/domain';

export const QUEUES = { comparisons: 'contractguard-comparisons', github: 'contractguard-github' } as const;

/** BullMQ requires `maxRetriesPerRequest: null` on worker connections. */
export const createRedis = (url = process.env.REDIS_URL ?? 'redis://localhost:6379') => new Redis(url, { maxRetriesPerRequest: null });

const defaultJobOptions = { attempts: 3, backoff: { type: 'exponential' as const, delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 };

export class BullJobQueue implements JobQueue {
  private comparisons: Queue;
  private github: Queue;
  constructor(connection = createRedis()) {
    this.comparisons = new Queue(QUEUES.comparisons, { connection, defaultJobOptions });
    this.github = new Queue(QUEUES.github, { connection, defaultJobOptions });
  }
  async enqueueComparison(job: { comparisonId: string; orgId: string }) {
    // jobId = comparison id makes enqueueing idempotent.
    await this.comparisons.add('compare', job, { jobId: job.comparisonId });
  }
  async enqueuePullRequest(ev: PullRequestEvent, deliveryId: string) {
    await this.github.add('pull_request', ev, { jobId: `gh-${deliveryId}` });
  }
}
