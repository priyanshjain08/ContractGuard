// UNVERIFIED adapter for the (tested) safeFetchText logic: real DNS + https with the connection pinned to the checked IP.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { SafeFetchDeps } from '@contractguard/domain';

export const realFetchDeps: SafeFetchDeps = {
  async lookup(hostname) { return (await lookup(hostname, { all: true })).map((a) => a.address); },
  request(url, address, { timeoutMs }) {
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'ContractGuard/0.1', accept: 'application/yaml, application/json, text/*' },
        // Pin the socket to the address validated by safeFetchText (prevents DNS rebinding between check and use).
        lookup: (_h, _o, cb) => cb(null, address, address.includes(':') ? 6 : 4),
      }, (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
        resolve({ status: res.statusCode ?? 0, headers, body: res });
      });
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      req.end();
    });
  },
};
