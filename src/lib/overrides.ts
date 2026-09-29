// Import/export of user overrides (accepted/ignored hosts and ignored registrable
// domains) as JSON, so a small team can share mappings by hand (DESIGN section 6).
// Contains mappings only: no times, no days.
import { registrableDomain } from './domain';
import { isSafeHost } from './sanitize';
import { classifyLocalKey, cleanUserText, HOST_PREFIX, parseHostMeta, parseSettings, SETTINGS_KEY } from './schema';
import type { HostMeta } from './types';

export const OVERRIDES_FORMAT = 'tier1-saas-scan-overrides';
export const MAX_OVERRIDES = 5000;

export interface OverrideRow {
  host: string;
  meta: HostMeta;
}

export interface OverridesFile {
  format: typeof OVERRIDES_FORMAT;
  version: 1;
  overrides: Array<{ host: string; status: 'accepted' | 'ignored'; userAppId?: string; userName?: string; userCategory?: string }>;
  ignoreRegistrable: string[];
}

export function exportOverrides(snapshot: Record<string, unknown>): OverridesFile {
  const overrides: OverridesFile['overrides'] = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (classifyLocalKey(key) !== 'host') continue;
    const meta = parseHostMeta(value);
    if (!meta || meta.status === 'auto') continue;
    const row: OverridesFile['overrides'][number] = { host: key.slice(HOST_PREFIX.length), status: meta.status };
    if (meta.userAppId) row.userAppId = meta.userAppId;
    if (meta.userName) row.userName = meta.userName;
    if (meta.userCategory) row.userCategory = meta.userCategory;
    overrides.push(row);
  }
  overrides.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return {
    format: OVERRIDES_FORMAT,
    version: 1,
    overrides,
    ignoreRegistrable: parseSettings(snapshot[SETTINGS_KEY]).ignoreRegistrable,
  };
}

export type ParsedOverrides =
  | { ok: true; overrides: OverrideRow[]; ignoreRegistrable: string[] }
  | { ok: false; error: string };

/** Strict parse of an imported overrides file. Rejects the whole file on any bad row. */
export function parseOverrides(input: unknown): ParsedOverrides {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'not an object' };
  const f = input as Record<string, unknown>;
  if (f.format !== OVERRIDES_FORMAT || f.version !== 1) return { ok: false, error: 'not a tier1-saas-scan overrides file' };
  if (!Array.isArray(f.overrides) || f.overrides.length > MAX_OVERRIDES) return { ok: false, error: 'bad overrides list' };
  const rows: OverrideRow[] = [];
  for (const raw of f.overrides) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad row' };
    const r = raw as Record<string, unknown>;
    const allowed = ['host', 'status', 'userAppId', 'userName', 'userCategory'];
    if (Object.keys(r).some((k) => !allowed.includes(k))) return { ok: false, error: 'unknown field in row' };
    if (!isSafeHost(r.host)) return { ok: false, error: 'bad host in row' };
    if (r.status !== 'accepted' && r.status !== 'ignored') return { ok: false, error: 'bad status in row' };
    const meta: HostMeta = { status: r.status };
    if (r.status === 'accepted') {
      if (typeof r.userAppId === 'string' && /^[a-z0-9-]{1,64}$/.test(r.userAppId)) meta.userAppId = r.userAppId;
      const name = cleanUserText(r.userName);
      const category = cleanUserText(r.userCategory);
      if (name) meta.userName = name;
      if (category) meta.userCategory = category;
      if (!meta.userAppId && !meta.userName) return { ok: false, error: 'accepted row needs userAppId or userName' };
    }
    rows.push({ host: r.host, meta });
  }
  const ignore = Array.isArray(f.ignoreRegistrable) ? f.ignoreRegistrable : [];
  const ignoreRegistrable: string[] = [];
  for (const d of ignore) {
    if (!isSafeHost(d) || registrableDomain(d) !== d) return { ok: false, error: 'bad ignoreRegistrable entry' };
    ignoreRegistrable.push(d);
  }
  return { ok: true, overrides: rows, ignoreRegistrable };
}
