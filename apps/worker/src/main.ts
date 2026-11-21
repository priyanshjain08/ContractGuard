// UNVERIFIED (BullMQ/Redis/Postgres not available in the authoring environment).
import { Worker } from 'bullmq';
import { ContractGuardService, type GithubGateway, type PullRequestEvent } from '@contractguard/domain';
import { createStore } from '@contractguard/db';
import { BullJobQueue, createRedis, QUEUES } from '@contractguard/queue';
import { GithubAppGateway } from './github-client.ts';

const connection = createRedis();
const svc = new ContractGuardService({ store: createStore(), queue: new BullJobQueue(createRedis()) });

const gateway: GithubGateway | undefined = process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
  ? new GithubAppGateway(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'))
  : undefined;

const comparisons = new Worker(QUEUES.comparisons, async (job) => {
  const c = await svc.processComparison(job.data.comparisonId);
  return { status: c.status, result: c.result };
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });

const github = new Worker(QUEUES.github, async (job) => {
  if (!gateway) return { skipped: 'GitHub App is not configured' };
  return svc.runPullRequestCheck(job.data as PullRequestEvent, gateway, { webBaseUrl: process.env.WEB_ORIGIN?.split(',')[0] });
}, { connection: createRedis(), concurrency: 2 });

for (const w of [comparisons, github]) {
  w.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed: ${err.message}`));
  w.on('completed', (job) => console.log(`[worker] job ${job.id} completed`));
}

const shutdown = async () => { await Promise.all([comparisons.close(), github.close()]); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log('[worker] listening');
