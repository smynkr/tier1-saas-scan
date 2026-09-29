// Persisted and transient shapes. This file is the Tier-1 schema: scripts/check-tier1.mjs
// fails if any persisted interface gains a field outside the DESIGN section 3 allowlist.

/** One host's aggregate for one local day. Stored inside `d:<YYYY-MM-DD>` keyed by host. */
export interface DayEntry {
  focusedS: number;
  attendedS: number;
  /** 24-bit int: bit h set when at least 60 s were focused in local hour h. */
  hours: number;
  loginHint: 0 | 1;
}

/** `d:<YYYY-MM-DD>`: map host -> DayEntry. */
export type DomainDay = Record<string, DayEntry>;

export type HostStatus = 'auto' | 'accepted' | 'ignored';

/** `h:<host>`. firstDay/lastDay are absent only for imported overrides not yet observed. */
export interface HostMeta {
  firstDay?: string;
  lastDay?: string;
  status: HostStatus;
  userAppId?: string;
  userName?: string;
  userCategory?: string;
}

export const RETENTION_OPTIONS = [30, 90, 180, 365] as const;
export type RetentionDays = (typeof RETENTION_OPTIONS)[number];

/** `settings`. */
export interface Settings {
  retentionDays: RetentionDays;
  paused: boolean;
  ignoreRegistrable: string[];
  schemaVersion: 1;
}

export type IdleState = 'active' | 'idle';

/**
 * The open focus window, held only in chrome.storage.session (key `win`).
 * hourKey/hourS are a transient accumulator for the hour-of-day bit.
 */
export interface FocusWindow {
  tabId: number | null;
  host: string;
  startMs: number;
  idleState: IdleState;
  loginHint: boolean;
  hourKey: string | null;
  hourS: number;
}
