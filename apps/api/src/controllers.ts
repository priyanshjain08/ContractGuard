// UNVERIFIED (NestJS not installable in the authoring environment). Controllers are intentionally thin:
// every rule (authorization, tenancy, limits, validation) lives in the tested ContractGuardService.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import {
  AppError, ContractGuardService, parsePullRequestEvent, safeFetchText, verifyGithubSignature, type Category, type Severity,
} from '@contractguard/domain';
import { RULES } from '@contractguard/compatibility';
import { BullJobQueue } from '@contractguard/queue';
import { CurrentUser, Public, SESSION_COOKIE, readCookie, uuid } from './infra.ts';
import { realFetchDeps } from './net-deps.ts';

type U = { id: string };
const act = (u: U) => ({ userId: u.id });
const secure = () => process.env.NODE_ENV === 'production';
const cookieOpts = (expires?: Date) => ({ httpOnly: true, sameSite: 'lax' as const, secure: secure(), path: '/', ...(expires ? { expires } : {}) });

@Controller('rules')
export class RulesController {
  @Get() list() { return Object.values(RULES).map((r) => ({ id: r.id, title: r.title, severity: r.severity, categories: r.categories, rationale: r.rationale })); }
}

@Controller('auth')
export class AuthController {
  constructor(private svc: ContractGuardService) {}

  @Public() @Post('signup') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async signup(@Body() b: any, @Res({ passthrough: true }) res: any) {
    const { user, org } = await this.svc.signup(b);
    const s = await this.svc.login({ email: b.email, password: b.password });
    res.cookie(SESSION_COOKIE, s.token, cookieOpts(s.expiresAt));
    return { user, org };
  }

  @Public() @Post('login') @HttpCode(200) @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async login(@Body() b: any, @Res({ passthrough: true }) res: any) {
    const s = await this.svc.login(b);
    res.cookie(SESSION_COOKIE, s.token, cookieOpts(s.expiresAt));
    return { user: s.user, orgs: await this.svc.listMyOrgs({ userId: s.user.id }) };
  }

  @Post('logout') @HttpCode(204)
  async logout(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const t = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (t) await this.svc.logout(t);
    res.clearCookie(SESSION_COOKIE, cookieOpts());
  }

  @Get('me')
  async me(@CurrentUser() u: U & { email: string; name: string }) { return { user: u, orgs: await this.svc.listMyOrgs(act(u)) }; }
}

