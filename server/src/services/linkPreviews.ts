import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { DB } from '../db/index.js';
import type { LinkPreviewView } from '../types.js';

/** How long a fetched preview (or a failed attempt) is reused for new messages. */
export const PREVIEW_CACHE_MS = 24 * 60 * 60 * 1000;
export const PREVIEW_FAILURE_CACHE_MS = 60 * 60 * 1000;
export const PREVIEW_TIMEOUT_MS = 5000;
export const PREVIEW_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_IN_FLIGHT = 8;
const USER_AGENT = 'Mozilla/5.0 (compatible; Datasetto/1.0; +link-preview)';

// ------------------------------------------------------------------ addresses

const ipv4ToNumber = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
};

/** [network, prefix length] of IPv4 ranges that are never public. */
const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

const isPublicIPv4 = (ip: string): boolean => {
  const value = ipv4ToNumber(ip);
  if (value === null) return false;
  for (const [network, prefix] of PRIVATE_V4) {
    const base = ipv4ToNumber(network) as number;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((value & mask) >>> 0) === ((base & mask) >>> 0)) return false;
  }
  return true;
};

/** Expand an IPv6 address to its eight 16-bit groups, or null when malformed. */
const expandIPv6 = (ip: string): number[] | null => {
  let text = ip;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToNumber(tail);
    if (v4 === null) return null;
    text = text.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest].map((group) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return NaN;
    return parseInt(group, 16);
  });
  return groups.some(Number.isNaN) ? null : groups;
};

const v4FromGroups = (hi: number, lo: number): string => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');

const isPublicIPv6 = (ip: string): boolean => {
  const g = expandIPv6(ip);
  if (!g) return false;
  const allZero = g.every((group) => group === 0);
  if (allZero) return false; // ::
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 part.
  if (g.slice(0, 5).every((group) => group === 0) && (g[5] === 0xffff || g[5] === 0)) return isPublicIPv4(v4FromGroups(g[6], g[7]));
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) return isPublicIPv4(v4FromGroups(g[6], g[7]));
  // 6to4 (2002::/16) embeds the IPv4 address in the next 32 bits.
  if (g[0] === 0x2002) return isPublicIPv4(v4FromGroups(g[1], g[2]));
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  return true;
};

/**
 * Is this IP address somewhere on the public internet? Loopback, private, link-local
 * (including cloud metadata), multicast, documentation and reserved ranges are not,
 * nor are IPv6 forms that wrap such an IPv4 address.
 */
export const isPublicAddress = (ip: string): boolean => {
  const version = isIP(ip);
  if (version === 4) return isPublicIPv4(ip);
  if (version === 6) return isPublicIPv6(ip);
  return false;
};

/** Host names that always mean "this machine" or "this network", whatever DNS says. */
const isLocalHostname = (hostname: string): boolean => {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal') || name.endsWith('.home.arpa') || name === 'metadata.google.internal';
};

// ---------------------------------------------------------------------- urls

const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** The first http(s) link in a message, cleaned up, or null. Links with credentials are ignored. */
export const extractFirstUrl = (text: string): string | null => {
  const match = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!match) return null;
  let raw = match[0].replace(TRAILING_PUNCTUATION, '');
  // Closing brackets that were never opened belong to the sentence, not the link.
  const count = (text: string, char: string): number => text.split(char).length - 1;
  while (/[)\]}>]$/.test(raw)) {
    const close = raw[raw.length - 1];
    const open = { ')': '(', ']': '[', '}': '{', '>': '<' }[close as ')' | ']' | '}' | '>'];
    if (count(raw, close) <= count(raw, open)) break;
    raw = raw.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
  }
  if (raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || !url.hostname) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------- parsing

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });

const cleanText = (value: string | undefined, max: number): string | null => {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
};

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const parseAttributes = (tag: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
};

export interface ParsedPage {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/** Open Graph first, then Twitter cards, then the plain title and description. Regex based; never evaluates the page. */
export const parsePage = (html: string, baseUrl: string): ParsedPage => {
  const meta = new Map<string, string>();
  const headEnd = html.search(/<body[\s>]/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const key = (attributes.property ?? attributes.name ?? '').toLowerCase();
    if (!key || attributes.content === undefined || meta.has(key)) continue;
    meta.set(key, attributes.content);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value && value.trim()) return value;
    }
    return undefined;
  };

  let image: string | null = null;
  const rawImage = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage.trim()), baseUrl);
      if ((resolved.protocol === 'http:' || resolved.protocol === 'https:') && resolved.href.length <= 2048) image = resolved.href;
    } catch {
      /* not a URL */
    }
  }

  return {
    title: cleanText(pick('og:title', 'twitter:title') ?? titleTag?.[1], 200),
    description: cleanText(pick('og:description', 'twitter:description', 'description'), 300),
    image,
    siteName: cleanText(pick('og:site_name'), 100),
  };
};

// ------------------------------------------------------------------ fetching

