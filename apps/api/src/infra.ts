// UNVERIFIED (NestJS not installable in the authoring environment): cross-cutting HTTP concerns.
import { CanActivate, Catch, ExceptionFilter, ExecutionContext, Injectable, SetMetadata, type ArgumentsHost, createParamDecorator, HttpException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, ContractGuardService } from '@contractguard/domain';

export const SESSION_COOKIE = 'cg_session';
export const Public = () => SetMetadata('isPublic', true);

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; } }
  }
  return undefined;
}

/** Cookie-session authentication + CSRF defense (Origin check on state-changing requests). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private svc: ContractGuardService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>('isPublic', [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin as string | undefined;
      const allowed = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',');
      if (!origin || !allowed.includes(origin)) throw new AppError('FORBIDDEN', 'Cross-origin request rejected.');
    }
    const user = await this.svc.authenticate(readCookie(req.headers.cookie, SESSION_COOKIE));
    req.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as { id: string; email: string; name: string });

/** One consistent error envelope: { error: { code, message, details? } }. Internal errors never leak details. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private log = new Logger('ErrorFilter');
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return res.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'VALIDATION', message: err.message } });
    }
    this.log.error(err instanceof Error ? err.stack : String(err));
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  }
}

export const uuid = (v: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new AppError('VALIDATION', 'Invalid identifier.');
  return v;
};
