// Service-worker logic, parameterised over an injected environment so the real
// handlers run under test against in-memory storage. background.ts only wires
// chrome.* events to these handlers. There is no network code anywhere.
import { registrableDomain } from './domain';
import { parseOverrides } from './overrides';
import { enforceByteBudget, sweepRetention } from './retention';
import { isSafeHost } from './sanitize';
import {
  cleanUserText,
  DAY_PREFIX,
  dayStorageKey,
  DEFAULT_SETTINGS,
  hostStorageKey,
  isRetention,
  parseDomainDay,
  parseHostMeta,
  parseSettings,
  parseWindow,
  SESSION_WINDOW_KEY,
  SETTINGS_KEY,
} from './schema';
import type { KeyValueStorage } from './storage';
import { dayKey } from './time';
import { applyFold, applyLoginHint, computeFold, openWindow } from './tracker';
import type { DomainDay, FocusWindow, HostMeta, Settings } from './types';

export const FLUSH_ALARM = 'flush';
export const RETENTION_ALARM = 'retention';
export const IDLE_DETECTION_S = 60;

/** Only the fields this extension reads from a tab. Never the title. */
export interface TabInfo {
  id?: number;
  url?: string;
  active?: boolean;
}

export type SystemIdleState = 'active' | 'idle' | 'locked';

export interface Env {
  local: KeyValueStorage;
  session: KeyValueStorage;
  now(): number;
  getTab(tabId: number): Promise<TabInfo | undefined>;
  /**
   * Active tab of the given window, or of the last-focused window when omitted.
   * Must return undefined when that browser window does not currently have OS focus.
   */
  getActiveTab(windowId?: number): Promise<TabInfo | undefined>;
  queryIdle(): Promise<SystemIdleState>;
}

export type Message =
  | { type: 'flush' }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'setRetention'; retentionDays: number }
  | { type: 'accept'; host: string; appId?: string; name?: string; category?: string }
  | { type: 'ignoreHost'; host: string }
  | { type: 'ignoreDomain'; registrable: string }
  | { type: 'unignoreDomain'; registrable: string }
  | { type: 'resetHost'; host: string }
  | { type: 'forgetHost'; host: string }
  | { type: 'clearAll' }
  | { type: 'importOverrides'; data: unknown };

export interface MessageResult {
  ok: boolean;
  error?: string;
}

function withSpan(prev: HostMeta, next: HostMeta): HostMeta {
  if (prev.firstDay) next.firstDay = prev.firstDay;
  if (prev.lastDay) next.lastDay = prev.lastDay;
  return next;
}

