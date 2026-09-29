// Starting point: axiomlayer apps/browser-extension/src/lib/tracker.test.ts (single-author).
// Timezone is pinned to America/Los_Angeles by the npm test script (DST cases below).
import { describe, expect, it } from 'vitest';
import { splitByLocalHour } from '../src/lib/time';
import { applyFold, computeFold, MAX_SEGMENT_MS, openWindow } from '../src/lib/tracker';
import type { DomainDay, FocusWindow } from '../src/lib/types';

const at = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const T0 = at(2026, 9, 28, 10, 0);

function win(overrides: Partial<FocusWindow> = {}): FocusWindow {
  return { tabId: 1, host: 'app.notion.so', startMs: T0, idleState: 'active', loginHint: false, hourKey: null, hourS: 0, ...overrides };
}

function foldAll(w: FocusWindow, times: number[]): { days: Record<string, DomainDay>; w: FocusWindow } {
  const days: Record<string, DomainDay> = {};
  let cur = w;
  for (const t of times) {
    const { pieces, next } = computeFold(cur, t);
    applyFold(days, cur, pieces);
    cur = next;
  }
  return { days, w: cur };
}

describe('timezone pin', () => {
  it('runs in a DST zone', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
  });
});

describe('openWindow', () => {
  it('opens for web URLs and not for excluded ones', () => {
    expect(openWindow(1, 'https://app.notion.so/x?y', T0, 'active')).toMatchObject({ host: 'app.notion.so', startMs: T0, loginHint: false });
    expect(openWindow(1, 'chrome://settings', T0, 'active')).toBeNull();
    expect(openWindow(1, 'http://localhost:5173/', T0, 'active')).toBeNull();
  });
});

describe('computeFold / applyFold', () => {
  it('accumulates whole seconds of focused and attended time', () => {
    const { days } = foldAll(win(), [T0 + 30_500]);
    expect(days['2026-09-28']['app.notion.so']).toEqual({ focusedS: 30, attendedS: 30, hours: 0, loginHint: 0 });
  });

  it('keeps sub-second remainders in the window so repeated folds do not drift', () => {
    const times = Array.from({ length: 10 }, (_, i) => T0 + (i + 1) * 1_500);
    const { days } = foldAll(win(), times);
    expect(days['2026-09-28']['app.notion.so'].focusedS).toBe(15);
  });

  it('idle windows accrue focused but not attended time', () => {
    const { days } = foldAll(win({ idleState: 'idle' }), [T0 + 120_000]);
    expect(days['2026-09-28']['app.notion.so']).toMatchObject({ focusedS: 120, attendedS: 0 });
  });

  it('sets the hour bit only once 60 s accumulate in that local hour (across folds)', () => {
    const r1 = foldAll(win(), [T0 + 30_000]);
    expect(r1.days['2026-09-28']['app.notion.so'].hours).toBe(0);
    const r2 = foldAll(win(), [T0 + 30_000, T0 + 61_000]);
    expect(r2.days['2026-09-28']['app.notion.so'].hours).toBe(1 << 10);
  });

  it('splits a window that crosses local midnight across two days', () => {
    const start = at(2026, 9, 28, 23, 59, 0);
    const { days } = foldAll(win({ startMs: start }), [start + 3 * 60_000]);
    expect(days['2026-09-28']['app.notion.so'].focusedS).toBe(60);
    expect(days['2026-09-28']['app.notion.so'].hours).toBe(1 << 23);
    expect(days['2026-09-29']['app.notion.so'].focusedS).toBe(120);
    expect(days['2026-09-29']['app.notion.so'].hours).toBe(1 << 0);
  });

  it('records nothing for a negative elapsed (clock moved back) and restarts at now', () => {
    const { pieces, next } = computeFold(win(), T0 - 5_000);
    expect(pieces).toEqual([]);
    expect(next.startMs).toBe(T0 - 5_000);
  });

  it('records nothing for an elapsed over 2 h (sleep / clock jump)', () => {
    const { pieces, next } = computeFold(win(), T0 + MAX_SEGMENT_MS + 1);
    expect(pieces).toEqual([]);
    expect(next.startMs).toBe(T0 + MAX_SEGMENT_MS + 1);
  });

  it('resumes from the absolute startMs after service-worker teardown (no time lost)', () => {
    // The window object is all that survives in storage.session; fold it much later.
    const stored = JSON.parse(JSON.stringify(win())) as FocusWindow;
    const { days } = foldAll(stored, [T0 + 45 * 60_000]);
    expect(days['2026-09-28']['app.notion.so'].focusedS).toBe(45 * 60);
  });

  it('sets loginHint on the day entry when the window had one', () => {
    const { days } = foldAll(win({ loginHint: true }), [T0 + 5_000]);
    expect(days['2026-09-28']['app.notion.so'].loginHint).toBe(1);
  });
});

describe('DST', () => {
  it('spring-forward day: 01:30 -> 03:30 local is one real hour, split at the jump', () => {
    const start = at(2026, 3, 8, 1, 30);
    const end = start + 60 * 60_000;
    const pieces = splitByLocalHour(start, end);
    expect(pieces.reduce((n, p) => n + p.ms, 0)).toBe(60 * 60_000);
    expect(pieces.map((p) => p.hour)).toEqual([1, 3]);
    const { days } = foldAll(win({ startMs: start }), [end]);
    expect(days['2026-03-08']['app.notion.so'].focusedS).toBe(3600);
  });

  it('fall-back day: the repeated 01:00 hour still sums to real elapsed time', () => {
    const start = at(2026, 11, 1, 0, 30);
    const end = start + 2 * 60 * 60_000; // crosses the repeated 1 a.m. hour
    const pieces = splitByLocalHour(start, end);
    expect(pieces.reduce((n, p) => n + p.ms, 0)).toBe(2 * 60 * 60_000);
    const { days } = foldAll(win({ startMs: start }), [end]);
    expect(days['2026-11-01']['app.notion.so'].focusedS).toBe(7200);
  });
});
