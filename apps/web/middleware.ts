import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/signup'];
/** Cheap gate only: real authentication is enforced by the API on every request. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = !!req.cookies.get('cg_session');
  if (!hasSession && !PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.redirect(new URL('/login', req.url));
  if (hasSession && PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.redirect(new URL('/dashboard', req.url));
  return NextResponse.next();
}
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