export interface FetchedDocument {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

export type LookupFn = (hostname: string) => Promise<string[]>;

export interface LinkPreviewOptions {
  timeoutMs?: number;
  maxBytes?: number;
  cacheMs?: number;
  failureCacheMs?: number;
  /** DNS resolution to use (tests inject one); every returned address is checked with `isAllowedAddress`. */
  lookup?: LookupFn;
  /** Defaults to {@link isPublicAddress}. */
  isAllowedAddress?: (ip: string) => boolean;
  /** Replace the HTTP transport entirely (tests). Gets the already checked URL. */
  fetchDocument?: (url: string) => Promise<FetchedDocument>;
}

export class LinkPreviewError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LinkPreviewError';
  }
}

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

interface PreviewRow {
  url: string;
  final_url: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  ok: number;
  fetched_at: number;
}

export interface LinkPreviewRecord extends LinkPreviewView {
  finalUrl: string | null;
  ok: boolean;
  fetchedAt: number;
}

const rowToRecord = (row: PreviewRow): LinkPreviewRecord => ({
  url: row.url,
  finalUrl: row.final_url,
  title: row.title,
  description: row.description,
  image: row.image,
  siteName: row.site_name,
  ok: row.ok === 1,
  fetchedAt: row.fetched_at,
});

/** The card shown to clients, or null when the record has nothing to show. */
export const previewView = (record: LinkPreviewRecord | null | undefined): LinkPreviewView | null => {
  if (!record || !record.ok) return null;
  if (!record.title && !record.description && !record.image) return null;
  return { url: record.url, title: record.title, description: record.description, image: record.image, siteName: record.siteName };
};

/**
 * Fetches what a link points at and keeps the result per URL (`link_previews`).
 * Only public addresses are contacted: the host is resolved first and every
 * address (also after a redirect) must pass the filter, the connection goes to
 * the checked address, the whole fetch is bounded to 5 s and 1 MB, and only HTML
 * (or a bare image) yields a card. Nothing from the page is ever executed.
 */
export class LinkPreviewService {
  private readonly stmts;
  private readonly inFlight = new Map<string, Promise<LinkPreviewRecord>>();
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly cacheMs: number;
  private readonly failureCacheMs: number;
  private readonly lookup: LookupFn;
  private readonly isAllowedAddress: (ip: string) => boolean;
  private readonly fetchDocument: (url: string) => Promise<FetchedDocument>;

  constructor(db: DB, options: LinkPreviewOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? PREVIEW_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES;
    this.cacheMs = options.cacheMs ?? PREVIEW_CACHE_MS;
    this.failureCacheMs = options.failureCacheMs ?? PREVIEW_FAILURE_CACHE_MS;
    this.lookup = options.lookup ?? defaultLookup;
    this.isAllowedAddress = options.isAllowedAddress ?? isPublicAddress;
    this.fetchDocument = options.fetchDocument ?? ((url) => this.download(url));
    this.stmts = {
      get: db.prepare('SELECT * FROM link_previews WHERE url = ?'),
      upsert: db.prepare(`
        INSERT INTO link_previews (url, final_url, title, description, image, site_name, ok, fetched_at)
        VALUES (@url, @final_url, @title, @description, @image, @site_name, @ok, @fetched_at)
        ON CONFLICT(url) DO UPDATE SET final_url = excluded.final_url, title = excluded.title, description = excluded.description,
          image = excluded.image, site_name = excluded.site_name, ok = excluded.ok, fetched_at = excluded.fetched_at
      `),
      purge: db.prepare(`
        DELETE FROM link_previews WHERE fetched_at < ? AND url NOT IN (SELECT preview_url FROM messages WHERE preview_url IS NOT NULL)
      `),
    };
  }

  /** What is cached for a URL, however old. */
  cached(url: string): LinkPreviewRecord | null {
    const row = this.stmts.get.get(url) as PreviewRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  isFresh(record: LinkPreviewRecord, now = Date.now()): boolean {
    return now - record.fetchedAt < (record.ok ? this.cacheMs : this.failureCacheMs);
  }

  /**
   * The preview for a URL: from the cache while fresh, else fetched (one fetch per
   * URL at a time). Resolves to the stored record; failures are stored as `ok: false`.
   * Never rejects.
   */
  async previewFor(url: string, now = Date.now()): Promise<LinkPreviewRecord> {
    const existing = this.cached(url);
    if (existing && this.isFresh(existing, now)) return existing;
    const running = this.inFlight.get(url);
    if (running) return running;
    if (this.inFlight.size >= MAX_IN_FLIGHT) return existing ?? this.remember(url, null, null, now);

    const task = this.fetchPreview(url)
      .then((result) => this.remember(url, result.finalUrl, result.page, Date.now()))
      .catch(() => this.remember(url, null, null, Date.now()))
      .finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, task);
    return task;
  }

