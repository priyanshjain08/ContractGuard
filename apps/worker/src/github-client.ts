// UNVERIFIED: never exercised against the real GitHub API. The *logic around it* (runPullRequestCheck) is unit-tested with a fake gateway.
import { createSign } from 'node:crypto';
import type { GithubGateway } from '@contractguard/domain';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT identifying the GitHub App (valid ≤10 minutes, per GitHub docs). */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat: nowSec - 30, exp: nowSec + 9 * 60, iss: appId }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64u(sig)}`;
}

export class GithubAppGateway implements GithubGateway {
  private tokens = new Map<number, { token: string; exp: number }>();
  constructor(private appId: string, private privateKey: string, private api = 'https://api.github.com') {}

  private async call(path: string, init: RequestInit & { token: string }): Promise<Response> {
    const { token, ...rest } = init;
    return fetch(`${this.api}${path}`, { ...rest, signal: AbortSignal.timeout(15_000), headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'ContractGuard', ...(rest.headers as object) } });
  }

  private async installationToken(id: number): Promise<string> {
    const cached = this.tokens.get(id);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const res = await this.call(`/app/installations/${id}/access_tokens`, { method: 'POST', token: appJwt(this.appId, this.privateKey) });
    if (!res.ok) throw new Error(`GitHub token request failed: ${res.status}`);
    const data: any = await res.json();
    this.tokens.set(id, { token: data.token, exp: Date.parse(data.expires_at) });
    return data.token;
  }

  async getFile(o: { installationId: number; owner: string; repo: string; ref: string; path: string }): Promise<string | undefined> {
    const token = await this.installationToken(o.installationId);
    const path = o.path.split('/').map(encodeURIComponent).join('/');
    const res = await this.call(`/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}/contents/${path}?ref=${encodeURIComponent(o.ref)}`, { token, headers: { accept: 'application/vnd.github.raw+json' } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub contents request failed: ${res.status}`);
    const text = await res.text();
    if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('Specification file is too large.');
    return text;
  }

  async createCheckRun(o: Parameters<GithubGateway['createCheckRun']>[0]): Promise<void> {
    const token = await this.installationToken(o.installationId);
    const res = await this.call(`/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}/check-runs`, {
      method: 'POST', token, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: o.name, head_sha: o.headSha, status: 'completed', conclusion: o.output.conclusion, details_url: o.detailsUrl, output: o.output }),
    });
    if (!res.ok) throw new Error(`GitHub check-run request failed: ${res.status}`);
  }
}
