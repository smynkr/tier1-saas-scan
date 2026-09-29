// Origin: smynkr/axiomlayer-oss apps/browser-extension/src/lib/domain.ts (archived snapshot)
// (single-author file, see docs/DESIGN.md section 11). Changes: dropped getPathFromUrl, added
// host normalisation, exclusion rules, registrableDomain and the transient login hint.
//
// This is THE ONLY module allowed to parse a URL or look at a path (enforced by
// scripts/check-tier1.mjs). A URL enters here, and only a hostname plus one boolean leave.
// The path is tested in memory and never returned, stored or logged.

/**
 * Curated subset of multi-part public suffixes.
 *
 * The full Public Suffix List (publicsuffix.org) has thousands of
 * entries and changes over time; bundling it is disproportionate for Tier-1
 * grouping. This list covers the common country-code second-level domains
 * that would otherwise make the "registrable" label the suffix ("co", "com").
 */
const MULTI_PART_SUFFIXES = new Set<string>([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'gov.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.za', 'org.za', 'net.za',
  'com.mx', 'com.sg', 'com.hk', 'com.tr', 'co.kr', 'com.tw', 'co.il', 'com.ar',
]);

/** Host labels that suggest an auth surface (DESIGN section 3). */
const LOGIN_LABELS = new Set<string>(['login', 'auth', 'sso', 'accounts', 'id', 'signin']);
/** Path segments that suggest an auth surface. Tested transiently; only the boolean survives. */
const LOGIN_PATH = /\/(login|signin|sign-in|sso|oauth|saml)(\/|$)/i;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function parseWebUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function normaliseHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/** Strict bare-hostname check (no scheme, port, path, query, fragment, whitespace or userinfo). */
export function isValidHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (!HOST_SHAPE.test(value)) return false;
  if (value.includes('..')) return false;
  return value.split('.').every((label) => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
}

/**
 * Hosts that are never stored (DESIGN section 3): IP literals, single-label hosts,
 * localhost, and anything that is not a well-formed hostname.
 */
export function isExcludedHost(host: string): boolean {
  if (!host) return true;
  if (host.startsWith('[') || host.includes(':')) return true; // IPv6 literal
  if (IPV4.test(host)) return true;
  if (!host.includes('.')) return true; // single label, including "localhost"
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return !isValidHost(host);
}

/** Lowercased hostname of an http(s) URL, or null. Never a path, query or fragment. */
export function getDomainFromUrl(url: string | undefined): string | null {
  const parsed = parseWebUrl(url);
  return parsed ? normaliseHost(parsed.hostname) : null;
}

export interface Capture {
  host: string;
  loginHint: boolean;
}

/**
 * The capture boundary. Given a tab URL, return the hostname and a login-hint
 * boolean, or null if the URL must not be recorded at all. The URL object is a
 * local variable and is discarded when this function returns.
 */
export function captureFromUrl(url: string | undefined): Capture | null {
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  const host = normaliseHost(parsed.hostname);
  if (isExcludedHost(host)) return null;
  const registrable = registrableDomain(host);
  const subLabels = host === registrable ? [] : host.slice(0, host.length - registrable.length - 1).split('.');
  const loginHint = subLabels.some((label) => LOGIN_LABELS.has(label)) || LOGIN_PATH.test(parsed.pathname);
  return { host, loginHint };
}

/**
 * Registrable domain ("eTLD+1") using the curated multi-part suffix set:
 * acme.slack.com -> slack.com, team.foo.co.uk -> foo.co.uk.
 */
export function registrableDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

export function appNameFromDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length < 2) return domain;
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_SUFFIXES.has(lastTwo)) {
      return parts[parts.length - 3];
    }
  }
  return parts[parts.length - 2];
}
