// Fake browser environment for the real service handlers. The fake tab objects
// deliberately carry extra fields (title, favIconUrl) the service must ignore.
import { createService, type Env, type SystemIdleState } from '../src/lib/service';
import { MemoryStorage } from '../src/lib/storage';

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  title?: string;
  favIconUrl?: string;
}

export function makeHarness(startMs: number) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const tabs = new Map<number, FakeTab>();
  const state = { now: startMs, focusedWindow: 1 as number | null, idle: 'active' as SystemIdleState };
  const env: Env = {
    local,
    session,
    now: () => state.now,
    getTab: async (id) => {
      const t = tabs.get(id);
      if (!t) throw new Error('No tab with id');
      return t;
    },
    getActiveTab: async (windowId) => {
      const w = windowId ?? state.focusedWindow;
      if (w === null || w !== state.focusedWindow) return undefined;
      return [...tabs.values()].find((t) => t.windowId === w && t.active);
    },
    queryIdle: async () => state.idle,
  };
  const service = createService(env);

  /** Simulate the user activating a tab (as chrome would fire tabs.onActivated). */
  async function activate(id: number, url: string, extra: Partial<FakeTab> = {}) {
    for (const t of tabs.values()) if (t.windowId === (extra.windowId ?? 1)) t.active = false;
    tabs.set(id, { id, windowId: 1, url, active: true, ...extra });
    await service.onTabActivated(id);
  }
  async function navigate(id: number, url: string) {
    const t = tabs.get(id);
    if (!t) throw new Error('no tab');
    t.url = url;
    await service.onTabUpdated(id, url, t.active);
  }
  function advance(ms: number) {
    state.now += ms;
  }
  return { env, local, session, tabs, state, service, activate, navigate, advance };
}
