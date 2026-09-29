// The persisted-storage allowlist (DESIGN section 3) and tolerant parsers.
// Any key or field not listed here is not part of the data contract: parsers
// drop it, the retention sweep deletes unknown keys, and tests fail on it.
import { isValidHost } from './domain';
import { isDayKey } from './time';
import type { DayEntry, DomainDay, FocusWindow, HostMeta, RetentionDays, Settings } from './types';
import { RETENTION_OPTIONS } from './types';

export const SETTINGS_KEY = 'settings';
export const SESSION_WINDOW_KEY = 'win';
export const DAY_PREFIX = 'd:';
export const HOST_PREFIX = 'h:';

export const DAY_ENTRY_FIELDS = ['focusedS', 'attendedS', 'hours', 'loginHint'] as const;
export const HOST_META_FIELDS = ['firstDay', 'lastDay', 'status', 'userAppId', 'userName', 'userCategory'] as const;
export const SETTINGS_FIELDS = ['retentionDays', 'paused', 'ignoreRegistrable', 'schemaVersion'] as const;
export const WINDOW_FIELDS = ['tabId', 'host', 'startMs', 'idleState', 'loginHint', 'hourKey', 'hourS'] as const;

export const USER_TEXT_MAX = 80;

export const DEFAULT_SETTINGS: Settings = {
  retentionDays: 90,
  paused: false,
  ignoreRegistrable: [],
  schemaVersion: 1,
};

export type StoredKeyKind = 'day' | 'host' | 'settings';

/** Classify a chrome.storage.local key, or null if it is outside the contract. */
export function classifyLocalKey(key: string): StoredKeyKind | null {
  if (key === SETTINGS_KEY) return 'settings';
  if (key.startsWith(DAY_PREFIX) && isDayKey(key.slice(DAY_PREFIX.length))) return 'day';
  if (key.startsWith(HOST_PREFIX) && isValidHost(key.slice(HOST_PREFIX.length))) return 'host';
  return null;
}

export function dayStorageKey(day: string): string {
  return `${DAY_PREFIX}${day}`;
}

export function hostStorageKey(host: string): string {
  return `${HOST_PREFIX}${host}`;
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function cleanUserText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Collapse control characters and whitespace runs; cap length.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, USER_TEXT_MAX);
  return s.length > 0 ? s : undefined;
}

export function parseDayEntry(v: unknown): DayEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    focusedS: nonNegInt(o.focusedS),
    attendedS: nonNegInt(o.attendedS),
    hours: nonNegInt(o.hours) & 0xffffff,
    loginHint: o.loginHint === 1 ? 1 : 0,
  };
}

export function parseDomainDay(v: unknown): DomainDay {
  const out: DomainDay = {};
  if (!v || typeof v !== 'object') return out;
  for (const [host, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!isValidHost(host)) continue;
    const parsed = parseDayEntry(entry);
    if (parsed) out[host] = parsed;
  }
  return out;
}

export function parseHostMeta(v: unknown): HostMeta | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const status = o.status === 'accepted' || o.status === 'ignored' ? o.status : 'auto';
  const meta: HostMeta = { status };
  if (isDayKey(o.firstDay)) meta.firstDay = o.firstDay;
  if (isDayKey(o.lastDay)) meta.lastDay = o.lastDay;
  const appId = typeof o.userAppId === 'string' && /^[a-z0-9-]{1,64}$/.test(o.userAppId) ? o.userAppId : undefined;
  const name = cleanUserText(o.userName);
  const category = cleanUserText(o.userCategory);
  if (appId) meta.userAppId = appId;
  if (name) meta.userName = name;
  if (category) meta.userCategory = category;
  return meta;
}

export function isRetention(v: unknown): v is RetentionDays {
  return typeof v === 'number' && (RETENTION_OPTIONS as readonly number[]).includes(v);
}

export function parseSettings(v: unknown): Settings {
  if (!v || typeof v !== 'object') return { ...DEFAULT_SETTINGS, ignoreRegistrable: [] };
  const o = v as Record<string, unknown>;
  const ignore = Array.isArray(o.ignoreRegistrable)
    ? [...new Set(o.ignoreRegistrable.filter(isValidHost).map((h) => h.toLowerCase()))].sort()
    : [];
  return {
    retentionDays: isRetention(o.retentionDays) ? o.retentionDays : DEFAULT_SETTINGS.retentionDays,
    paused: o.paused === true,
    ignoreRegistrable: ignore,
    schemaVersion: 1,
  };
}

export function parseWindow(v: unknown): FocusWindow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isValidHost(o.host) || typeof o.startMs !== 'number' || !Number.isFinite(o.startMs)) return null;
  return {
    tabId: typeof o.tabId === 'number' ? o.tabId : null,
    host: o.host,
    startMs: o.startMs,
    idleState: o.idleState === 'idle' ? 'idle' : 'active',
    loginHint: o.loginHint === true,
    hourKey: typeof o.hourKey === 'string' ? o.hourKey : null,
    hourS: nonNegInt(o.hourS),
  };
}

/** Human-readable description of what is stored, rendered on the Data & privacy page. */
export const STORED_SCHEMA_DESCRIPTION: ReadonlyArray<{ key: string; fields: string }> = [
  { key: 'd:<YYYY-MM-DD>', fields: 'per hostname: focusedS, attendedS (integer seconds), hours (24-bit hour-of-day mask), loginHint (0/1)' },
  { key: 'h:<hostname>', fields: 'firstDay, lastDay (YYYY-MM-DD), status (auto/accepted/ignored), optional userAppId, userName, userCategory' },
  { key: 'settings', fields: 'retentionDays, paused, ignoreRegistrable[], schemaVersion' },
  { key: 'session: win', fields: 'the open focus window {tabId, host, startMs, idleState, loginHint, hourKey, hourS}; cleared on browser restart' },
];
