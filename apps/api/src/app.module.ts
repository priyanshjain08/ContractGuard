// UNVERIFIED (NestJS not installable in the authoring environment).
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ContractGuardService, type LlmClient } from '@contractguard/domain';
import { createStore } from '@contractguard/db';
import { BullJobQueue } from '@contractguard/queue';
import { AuthController, OrgsController, ProjectsController, RulesController, WebhooksController } from './controllers.ts';
import { AuthGuard, ErrorFilter } from './infra.ts';

/** Optional LLM adapter. Absent => deterministic, rule-based explanations (never an error). */
function createLlm(): LlmClient | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return {
    async complete({ system, user }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.LLM_MODEL ?? 'claude-sonnet-4-6', max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data: any = await res.json();
      return (data.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])],
  controllers: [RulesController, AuthController, OrgsController, ProjectsController, WebhooksController],
  providers: [
    { provide: 'QUEUE', useFactory: () => new BullJobQueue() },
    { provide: 'LLM', useFactory: createLlm },
    { provide: ContractGuardService, inject: ['QUEUE'], useFactory: (queue: BullJobQueue) => new ContractGuardService({ store: createStore(), queue }) },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
