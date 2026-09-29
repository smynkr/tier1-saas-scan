// Report model: aggregate stored day records over a range, resolve hosts to apps
// (user overrides, then the catalog), and surface unknown-host candidates.
import { AI_CATEGORY, type Matcher } from './catalog';
import { registrableDomain } from './domain';
import { classifyLocalKey, DAY_PREFIX, HOST_PREFIX, parseDomainDay, parseHostMeta, parseSettings, SETTINGS_KEY } from './schema';
import { addDays } from './time';
import type { HostMeta } from './types';

export type RangeOption = 7 | 30 | 90 | 'all';
export type CandidateReason = 'login' | 'repeat' | 'tenant';

/** Candidate thresholds (DESIGN section 6). */
export const REPEAT_MIN_DAYS = 3;
export const REPEAT_MIN_ATTENDED_S = 10 * 60;

export interface HostAgg {
  host: string;
  registrable: string;
  days: Set<string>;
  firstSeen: string;
  lastSeen: string;
  focusedS: number;
  attendedS: number;
  loginHint: boolean;
}

export interface AppRow {
  key: string;
  name: string;
  category: string;
  subcategory?: string;
  source: 'catalog' | 'user';
  hosts: string[];
  firstSeen: string;
  lastSeen: string;
  daysActive: number;
  attendedS: number;
  focusedS: number;
  loginHint: boolean;
}

export interface CandidateRow {
  host: string;
  registrable: string;
  reasons: CandidateReason[];
  firstSeen: string;
  lastSeen: string;
  daysActive: number;
  attendedS: number;
  focusedS: number;
}

export interface Report {
  range: { option: RangeOption; from: string | null; to: string };
  ai: AppRow[];
  known: AppRow[];
  candidates: CandidateRow[];
  /** Index h = number of days in range with any host focused >= 60 s in local hour h. */
  hourHistogram: number[];
  daysWithData: number;
  catalogVersion: string;
}

interface ResolvedApp {
  key: string;
  name: string;
  category: string;
  subcategory?: string;
  source: 'catalog' | 'user';
}

function resolveHost(host: string, meta: HostMeta | undefined, matcher: Matcher): ResolvedApp | null {
  if (meta?.status === 'accepted') {
    if (meta.userAppId) {
      const app = matcher.byId.get(meta.userAppId);
      if (app) return { key: app.id, name: app.name, category: app.category, subcategory: app.subcategory, source: 'catalog' };
    }
    if (meta.userName) {
      return { key: `user:${meta.userName.toLowerCase()}`, name: meta.userName, category: meta.userCategory ?? 'Other', source: 'user' };
    }
  }
  const app = matcher.match(host);
  return app ? { key: app.id, name: app.name, category: app.category, subcategory: app.subcategory, source: 'catalog' } : null;
}

/**
 * Per-user tunnel, proxy and preview-deploy hosts. Their subdomains can themselves identify a
 * person or project, so they are never surfaced as candidates.
 */
export const EPHEMERAL_HOST_SUFFIXES: readonly string[] = [
  'ngrok-free.app', 'ngrok-free.dev', 'ngrok.app', 'ngrok.io', 'ngrok.dev',
  'translate.goog',
  'vercel.app', 'netlify.app', 'pages.dev', 'onrender.com', 'fly.dev', 'herokuapp.com', 'github.dev', 'gitpod.io',
];

export function isEphemeralHost(host: string): boolean {
  return EPHEMERAL_HOST_SUFFIXES.some((sfx) => host === sfx || host.endsWith(`.${sfx}`));
}

