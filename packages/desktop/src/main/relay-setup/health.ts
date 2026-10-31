import https from 'node:https';
import { isIPv4 } from './plan.js';

/** The relay health check from the Mac over TLS with the system's certificate check (spec 6.7 step 6). */
export type HealthFetcher = (url: string) => Promise<{ status: number }>;

/** Node's own `https`; `ca` lets the test stand trust the Pebble root. The app passes Electron's `net.fetch` instead. */
export function nodeHealthFetcher(options: { ca?: string } = {}): HealthFetcher {
  return (url) =>
    new Promise((resolve, reject) => {
      const request = https.get(url, { timeout: 8000, ...(options.ca !== undefined ? { ca: options.ca } : {}) }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
    });
}

export interface HealthOptions {
  fetcher: HealthFetcher;
  /** Certificate issuance takes a while after the first start. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type HealthResult = { ok: true } | { ok: false; detail: string };

export async function checkHealth(address: string, options: HealthOptions): Promise<HealthResult> {
  const attempts = options.attempts ?? 18;
  const delay = options.delayMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let detail = 'no answer';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { status } = await options.fetcher(`https://${address}/v1/health`);
      if (status === 200) return { ok: true };
      detail = `HTTP ${status}`;
    } catch (error) {
      detail = error instanceof Error ? error.message.slice(0, 120) : 'no answer';
    }
    if (attempt + 1 < attempts) await sleep(delay);
  }
  return { ok: false, detail };
}

export interface Resolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

const safe = (task: Promise<string[]>): Promise<string[]> => task.catch(() => []);

export async function addressesOf(host: string, resolver: Resolver): Promise<string[]> {
  const [a, aaaa] = await Promise.all([safe(resolver.resolve4(host)), safe(resolver.resolve6(host))]);
  return [...a, ...aaaa].map((ip) => ip.toLowerCase());
}

/** Spec 6.7: an own domain must have A/AAAA records pointing to the server. */
export async function domainPointsTo(domain: string, serverIps: readonly string[], resolver: Resolver): Promise<boolean> {
  const records = await addressesOf(domain, resolver);
  const wanted = new Set(serverIps.map((ip) => ip.toLowerCase()));
  return records.some((ip) => wanted.has(ip));
}

export const firstIPv4 = (ips: readonly string[]): string | null => ips.find(isIPv4) ?? null;

/** Private, loopback, link-local, CGNAT and other non-routable IPv4 ranges: no certificate can be issued for them. */
export function isPublicIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}