@Controller('orgs')
export class OrgsController {
  constructor(private svc: ContractGuardService) {}
  @Post() create(@CurrentUser() u: U, @Body() b: any) { return this.svc.createOrg(act(u), b?.name); }
  @Get(':orgId/dashboard') dashboard(@CurrentUser() u: U, @Param('orgId') o: string) { return this.svc.getDashboard(act(u), uuid(o)); }
  @Get(':orgId/members') members(@CurrentUser() u: U, @Param('orgId') o: string) { return this.svc.listMembers(act(u), uuid(o)); }
  @Post(':orgId/members') @HttpCode(204) async addMember(@CurrentUser() u: U, @Param('orgId') o: string, @Body() b: any) { await this.svc.addMember(act(u), uuid(o), b?.email, b?.role); }
  @Patch(':orgId/members/:userId') @HttpCode(204) async role(@CurrentUser() u: U, @Param('orgId') o: string, @Param('userId') t: string, @Body() b: any) { await this.svc.changeMemberRole(act(u), uuid(o), uuid(t), b?.role); }
  @Delete(':orgId/members/:userId') @HttpCode(204) async remove(@CurrentUser() u: U, @Param('orgId') o: string, @Param('userId') t: string) { await this.svc.removeMember(act(u), uuid(o), uuid(t)); }
  @Get(':orgId/notifications') notes(@CurrentUser() u: U, @Param('orgId') o: string) { return this.svc.listNotifications(act(u), uuid(o)); }
  @Post(':orgId/notifications/:id/read') @HttpCode(204) async read(@CurrentUser() u: U, @Param('orgId') o: string, @Param('id') id: string) { await this.svc.markNotificationRead(act(u), uuid(o), uuid(id)); }
  @Get(':orgId/audit') audit(@CurrentUser() u: U, @Param('orgId') o: string, @Query('limit') l?: string) { return this.svc.listAudit(act(u), uuid(o), l ? Number(l) : 100); }
  @Get(':orgId/policies') policies(@CurrentUser() u: U, @Param('orgId') o: string, @Query('projectId') p?: string) { return this.svc.listPolicies(act(u), uuid(o), p ? uuid(p) : undefined); }
  @Post(':orgId/policies') savePolicy(@CurrentUser() u: U, @Param('orgId') o: string, @Body() b: any) { return this.svc.savePolicy(act(u), uuid(o), { name: b?.name, projectId: b?.projectId ? uuid(b.projectId) : undefined, policy: b?.policy }); }
  @Get(':orgId/integrations/github') links(@CurrentUser() u: U, @Param('orgId') o: string) { return this.svc.listGithubLinks(act(u), uuid(o)); }
  @Post(':orgId/integrations/github') link(@CurrentUser() u: U, @Param('orgId') o: string, @Body() b: any) { return this.svc.linkGithubRepo(act(u), uuid(o), { ...b, projectId: uuid(String(b?.projectId)) }); }
  @Delete(':orgId/integrations/github/:id') @HttpCode(204) async unlink(@CurrentUser() u: U, @Param('orgId') o: string, @Param('id') id: string) { await this.svc.unlinkGithubRepo(act(u), uuid(o), uuid(id)); }
}

@Controller('orgs/:orgId')
export class ProjectsController {
  constructor(private svc: ContractGuardService) {}
  @Get('projects') list(@CurrentUser() u: U, @Param('orgId') o: string) { return this.svc.listProjects(act(u), uuid(o)); }
  @Post('projects') create(@CurrentUser() u: U, @Param('orgId') o: string, @Body() b: any) { return this.svc.createProject(act(u), uuid(o), b); }
  @Get('projects/:projectId') get(@CurrentUser() u: U, @Param('orgId') o: string, @Param('projectId') p: string) { return this.svc.getProject(act(u), uuid(o), uuid(p)); }
  @Delete('projects/:projectId') @HttpCode(204) async del(@CurrentUser() u: U, @Param('orgId') o: string, @Param('projectId') p: string) { await this.svc.deleteProject(act(u), uuid(o), uuid(p)); }
  @Post('projects/:projectId/environments') env(@CurrentUser() u: U, @Param('orgId') o: string, @Param('projectId') p: string, @Body() b: any) { return this.svc.createEnvironment(act(u), uuid(o), uuid(p), b?.name); }