export function buildReport(
  snapshot: Record<string, unknown>,
  matcher: Matcher,
  suppression: ReadonlySet<string>,
  opts: { today: string; range: RangeOption },
): Report {
  const from = opts.range === 'all' ? null : addDays(opts.today, -(opts.range - 1));
  const settings = parseSettings(snapshot[SETTINGS_KEY]);
  const ignoredRegistrable = new Set(settings.ignoreRegistrable);
  const metas = new Map<string, HostMeta>();
  const hosts = new Map<string, HostAgg>();
  const hourByDay = new Map<string, number>();

  for (const [key, value] of Object.entries(snapshot)) {
    const kind = classifyLocalKey(key);
    if (kind === 'host') {
      const meta = parseHostMeta(value);
      if (meta) metas.set(key.slice(HOST_PREFIX.length), meta);
    }
    if (kind !== 'day') continue;
    const day = key.slice(DAY_PREFIX.length);
    if ((from && day < from) || day > opts.today) continue;
    for (const [host, e] of Object.entries(parseDomainDay(value))) {
      if (e.focusedS === 0 && e.loginHint === 0) continue;
      hourByDay.set(day, (hourByDay.get(day) ?? 0) | e.hours);
      let agg = hosts.get(host);
      if (!agg) {
        agg = { host, registrable: registrableDomain(host), days: new Set(), firstSeen: day, lastSeen: day, focusedS: 0, attendedS: 0, loginHint: false };
        hosts.set(host, agg);
      }
      if (e.focusedS > 0) agg.days.add(day);
      if (day < agg.firstSeen) agg.firstSeen = day;
      if (day > agg.lastSeen) agg.lastSeen = day;
      agg.focusedS += e.focusedS;
      agg.attendedS += e.attendedS;
      if (e.loginHint) agg.loginHint = true;
    }
  }

  const apps = new Map<string, AppRow & { daySet: Set<string> }>();
  const unmatched: HostAgg[] = [];
  const registrableWithHit = new Set<string>();

  for (const agg of hosts.values()) {
    const resolved = resolveHost(agg.host, metas.get(agg.host), matcher);
    if (!resolved) {
      unmatched.push(agg);
      continue;
    }
    registrableWithHit.add(agg.registrable);
    let row = apps.get(resolved.key);
    if (!row) {
      row = { ...resolved, hosts: [], firstSeen: agg.firstSeen, lastSeen: agg.lastSeen, daysActive: 0, attendedS: 0, focusedS: 0, loginHint: false, daySet: new Set() };
      apps.set(resolved.key, row);
    }
    row.hosts.push(agg.host);
    for (const d of agg.days) row.daySet.add(d);
    if (agg.firstSeen < row.firstSeen) row.firstSeen = agg.firstSeen;
    if (agg.lastSeen > row.lastSeen) row.lastSeen = agg.lastSeen;
    row.attendedS += agg.attendedS;
    row.focusedS += agg.focusedS;
    if (agg.loginHint) row.loginHint = true;
  }

  // Candidates: unmatched, not suppressed, not ignored, and at least one signal.
  const eligible = unmatched.filter((a) => {
    const meta = metas.get(a.host);
    if (meta?.status === 'ignored') return false;
    if (ignoredRegistrable.has(a.registrable)) return false;
    if (suppression.has(a.registrable) || suppression.has(a.host)) return false;
    if (isEphemeralHost(a.host)) return false;
    return true;
  });
  const strong = new Map<string, CandidateReason[]>();
  for (const a of eligible) {
    const reasons: CandidateReason[] = [];
    if (a.loginHint) reasons.push('login');
    if (a.days.size >= REPEAT_MIN_DAYS || a.attendedS >= REPEAT_MIN_ATTENDED_S) reasons.push('repeat');
    if (reasons.length) strong.set(a.host, reasons);
  }
  const registrableWithCandidate = new Map<string, Set<string>>();
  for (const host of strong.keys()) {
    const r = registrableDomain(host);
    if (!registrableWithCandidate.has(r)) registrableWithCandidate.set(r, new Set());
    registrableWithCandidate.get(r)?.add(host);
  }
  const candidates: CandidateRow[] = [];
  for (const a of eligible) {
    const reasons = [...(strong.get(a.host) ?? [])];
    if (a.host !== a.registrable) {
      const others = [...(registrableWithCandidate.get(a.registrable) ?? [])].filter((h) => h !== a.host);
      if (others.length > 0 || registrableWithHit.has(a.registrable)) reasons.push('tenant');
    }
    if (!reasons.length) continue;
    candidates.push({
      host: a.host,
      registrable: a.registrable,
      reasons,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
      daysActive: a.days.size,
      attendedS: a.attendedS,
      focusedS: a.focusedS,
    });
  }
  const rank = (c: CandidateRow) => (c.reasons.includes('login') ? 0 : c.reasons.includes('repeat') ? 1 : 2);
  candidates.sort((x, y) => rank(x) - rank(y) || y.attendedS - x.attendedS || (x.host < y.host ? -1 : 1));

  const rows: AppRow[] = [...apps.values()].map(({ daySet, ...row }) => ({ ...row, hosts: row.hosts.sort(), daysActive: daySet.size }));
  const byTime = (x: AppRow, y: AppRow) => y.attendedS - x.attendedS || y.focusedS - x.focusedS || (x.name < y.name ? -1 : 1);
  const ai = rows.filter((r) => r.category === AI_CATEGORY).sort(byTime);
  const known = rows.filter((r) => r.category !== AI_CATEGORY).sort((x, y) => (x.category < y.category ? -1 : x.category > y.category ? 1 : byTime(x, y)));

  const hourHistogram = new Array<number>(24).fill(0);
  for (const mask of hourByDay.values()) for (let h = 0; h < 24; h++) if (mask & (1 << h)) hourHistogram[h]++;

  return {
    range: { option: opts.range, from, to: opts.today },
    ai,
    known,
    candidates,
    hourHistogram,
    daysWithData: hourByDay.size,
    catalogVersion: matcher.catalog.catalogVersion,
  };
}

export function formatHours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}
