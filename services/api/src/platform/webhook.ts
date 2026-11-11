import { createHmac } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';

/**
 * Outbound webhooks for data alerts. A webhook URL comes from a user, so it is untrusted:
 *
 * - HTTPS only, default port or an explicit one, no credentials in the URL.
 * - SSRF-safe: every address the hostname resolves to must be public (no loopback, private, link-local,
 *   unique-local, CGNAT, multicast, reserved, or IPv4-mapped versions of those). The check runs inside the
 *   socket's own DNS lookup, so the connection goes to the address that was checked (no DNS rebinding
 *   between check and connect).
 * - Optional hostname allowlist (BI_WEBHOOK_ALLOWED_HOSTS: exact hosts or ".suffix" entries).
 * - No redirects (a 3xx is a failure), a short timeout, a capped response read.
 * - Signed: X-Sratchpad-Signature: sha256=HMAC(secret, "<timestamp>.<body>"), X-Sratchpad-Timestamp.
 */

export class WebhookError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/') as [string, string];
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const V4_BLOCKED = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

/** True for any address a webhook must never reach. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return V4_BLOCKED.some((c) => inV4(address, c));
  if (family !== 6) return true;
  const a = address.toLowerCase().split('%')[0]!;
  if (a === '::' || a === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isBlockedAddress(mapped[1]!);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // mapped, hex form: refuse
  const first = parseInt(a.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (a.startsWith('64:ff9b:') || a.startsWith('2001:db8') || a.startsWith('100::')) return true; // NAT64, docs, discard
  return false;
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const h = host.toLowerCase();
  return allowed.some((rule) => (rule.startsWith('.') ? h.endsWith(rule) || h === rule.slice(1) : h === rule));
}

/** Validates a webhook URL's shape (not its addresses: those are checked at connect time). */
export function validateWebhookUrl(raw: string, allowed: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError('The webhook URL is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new WebhookError('Webhooks must use https://.');
  if (url.username || url.password) throw new WebhookError('Webhook URLs cannot contain credentials.');
  if (raw.length > 2000) throw new WebhookError('The webhook URL is too long.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) throw new WebhookError('Webhooks cannot target private or local addresses.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new WebhookError('Webhooks cannot target private or local addresses.');
  }
  if (!hostAllowed(host, allowed)) throw new WebhookError(`Webhooks to ${host} are not allowed on this server.`);
  return url;
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

type LookupFn = (hostname: string, options: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** A socket lookup that refuses hostnames resolving to any blocked address. */
export function safeLookup(base: LookupFn = dnsLookup as unknown as LookupFn) {
  return (hostname: string, options: unknown, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    base(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, '', 4);
      if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) {
        const e = new Error(`Webhook host ${hostname} resolves to a private or local address.`) as NodeJS.ErrnoException;
        e.code = 'EBLOCKED';
        return cb(e, '', 4);
      }
      const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
      if (wantsAll) return cb(null, addresses);
      cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface WebhookSender {
  send(url: string, payload: unknown, secret: string): Promise<WebhookResult>;
}

export class HttpsWebhookSender implements WebhookSender {
  constructor(private readonly options: { allowedHosts?: string[]; timeoutMs?: number; lookup?: LookupFn; now?: () => Date } = {}) {}

  async send(rawUrl: string, payload: unknown, secret: string): Promise<WebhookResult> {
    let url: URL;
    try {
      url = validateWebhookUrl(rawUrl, this.options.allowedHosts);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000));
    return new Promise<WebhookResult>((resolve) => {
      const req = https.request(
        url,
        {
          method: 'POST',
          lookup: safeLookup(this.options.lookup) as never,
          timeout: this.options.timeoutMs ?? 5000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'Sratchpad-Webhook/1',
            'X-Sratchpad-Timestamp': timestamp,
            'X-Sratchpad-Signature': signPayload(secret, timestamp, body),
          },
        },
        (res) => {
          // Drain (capped) and close; redirects are failures, never followed.
          let read = 0;
          res.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > 64 * 1024) res.destroy();
          });
          res.on('end', () => {});
          res.on('error', () => {});
          const status = res.statusCode ?? 0;
          resolve(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: status >= 300 && status < 400 ? 'Redirects are not followed.' : `HTTP ${status}` });
        },
      );
      req.on('timeout', () => req.destroy(new Error('The webhook timed out.')));
      req.on('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, error: error.message }));
      req.end(body);
    });
  }
}