  /** Fetch and parse without touching the cache. Rejects with a LinkPreviewError. */
  async fetchPreview(url: string): Promise<{ finalUrl: string; page: ParsedPage }> {
    const document = await this.fetchDocument(url);
    const type = document.contentType.split(';')[0].trim().toLowerCase();
    if (type.startsWith('image/')) {
      return { finalUrl: document.finalUrl, page: { title: null, description: null, image: document.finalUrl, siteName: null } };
    }
    if (type !== 'text/html' && type !== 'application/xhtml+xml') throw new LinkPreviewError('Not a web page', 'PREVIEW_NOT_HTML');
    const charset = /charset=([^;]+)/i.exec(document.contentType)?.[1]?.trim().replace(/^"|"$/g, '') ?? 'utf-8';
    let html: string;
    try {
      html = new TextDecoder(charset).decode(document.body);
    } catch {
      html = document.body.toString('utf8');
    }
    return { finalUrl: document.finalUrl, page: parsePage(html, document.finalUrl) };
  }

  private remember(url: string, finalUrl: string | null, page: ParsedPage | null, now: number): LinkPreviewRecord {
    const record: LinkPreviewRecord = {
      url,
      finalUrl,
      title: page?.title ?? null,
      description: page?.description ?? null,
      image: page?.image ?? null,
      siteName: page?.siteName ?? null,
      ok: page !== null,
      fetchedAt: now,
    };
    this.stmts.upsert.run({
      url: record.url,
      final_url: record.finalUrl,
      title: record.title,
      description: record.description,
      image: record.image,
      site_name: record.siteName,
      ok: record.ok ? 1 : 0,
      fetched_at: record.fetchedAt,
    });
    return record;
  }

  /** Drop cached previews no message refers to any more (older than a week). */
  purgeStale(now = Date.now()): number {
    return this.stmts.purge.run(now - 7 * 24 * 60 * 60 * 1000).changes;
  }

  // ---------------------------------------------------------------- transport

  /** Resolve a host and keep only addresses that pass the filter. Literal IPs are checked as they are. */
  async resolveAllowed(hostname: string): Promise<string[]> {
    if (isLocalHostname(hostname)) throw new LinkPreviewError('Local addresses are not previewed', 'PREVIEW_ADDRESS_BLOCKED');
    const bare = hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(bare) ? [bare] : await this.lookup(bare).catch(() => [] as string[]);
    const allowed = addresses.filter((address) => this.isAllowedAddress(address));
    if (allowed.length === 0) throw new LinkPreviewError('The address is not public', 'PREVIEW_ADDRESS_BLOCKED');
    return allowed;
  }

  /** GET the URL over http(s), following up to three redirects, each hop address-checked. */
  private async download(startUrl: string): Promise<FetchedDocument> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let current = new URL(startUrl);
      for (let hop = 0; ; hop += 1) {
        if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new LinkPreviewError('Unsupported scheme', 'PREVIEW_SCHEME');
        const addresses = await this.resolveAllowed(current.hostname);
        const response = await this.requestOnce(current, addresses, controller.signal);
        if (response.status >= 300 && response.status < 400 && response.location) {
          if (hop >= MAX_REDIRECTS) throw new LinkPreviewError('Too many redirects', 'PREVIEW_REDIRECTS');
          current = new URL(response.location, current);
          continue;
        }
        if (response.status !== 200) throw new LinkPreviewError('The page answered ' + response.status, 'PREVIEW_STATUS');
        return { finalUrl: current.href, contentType: response.contentType, body: response.body };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private requestOnce(
    url: URL,
    addresses: string[],
    signal: AbortSignal,
  ): Promise<{ status: number; location: string | null; contentType: string; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      // Connect to the address we checked: a DNS answer that changes between check and connect gains nothing.
      const lookup = (_hostname: string, options: { all?: boolean } | number, callback: (...args: unknown[]) => void) => {
        const chosen = addresses[0];
        const family = isIP(chosen);
        if (typeof options === 'object' && options.all) callback(null, [{ address: chosen, family }]);
        else callback(null, chosen, family);
      };
      const request = transport.request(
        url,
        {
          method: 'GET',
          signal,
          lookup: lookup as unknown as http.RequestOptions['lookup'],
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.5,*/*;q=0.1',
            'accept-language': 'en',
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = typeof response.headers.location === 'string' ? response.headers.location : null;
          const contentType = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : '';
          if (status >= 300 && status < 400) {
            response.resume();
            resolve({ status, location, contentType, body: Buffer.alloc(0) });
            return;
          }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > this.maxBytes && !contentType.toLowerCase().startsWith('text/html')) {
            response.destroy();
            reject(new LinkPreviewError('The page is too large', 'PREVIEW_TOO_LARGE'));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > this.maxBytes) {
              // The interesting tags are at the top of the page: keep what we have.
              chunks.push(chunk.subarray(0, chunk.length - (received - this.maxBytes)));
              response.destroy();
              resolve({ status, location, contentType, body: Buffer.concat(chunks) });
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => resolve({ status, location, contentType, body: Buffer.concat(chunks) }));
          response.on('error', (error) => reject(error));
        },
      );
      request.on('error', (error: Error & { code?: string }) => {
        if (signal.aborted) reject(new LinkPreviewError('The page took too long', 'PREVIEW_TIMEOUT'));
        else reject(new LinkPreviewError(error.message, 'PREVIEW_NETWORK'));
      });
      request.end();
    });
  }
}
