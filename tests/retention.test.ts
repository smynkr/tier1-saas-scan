import { describe, expect, it } from 'vitest';
import { enforceByteBudget, sweepRetention } from '../src/lib/retention';
import { MemoryStorage } from '../src/lib/storage';

const entry = { focusedS: 60, attendedS: 60, hours: 0, loginHint: 0 };

async function seed() {
  const s = new MemoryStorage();
  await s.set({
    'd:2026-06-01': { 'old.example.com': entry, 'both.example.com': entry },
    'd:2026-07-01': { 'both.example.com': entry },
    'd:2026-09-28': { 'both.example.com': entry, 'new.example.com': entry },
    'h:old.example.com': { status: 'auto', firstDay: '2026-06-01', lastDay: '2026-06-01' },
    'h:both.example.com': { status: 'auto', firstDay: '2026-06-01', lastDay: '2026-09-28' },
    'h:new.example.com': { status: 'auto', firstDay: '2026-09-28', lastDay: '2026-09-28' },
    'h:kept.example.com': { status: 'accepted', userName: 'Kept', firstDay: '2026-06-01', lastDay: '2026-06-01' },
    'h:ignored.example.com': { status: 'ignored', firstDay: '2026-06-01', lastDay: '2026-06-01' },
    settings: { retentionDays: 90, paused: false, ignoreRegistrable: [], schemaVersion: 1 },
    'legacy-queue': [{ url: 'https://x.example.com/secret' }],
  });
  return s;
}

describe('sweepRetention', () => {
  it('drops days outside the window, orphaned host rows and unknown keys; keeps accepted and ignored overrides', async () => {
    const s = await seed();
    const r = await sweepRetention(s, '2026-09-28', 90);
    expect(r).toEqual({ removedDays: 1, removedHosts: 1, removedUnknownKeys: 1 });
    expect(s.keys().sort()).toEqual(['d:2026-07-01', 'd:2026-09-28', 'h:both.example.com', 'h:ignored.example.com', 'h:kept.example.com', 'h:new.example.com', 'settings']);
    expect((await s.get(['h:both.example.com']))['h:both.example.com']).toEqual({ status: 'auto', firstDay: '2026-07-01', lastDay: '2026-09-28' });
    expect((await s.get(['h:kept.example.com']))['h:kept.example.com']).toEqual({ status: 'accepted', userName: 'Kept' });
    expect((await s.get(['h:ignored.example.com']))['h:ignored.example.com']).toEqual({ status: 'ignored' });
  });

  it('the window is inclusive of today (30 days = today and the 29 before)', async () => {
    const s = new MemoryStorage();
    await s.set({ 'd:2026-08-30': { 'a.example.com': entry }, 'd:2026-08-29': { 'a.example.com': entry } });
    await sweepRetention(s, '2026-09-28', 30);
    expect(s.keys()).toEqual(['d:2026-08-30']);
  });
});

describe('enforceByteBudget', () => {
  it('prunes oldest days first until under the limit', async () => {
    const s = new MemoryStorage();
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`host${i}.example.com`, entry]));
    await s.set({ 'd:2026-09-01': big, 'd:2026-09-02': big, 'd:2026-09-03': big, settings: {} });
    const per = (await s.getBytesInUse()) / 3;
    const removed = await enforceByteBudget(s, Math.floor(per * 1.5));
    expect(removed).toBe(2);
    expect(s.keys().sort()).toEqual(['d:2026-09-03', 'settings']);
  });
  it('does nothing when under the limit', async () => {
    const s = await seed();
    expect(await enforceByteBudget(s)).toBe(0);
  });
});
