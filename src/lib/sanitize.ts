// Origin: smynkr/axiomlayer-oss apps/browser-extension/src/lib/sanitize.ts (archived snapshot)
// (single-author file). Kept: sanitizeUrlToHost, isSafeHost. Dropped: path and login-event
// message builders (this tool has no content scripts and never keeps a path).
import { getDomainFromUrl, isValidHost } from './domain';

/** Bare host or null. Never a path, query string or fragment. */
export function sanitizeUrlToHost(url: string | undefined): string | null {
  return getDomainFromUrl(url);
}

/**
 * Defensive re-check on the receiving side (the service worker's message
 * handler): true only for a value that looks like a bare, well-formed host.
 */
export function isSafeHost(host: unknown): host is string {
  return typeof host === 'string' && host.length > 0 && !/[/?#\s@:]/.test(host) && isValidHost(host);
}
