// Retention sweep and storage byte guard (DESIGN section 9).
import { classifyLocalKey, DAY_PREFIX, HOST_PREFIX, hostStorageKey, parseDomainDay, parseHostMeta } from './schema';
import type { KeyValueStorage } from './storage';
import { addDays } from './time';
import type { HostMeta } from './types';

/** Prune oldest days above this (Chrome's storage.local quota is 10 MB). */
export const BYTE_GUARD_LIMIT = 8 * 1024 * 1024;

export interface SweepResult {
  removedDays: number;
  removedHosts: number;
  removedUnknownKeys: number;
}

/**
 * Delete day records older than the retention window, host metadata with no
 * remaining days (accepted and ignored overrides are kept; they hold no browsing data), and any key outside the data
 * contract. Recomputes firstDay/lastDay from what remains.
 */
export async function sweepRetention(local: KeyValueStorage, today: string, retentionDays: number): Promise<SweepResult> {
  const all = await local.get(null);
  const cutoff = addDays(today, -(retentionDays - 1));
  const removeKeys: string[] = [];
  const hostDays = new Map<string, { first: string; last: string }>();
  let removedDays = 0;
  let removedUnknownKeys = 0;

  for (const [key, value] of Object.entries(all)) {
    const kind = classifyLocalKey(key);
    if (kind === null) {
      removeKeys.push(key);
      removedUnknownKeys++;
      continue;
    }
    if (kind !== 'day') continue;
    const day = key.slice(DAY_PREFIX.length);
    if (day < cutoff) {
      removeKeys.push(key);
      removedDays++;
      continue;
    }
    for (const host of Object.keys(parseDomainDay(value))) {
      const seen = hostDays.get(host);
      if (!seen) hostDays.set(host, { first: day, last: day });
      else {
        if (day < seen.first) seen.first = day;
        if (day > seen.last) seen.last = day;
      }
    }
  }

  const updates: Record<string, HostMeta> = {};
  let removedHosts = 0;
  for (const [key, value] of Object.entries(all)) {
    if (classifyLocalKey(key) !== 'host') continue;
    const host = key.slice(HOST_PREFIX.length);
    const meta = parseHostMeta(value);
    if (!meta) {
      removeKeys.push(key);
      continue;
    }
    const span = hostDays.get(host);
    if (!span) {
      if (meta.status === 'accepted' || meta.status === 'ignored') {
        const kept: HostMeta = { ...meta };
        delete kept.firstDay;
        delete kept.lastDay;
        updates[hostStorageKey(host)] = kept;
      } else {
        removeKeys.push(key);
        removedHosts++;
      }
      continue;
    }
    if (meta.firstDay !== span.first || meta.lastDay !== span.last) {
      updates[hostStorageKey(host)] = { ...meta, firstDay: span.first, lastDay: span.last };
    }
  }

  if (removeKeys.length) await local.remove(removeKeys);
  if (Object.keys(updates).length) await local.set(updates);
  return { removedDays, removedHosts, removedUnknownKeys };
}

/** If storage use exceeds the limit, delete the oldest day records until it does not. */
export async function enforceByteBudget(local: KeyValueStorage, limit = BYTE_GUARD_LIMIT): Promise<number> {
  let bytes = await local.getBytesInUse();
  if (bytes <= limit) return 0;
  const dayKeys = Object.keys(await local.get(null))
    .filter((k) => classifyLocalKey(k) === 'day')
    .sort();
  let removed = 0;
  while (bytes > limit && dayKeys.length > 0) {
    const oldest = dayKeys.shift() as string;
    await local.remove([oldest]);
    removed++;
    bytes = await local.getBytesInUse();
  }
  return removed;
}
