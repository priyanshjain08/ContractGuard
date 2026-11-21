import { isIP } from 'node:net';
import { AppError } from './errors.ts';

/** True only for globally routable unicast addresses. Everything private, loopback, link-local, metadata, multicast or reserved is rejected. */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // IETF protocol assignments / TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false; // TEST-NET-2
    if (a === 203 && b === 0) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]!);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
      return isPublicIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === '::' || lower === '::1') return false;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (lower.startsWith('2001:db8')) return false; // documentation
    return true;
  }
  return false;
}

export interface FetchedResponse { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> | Uint8Array }
export interface SafeFetchDeps {
  /** Resolve ALL addresses for a hostname. */
  lookup(hostname: string): Promise<string[]>;
  /** Perform a single request (no redirect following) pinned to `address`, so DNS cannot change between check and use. */
  request(url: URL, address: string, opts: { timeoutMs: number }): Promise<FetchedResponse>;
}
export interface SafeFetchOptions { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; allowHttp?: boolean; allowedPorts?: number[] }

const unsafe = (msg: string) => new AppError('UNSAFE_URL', msg);

export function validateImportUrl(raw: string, opts: SafeFetchOptions = {}): URL {
  if (raw.length > 2048) throw unsafe('URL is too long.');
  let url: URL;
  try { url = new URL(raw); } catch { throw unsafe('URL is not valid.'); }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) throw unsafe('Only https:// URLs are allowed.');
  if (url.username || url.password) throw unsafe('URLs with embedded credentials are not allowed.');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!(opts.allowedPorts ?? [80, 443]).includes(port)) throw unsafe(`Port ${port} is not allowed.`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw unsafe('Host is not allowed.');
  if (isIP(host) && !isPublicIp(host)) throw unsafe('Address is not publicly routable.');
  return url;
}

async function readCapped(body: FetchedResponse['body'], maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iter: AsyncIterable<Uint8Array> = body instanceof Uint8Array ? (async function* () { yield body; })() : body;
  for await (const chunk of iter) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new AppError('VALIDATION', `Remote document exceeds ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches a remote specification defensively: https only, no credentials, restricted ports, every hop's DNS result must be
 * public (blocks SSRF to internal services and cloud metadata), connection pinned to the validated IP (anti DNS-rebinding),
 * redirects revalidated, hard timeout and streaming size cap.
 */
export async function safeFetchText(rawUrl: string, deps: SafeFetchDeps, opts: SafeFetchOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  let url = validateImportUrl(rawUrl, opts);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await deps.lookup(host);
    if (addresses.length === 0) throw unsafe('Host did not resolve.');
    if (!addresses.every(isPublicIp)) throw unsafe('Host resolves to a non-public address.');
    const res = await deps.request(url, addresses[0]!, { timeoutMs: opts.timeoutMs ?? 10_000 });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers['location'];
      if (!loc) throw new AppError('VALIDATION', 'Redirect without Location header.');
      url = validateImportUrl(new URL(loc, url).toString(), opts);
      continue;
    }
    if (res.status !== 200) throw new AppError('VALIDATION', `Remote server responded with HTTP ${res.status}.`);
    const len = Number(res.headers['content-length']);
    if (Number.isFinite(len) && len > maxBytes) throw new AppError('VALIDATION', `Remote document exceeds ${maxBytes} bytes.`);
    return readCapped(res.body, maxBytes);
  }
  throw unsafe('Too many redirects.');
}