  @Get('projects/:projectId/versions') versions(@CurrentUser() u: U, @Param('orgId') o: string, @Param('projectId') p: string) { return this.svc.listVersions(act(u), uuid(o), uuid(p)); }
  @Get('versions/:versionId/content') async content(@CurrentUser() u: U, @Param('orgId') o: string, @Param('versionId') v: string, @Res() res: any) {
    const ver = await this.svc.getVersionContent(act(u), uuid(o), uuid(v));
    res.set({ 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment; filename="openapi-spec.txt"' }).send(ver.content);
  }

  /** Accepts either multipart (`file`) or JSON `{ content }`. Size is enforced by multer AND by the domain layer's plan limit. */
  @Post('projects/:projectId/versions') @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } }))
  upload(@CurrentUser() u: U, @Param('orgId') o: string, @Param('projectId') p: string, @Body() b: any, @UploadedFile() file?: { buffer: Buffer }) {
    const content = file ? file.buffer.toString('utf8') : b?.content;
    return this.svc.uploadSpec(act(u), uuid(o), uuid(p), { content, label: b?.label, environmentId: b?.environmentId ? uuid(b.environmentId) : undefined });
  }

  @Post('projects/:projectId/versions/import-url') @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async importUrl(@CurrentUser() u: U, @Param('orgId') o: string, @Param('projectId') p: string, @Body() b: any) {
    await this.svc.listVersions(act(u), uuid(o), uuid(p)); // authorization + tenancy before any outbound request
    const content = await safeFetchText(String(b?.url ?? ''), realFetchDeps, { allowHttp: process.env.ALLOW_HTTP_IMPORT === 'true' });
    return this.svc.uploadSpec(act(u), uuid(o), uuid(p), { content, label: b?.label, source: 'url' });
  }

  @Post('comparisons') request(@CurrentUser() u: U, @Param('orgId') o: string, @Body() b: any) {
    return this.svc.requestComparison(act(u), uuid(o), { baseVersionId: uuid(String(b?.baseVersionId)), targetVersionId: uuid(String(b?.targetVersionId)), policyId: b?.policyId ? uuid(b.policyId) : undefined });
  }
  @Get('comparisons') comparisons(@CurrentUser() u: U, @Param('orgId') o: string, @Query('projectId') p?: string) { return this.svc.listComparisons(act(u), uuid(o), p ? uuid(p) : undefined); }
  @Get('comparisons/:id') comparison(@CurrentUser() u: U, @Param('orgId') o: string, @Param('id') id: string) { return this.svc.getComparison(act(u), uuid(o), uuid(id)); }
  @Get('comparisons/:id/findings') findings(@CurrentUser() u: U, @Param('orgId') o: string, @Param('id') id: string, @Query() q: Record<string, string>) {
    return this.svc.listFindings(act(u), uuid(o), uuid(id), {
      category: q.category as Category | undefined, severity: q.severity as Severity | undefined, outcome: q.outcome, q: q.q?.slice(0, 100),
      limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
    });
  }
  @Get('comparisons/:id/findings/:findingId') finding(@CurrentUser() u: U, @Param('orgId') o: string, @Param('id') id: string, @Param('findingId') f: string) { return this.svc.getFinding(act(u), uuid(o), uuid(id), f); }
  @Post('comparisons/:id/findings/:findingId/explain') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  explain(@CurrentUser() u: U, @Param('orgId') o: string, @Param('id') id: string, @Param('findingId') f: string, @Inject('LLM') llm: any) { return this.svc.explain(act(u), uuid(o), uuid(id), f, llm ?? undefined); }

  @Get('comparisons/:id/report.:format') async report(@CurrentUser() u: U, @Param('orgId') o: string, @Param('id') id: string, @Param('format') f: string, @Res() res: any) {
    if (f !== 'json' && f !== 'csv' && f !== 'html') throw new AppError('VALIDATION', 'format must be json, csv or html.');
    const r = await this.svc.exportReport(act(u), uuid(o), uuid(id), f);
    res.set({ 'content-type': r.contentType, 'content-disposition': `attachment; filename="${r.filename}"`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }).send(r.body);
  }
}

@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject('QUEUE') private queue: BullJobQueue) {}
  /** Signature is verified over the RAW body (NestFactory is created with rawBody: true). */
  @Public() @Post('github') @HttpCode(202)
  async github(@Req() req: any, @Body() payload: any) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    if (!verifyGithubSignature(secret, req.rawBody ?? '', req.headers['x-hub-signature-256'])) throw new AppError('UNAUTHENTICATED', 'Invalid signature.');
    const ev = parsePullRequestEvent(req.headers['x-github-event'], payload);
    if (!ev) return { ignored: true };
    await this.queue.enqueuePullRequest(ev, String(req.headers['x-github-delivery'] ?? `${ev.owner}-${ev.repo}-${ev.number}-${ev.headSha}`));
    return { queued: true };
  }
}
