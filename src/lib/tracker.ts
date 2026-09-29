// Origin: smynkr/axiomlayer-oss apps/browser-extension/src/lib/tracker.ts (archived snapshot)
// (single-author file). Reused: the absolute-start focus window folded on every transition
// (closeActiveWindow), so time survives service-worker teardown. Changed: attended time now
// comes from chrome.idle instead of content-script interaction; folds are split into local
// day/hour pieces and written to DomainDay aggregates instead of upload buckets.
import { captureFromUrl } from './domain';
import { splitByLocalHour } from './time';
import type { DomainDay, FocusWindow, IdleState } from './types';

/** A single fold longer than this is treated as a clock jump or sleep and recorded as nothing. */
export const MAX_SEGMENT_MS = 2 * 60 * 60 * 1000;
/** Minimum focused seconds in one local hour for that hour's bit to be set. */
export const HOUR_BIT_MIN_S = 60;

export interface FoldPiece {
  day: string;
  hour: number;
  seconds: number;
  setHourBit: boolean;
}

/** Open a window for a tab URL, or null if the URL must not be recorded. */
export function openWindow(
  tabId: number | null,
  url: string | undefined,
  now: number,
  idleState: IdleState,
): FocusWindow | null {
  const cap = captureFromUrl(url);
  if (!cap) return null;
  return { tabId, host: cap.host, startMs: now, idleState, loginHint: cap.loginHint, hourKey: null, hourS: 0 };
}

/**
 * Compute the whole seconds elapsed in the open window, split across local
 * day/hour boundaries, and return the advanced window. Pure. Because elapsed is
 * computed from the absolute startMs, a window resumed after service-worker
 * teardown loses nothing. Negative elapsed (clock moved back) or elapsed over
 * MAX_SEGMENT_MS (sleep, clock jump) is discarded and the window restarts at now.
 */
export function computeFold(win: FocusWindow, now: number): { pieces: FoldPiece[]; next: FocusWindow } {
  const elapsed = now - win.startMs;
  if (elapsed < 0 || elapsed > MAX_SEGMENT_MS) {
    return { pieces: [], next: { ...win, startMs: now, hourKey: null, hourS: 0 } };
  }
  const wholeS = Math.floor(elapsed / 1000);
  if (wholeS === 0) return { pieces: [], next: win };
  const end = win.startMs + wholeS * 1000;
  const raw = splitByLocalHour(win.startMs, end);

  let assigned = 0;
  let hourKey = win.hourKey;
  let hourS = win.hourS;
  const pieces: FoldPiece[] = [];
  raw.forEach((p, i) => {
    const s = i === raw.length - 1 ? Math.max(0, wholeS - assigned) : Math.round(p.ms / 1000);
    assigned += s;
    const key = `${p.day}|${p.hour}`;
    if (key === hourKey) hourS += s;
    else {
      hourKey = key;
      hourS = s;
    }
    if (s > 0) pieces.push({ day: p.day, hour: p.hour, seconds: s, setHourBit: hourS >= HOUR_BIT_MIN_S });
  });
  return { pieces, next: { ...win, startMs: end, hourKey, hourS } };
}

/** Apply fold pieces for one window to the loaded day maps (mutates `days`). */
export function applyFold(days: Record<string, DomainDay>, win: FocusWindow, pieces: FoldPiece[]): void {
  for (const p of pieces) {
    const day = (days[p.day] ??= {});
    const entry = (day[win.host] ??= { focusedS: 0, attendedS: 0, hours: 0, loginHint: 0 });
    entry.focusedS += p.seconds;
    if (win.idleState === 'active') entry.attendedS += p.seconds;
    if (p.setHourBit) entry.hours |= 1 << p.hour;
    if (win.loginHint) entry.loginHint = 1;
  }
}

/** Record a login hint for a host on a day even before any whole second has elapsed. */
export function applyLoginHint(days: Record<string, DomainDay>, day: string, host: string): void {
  const d = (days[day] ??= {});
  const entry = (d[host] ??= { focusedS: 0, attendedS: 0, hours: 0, loginHint: 0 });
  entry.loginHint = 1;
}