export function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function createService(env: Env) {
  const withLock = createLock();

  async function loadSettings(): Promise<Settings> {
    const r = await env.local.get([SETTINGS_KEY]);
    return parseSettings(r[SETTINGS_KEY]);
  }

  async function loadWin(): Promise<FocusWindow | null> {
    const r = await env.session.get([SESSION_WINDOW_KEY]);
    return parseWindow(r[SESSION_WINDOW_KEY]);
  }

  async function saveWin(win: FocusWindow | null): Promise<void> {
    if (win) await env.session.set({ [SESSION_WINDOW_KEY]: win });
    else await env.session.remove([SESSION_WINDOW_KEY]);
  }

  /** Persist day aggregates and first/last-day metadata for one host. */
  async function persist(host: string, days: Record<string, DomainDay>): Promise<void> {
    const dayKeys = Object.keys(days);
    if (dayKeys.length === 0) return;
    const hk = hostStorageKey(host);
    const current = await env.local.get([...dayKeys.map(dayStorageKey), hk]);
    const writes: Record<string, unknown> = {};
    for (const day of dayKeys) {
      const merged = parseDomainDay(current[dayStorageKey(day)]);
      const add = days[day][host];
      if (!add) continue;
      const e = (merged[host] ??= { focusedS: 0, attendedS: 0, hours: 0, loginHint: 0 });
      e.focusedS += add.focusedS;
      e.attendedS += add.attendedS;
      e.hours |= add.hours;
      if (add.loginHint) e.loginHint = 1;
      writes[dayStorageKey(day)] = merged;
    }
    const meta: HostMeta = parseHostMeta(current[hk]) ?? { status: 'auto' };
    const sorted = dayKeys.sort();
    if (!meta.firstDay || sorted[0] < meta.firstDay) meta.firstDay = sorted[0];
    if (!meta.lastDay || sorted[sorted.length - 1] > meta.lastDay) meta.lastDay = sorted[sorted.length - 1];
    writes[hk] = meta;
    await env.local.set(writes);
  }

  /** Fold elapsed time of the open window into storage; returns the advanced window. */
  async function foldOpen(now: number): Promise<FocusWindow | null> {
    const win = await loadWin();
    if (!win) return null;
    const { pieces, next } = computeFold(win, now);
    if (pieces.length) {
      const days: Record<string, DomainDay> = {};
      applyFold(days, win, pieces);
      await persist(win.host, days);
    }
    await saveWin(next);
    return next;
  }

  async function closeWindow(now: number): Promise<void> {
    await foldOpen(now);
    await saveWin(null);
  }

  async function startWindow(tabId: number | null, url: string | undefined, now: number): Promise<void> {
    await foldOpen(now);
    const settings = await loadSettings();
    if (settings.paused) {
      await saveWin(null);
      return;
    }
    const idle = await env.queryIdle().catch((): SystemIdleState => 'active');
    if (idle === 'locked') {
      await saveWin(null);
      return;
    }
    const win = openWindow(tabId, url, now, idle === 'idle' ? 'idle' : 'active');
    await saveWin(win);
    if (win?.loginHint) {
      const days: Record<string, DomainDay> = {};
      applyLoginHint(days, dayKey(now), win.host);
      await persist(win.host, days);
    }
  }

  async function resolveAndStart(windowId?: number): Promise<void> {
    const tab = await env.getActiveTab(windowId).catch(() => undefined);
    await startWindow(tab?.id ?? null, tab?.url, env.now());
  }

  async function runMaintenance(): Promise<void> {
    const settings = await loadSettings();
    await sweepRetention(env.local, dayKey(env.now()), settings.retentionDays);
    await enforceByteBudget(env.local);
  }

  async function mutateHostMeta(host: string, fn: (meta: HostMeta) => HostMeta): Promise<void> {
    const hk = hostStorageKey(host);
    const r = await env.local.get([hk]);
    const meta = parseHostMeta(r[hk]) ?? { status: 'auto' };
    await env.local.set({ [hk]: fn(meta) });
  }

  async function saveSettings(s: Settings): Promise<void> {
    await env.local.set({ [SETTINGS_KEY]: s });
  }

  async function forgetHost(host: string): Promise<void> {
    const all = await env.local.get(null);
    const writes: Record<string, unknown> = {};
    const empty: string[] = [hostStorageKey(host)];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(DAY_PREFIX)) continue;
      const day = parseDomainDay(value);
      if (!(host in day)) continue;
      delete day[host];
      if (Object.keys(day).length) writes[key] = day;
      else empty.push(key);
    }
    if (Object.keys(writes).length) await env.local.set(writes);
    await env.local.remove(empty);
    const win = await loadWin();
    if (win?.host === host) await saveWin(null);
  }

  async function clearAll(): Promise<void> {
    const settings = await loadSettings();
    await env.session.remove([SESSION_WINDOW_KEY]);
    await env.local.clear();
    await saveSettings({ ...DEFAULT_SETTINGS, retentionDays: settings.retentionDays, paused: settings.paused, ignoreRegistrable: [] });
  }

  async function handle(msg: Message): Promise<MessageResult> {
    const now = env.now();
    switch (msg.type) {
      case 'flush':
        await foldOpen(now);
        return { ok: true };
      case 'setPaused': {
        if (typeof msg.paused !== 'boolean') return { ok: false, error: 'bad paused' };
        const s = await loadSettings();
        await saveSettings({ ...s, paused: msg.paused });
        if (msg.paused) await closeWindow(now);
        return { ok: true };
      }
      case 'setRetention': {
        if (!isRetention(msg.retentionDays)) return { ok: false, error: 'bad retention' };
        const s = await loadSettings();
        await saveSettings({ ...s, retentionDays: msg.retentionDays });
        await sweepRetention(env.local, dayKey(now), msg.retentionDays);
        return { ok: true };
      }
      case 'accept': {
        if (!isSafeHost(msg.host)) return { ok: false, error: 'bad host' };
        const appId = typeof msg.appId === 'string' && /^[a-z0-9-]{1,64}$/.test(msg.appId) ? msg.appId : undefined;
        const name = cleanUserText(msg.name);
        const category = cleanUserText(msg.category);
        if (!appId && !name) return { ok: false, error: 'need appId or name' };
        await mutateHostMeta(msg.host, (m) => {
          const next = withSpan(m, { status: 'accepted' });
          if (appId) next.userAppId = appId;
          else {
            next.userName = name;
            next.userCategory = category ?? 'Other';
          }
          return next;
        });
        return { ok: true };
      }
      case 'ignoreHost':
        if (!isSafeHost(msg.host)) return { ok: false, error: 'bad host' };
        await mutateHostMeta(msg.host, (m) => withSpan(m, { status: 'ignored' }));
        return { ok: true };
      case 'resetHost':
        if (!isSafeHost(msg.host)) return { ok: false, error: 'bad host' };
        await mutateHostMeta(msg.host, (m) => withSpan(m, { status: 'auto' }));
        return { ok: true };
      case 'ignoreDomain':
      case 'unignoreDomain': {
        if (!isSafeHost(msg.registrable) || registrableDomain(msg.registrable) !== msg.registrable) {
          return { ok: false, error: 'bad registrable domain' };
        }
        const s = await loadSettings();
        const set = new Set(s.ignoreRegistrable);
        if (msg.type === 'ignoreDomain') set.add(msg.registrable);
        else set.delete(msg.registrable);
        await saveSettings({ ...s, ignoreRegistrable: [...set].sort() });
        return { ok: true };
      }
      case 'forgetHost':
        if (!isSafeHost(msg.host)) return { ok: false, error: 'bad host' };
        await forgetHost(msg.host);
        return { ok: true };
      case 'clearAll':
        await clearAll();
        return { ok: true };
      case 'importOverrides': {
        const parsed = parseOverrides(msg.data);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const keys = parsed.overrides.map((o) => hostStorageKey(o.host));
        const current = await env.local.get(keys);
        const writes: Record<string, unknown> = {};
        for (const o of parsed.overrides) {
          const prev = parseHostMeta(current[hostStorageKey(o.host)]) ?? { status: 'auto' };
          writes[hostStorageKey(o.host)] = withSpan(prev, { ...o.meta });
        }
        const s = await loadSettings();
        writes[SETTINGS_KEY] = { ...s, ignoreRegistrable: [...new Set([...s.ignoreRegistrable, ...parsed.ignoreRegistrable])].sort() };
        await env.local.set(writes);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  }

  return {
    onTabActivated: (tabId: number) =>
      withLock(async () => {
        const tab = await env.getTab(tabId).catch(() => undefined);
        await startWindow(tab?.id ?? null, tab?.url, env.now());
      }),
    onTabUpdated: (tabId: number, url: string | undefined, active: boolean) =>
      withLock(async () => {
        if (!url || !active) return;
        const win = await loadWin();
        // Only the tracked tab's own navigation restarts the window.
        if (win && win.tabId !== tabId) return;
        if (!win) {
          // No open window (non-web page, paused, or browser not focused): only start
          // if this tab really is the active tab of the focused browser window.
          const focused = await env.getActiveTab().catch(() => undefined);
          if (focused?.id !== tabId) return;
        }
        await startWindow(tabId, url, env.now());
      }),
    onTabRemoved: (tabId: number) =>
      withLock(async () => {
        const win = await loadWin();
        if (win && win.tabId === tabId) await closeWindow(env.now());
      }),
    /** windowId null = focus left the browser. */
    onWindowFocusChanged: (windowId: number | null) =>
      withLock(async () => {
        if (windowId === null) await closeWindow(env.now());
        else await resolveAndStart(windowId);
      }),
    onIdleStateChanged: (state: SystemIdleState) =>
      withLock(async () => {
        const now = env.now();
        if (state === 'locked') {
          await closeWindow(now);
          return;
        }
        const win = await foldOpen(now);
        if (win) await saveWin({ ...win, idleState: state === 'idle' ? 'idle' : 'active' });
        else if (state === 'active') await resolveAndStart();
      }),
    onAlarm: (name: string) =>
      withLock(async () => {
        if (name === FLUSH_ALARM) {
          await foldOpen(env.now());
          await enforceByteBudget(env.local);
        } else if (name === RETENTION_ALARM) {
          await foldOpen(env.now());
          await runMaintenance();
        }
      }),
    onStartup: () =>
      withLock(async () => {
        await runMaintenance();
        await resolveAndStart();
      }),
    onInstalled: () =>
      withLock(async () => {
        const r = await env.local.get([SETTINGS_KEY]);
        await saveSettings(parseSettings(r[SETTINGS_KEY]));
        await runMaintenance();
        await resolveAndStart();
      }),
    handleMessage: (msg: Message) => withLock(() => handle(msg)),
  };
}

export type Service = ReturnType<typeof createService>;

/** Structural check on an incoming runtime message before it reaches handle(). */
export function isMessage(v: unknown): v is Message {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  return (
    typeof t === 'string' &&
    [
      'flush', 'setPaused', 'setRetention', 'accept', 'ignoreHost', 'ignoreDomain', 'unignoreDomain',
      'resetHost', 'forgetHost', 'clearAll', 'importOverrides',
    ].includes(t)
  );
}

