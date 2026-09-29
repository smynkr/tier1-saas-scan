// MV3 service worker: wires chrome.* events to the pure service in lib/service.ts.
// Listeners are registered synchronously at top level so Chrome can wake the worker.
// This file must stay free of any network API (enforced by scripts/check-no-egress.mjs).
import { createService, FLUSH_ALARM, IDLE_DETECTION_S, isMessage, RETENTION_ALARM, type Env, type TabInfo } from './lib/service';
import type { KeyValueStorage } from './lib/storage';

function area(a: chrome.storage.StorageArea): KeyValueStorage {
  return {
    get: (keys) => a.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => a.set(items),
    remove: (keys) => a.remove(keys),
    clear: () => a.clear(),
    getBytesInUse: () => a.getBytesInUse(null),
  };
}

/** Copy only the three fields the service may see. Nothing else about the tab is read. */
function pick(tab: chrome.tabs.Tab | undefined): TabInfo | undefined {
  return tab ? { id: tab.id, url: tab.url, active: tab.active } : undefined;
}

const env: Env = {
  local: area(chrome.storage.local),
  session: area(chrome.storage.session),
  now: () => Date.now(),
  getTab: async (tabId) => pick(await chrome.tabs.get(tabId)),
  getActiveTab: async (windowId) => {
    const win = windowId === undefined ? await chrome.windows.getLastFocused() : await chrome.windows.get(windowId);
    if (!win.focused || win.id === undefined) return undefined;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return pick(tab);
  },
  queryIdle: () => chrome.idle.queryState(IDLE_DETECTION_S),
};

const service = createService(env);
const log = (e: unknown) => console.error('[saas-scan]', e);

chrome.tabs.onActivated.addListener(({ tabId }) => void service.onTabActivated(tabId).catch(log));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  void service.onTabUpdated(tabId, changeInfo.url, tab.active).catch(log);
});
chrome.tabs.onRemoved.addListener((tabId) => void service.onTabRemoved(tabId).catch(log));
chrome.windows.onFocusChanged.addListener((windowId) => {
  void service.onWindowFocusChanged(windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId).catch(log);
});
chrome.idle.setDetectionInterval(IDLE_DETECTION_S);
chrome.idle.onStateChanged.addListener((state) => void service.onIdleStateChanged(state).catch(log));
chrome.alarms.onAlarm.addListener((alarm) => void service.onAlarm(alarm.name).catch(log));

async function ensureAlarms(): Promise<void> {
  if (!(await chrome.alarms.get(FLUSH_ALARM))) await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  if (!(await chrome.alarms.get(RETENTION_ALARM))) await chrome.alarms.create(RETENTION_ALARM, { periodInMinutes: 24 * 60, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarms().then(() => service.onInstalled()).catch(log);
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarms().then(() => service.onStartup()).catch(log);
});

const OWN_ORIGIN = chrome.runtime.getURL('');
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only this extension's own pages may send commands (there are no content scripts).
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(OWN_ORIGIN) || !isMessage(message)) {
    sendResponse({ ok: false, error: 'rejected' });
    return false;
  }
  service
    .handleMessage(message)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
