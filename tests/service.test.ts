import { describe, expect, it } from 'vitest';
import { exportOverrides } from '../src/lib/overrides';
import { classifyLocalKey, SESSION_WINDOW_KEY } from '../src/lib/schema';
import { FLUSH_ALARM, isMessage } from '../src/lib/service';
import { makeHarness } from './helpers';

const T0 = new Date(2026, 8, 28, 10, 0, 0).getTime();
const DAY = 'd:2026-09-28';

async function day(h: ReturnType<typeof makeHarness>) {
  return ((await h.local.get([DAY]))[DAY] ?? {}) as Record<string, { focusedS: number; attendedS: number; hours: number; loginHint: number }>;
}

describe('capture via the real service handlers', () => {
  it('records focused + attended time per host on tab switches', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'https://acme.slack.com/client/T1/C2');
    h.advance(90_000);
    await h.activate(2, 'https://www.figma.com/file/abc');
    h.advance(30_000);
    await h.service.onWindowFocusChanged(null);
    const d = await day(h);
    expect(d['acme.slack.com']).toMatchObject({ focusedS: 90, attendedS: 90, hours: 1 << 10 });
    expect(d['www.figma.com']).toMatchObject({ focusedS: 30, attendedS: 30, hours: 0 });
    expect((await h.local.get(['h:acme.slack.com']))['h:acme.slack.com']).toEqual({ status: 'auto', firstDay: '2026-09-28', lastDay: '2026-09-28' });
  });

  it('stops accruing when the browser loses focus and resumes on refocus', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'https://app.notion.so/p');
    h.advance(10_000);
    h.state.focusedWindow = null;
    await h.service.onWindowFocusChanged(null);
    h.advance(600_000);
    await h.service.onAlarm(FLUSH_ALARM);
    h.state.focusedWindow = 1;
    await h.service.onWindowFocusChanged(1);
    h.advance(5_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect((await day(h))['app.notion.so'].focusedS).toBe(15);
  });

  it('the 1-minute flush alarm folds the open window without closing it', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'https://github.com/org/repo');
    h.advance(61_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect((await day(h))['github.com'].focusedS).toBe(61);
    expect((await h.session.get([SESSION_WINDOW_KEY]))[SESSION_WINDOW_KEY]).toMatchObject({ host: 'github.com' });
  });

  it('idle stops attended time but not focused time; locked closes the window', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'https://linear.app/team');
    h.advance(20_000);
    await h.service.onIdleStateChanged('idle');
    h.advance(40_000);
    await h.service.onIdleStateChanged('active');
    h.advance(10_000);
    await h.service.onIdleStateChanged('locked');
    h.advance(600_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect((await day(h))['linear.app']).toMatchObject({ focusedS: 70, attendedS: 30 });
    expect((await h.session.get([SESSION_WINDOW_KEY]))[SESSION_WINDOW_KEY]).toBeUndefined();
  });

  it('a new window opened while the system is idle starts as idle', async () => {
    const h = makeHarness(T0);
    h.state.idle = 'idle';
    await h.activate(1, 'https://linear.app/team');
    h.advance(30_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect((await day(h))['linear.app']).toMatchObject({ focusedS: 30, attendedS: 0 });
  });

  it('ignores navigation in a background tab and in an unfocused browser', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'https://github.com/');
    h.tabs.set(2, { id: 2, windowId: 1, url: 'https://x.com/', active: false });
    await h.navigate(2, 'https://mail.google.com/');
    h.advance(10_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect(Object.keys(await day(h))).toEqual(['github.com']);

    // Browser loses focus; the active tab navigates by itself (e.g. a redirect).
    h.state.focusedWindow = null;
    await h.service.onWindowFocusChanged(null);
    await h.navigate(1, 'https://chatgpt.com/');
    h.advance(10_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect((await day(h))['chatgpt.com']).toBeUndefined();
  });

  it('non-web and excluded pages record nothing', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'chrome://extensions');
    h.advance(10_000);
    await h.activate(2, 'http://localhost:3000/');
    h.advance(10_000);
    await h.activate(3, 'http://10.0.0.5/admin');
    h.advance(10_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect(h.local.keys().filter((k) => k !== 'settings')).toEqual([]);
  });

  it('records a login hint immediately, even for a sub-second SSO redirect', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'https://acme.newtool.io/sso/start');
    h.advance(300);
    await h.navigate(1, 'https://acme.newtool.io/home');
    const d = await day(h);
    expect(d['acme.newtool.io']).toMatchObject({ loginHint: 1, focusedS: 0 });
  });

  it('pause stops recording and closes the open window; resume restarts on next activation', async () => {
    const h = makeHarness(T0);
    await h.activate(1, 'https://github.com/');
    h.advance(10_000);
    expect(await h.service.handleMessage({ type: 'setPaused', paused: true })).toEqual({ ok: true });
    h.advance(60_000);
    await h.activate(2, 'https://figma.com/');
    h.advance(60_000);
    await h.service.onAlarm(FLUSH_ALARM);
    let d = await day(h);
    expect(d['github.com'].focusedS).toBe(10);
    expect(d['figma.com']).toBeUndefined();
    await h.service.handleMessage({ type: 'setPaused', paused: false });
    await h.activate(2, 'https://figma.com/');
    h.advance(5_000);
    await h.service.onAlarm(FLUSH_ALARM);
    d = await day(h);
    expect(d['figma.com'].focusedS).toBe(5);
  });

  it('startup resolves the focused active tab', async () => {
    const h = makeHarness(T0);
    h.tabs.set(7, { id: 7, windowId: 1, url: 'https://app.asana.com/0/1', active: true });
    await h.service.onStartup();
    h.advance(12_000);
    await h.service.onAlarm(FLUSH_ALARM);
    expect((await day(h))['app.asana.com'].focusedS).toBe(12);
  });
});

describe('messages', () => {
  async function seeded() {
    const h = makeHarness(T0);
    await h.activate(1, 'https://acme.newtool.io/');
    h.advance(20_000);
    await h.activate(2, 'https://github.com/');
    h.advance(5_000);
    await h.service.onAlarm(FLUSH_ALARM);
    return h;
  }

  it('isMessage rejects unknown shapes', () => {
    expect(isMessage({ type: 'flush' })).toBe(true);
    expect(isMessage({ type: 'upload' })).toBe(false);
    expect(isMessage('flush')).toBe(false);
    expect(isMessage(null)).toBe(false);
  });

  it('accept maps a host to a catalog app or to a custom app', async () => {
    const h = await seeded();
    expect(await h.service.handleMessage({ type: 'accept', host: 'acme.newtool.io', appId: 'notion' })).toEqual({ ok: true });
    expect((await h.local.get(['h:acme.newtool.io']))['h:acme.newtool.io']).toMatchObject({ status: 'accepted', userAppId: 'notion', firstDay: '2026-09-28' });
    await h.service.handleMessage({ type: 'accept', host: 'acme.newtool.io', name: '  New\nTool ', category: 'Engineering' });
    expect((await h.local.get(['h:acme.newtool.io']))['h:acme.newtool.io']).toEqual({ status: 'accepted', userName: 'New Tool', userCategory: 'Engineering', firstDay: '2026-09-28', lastDay: '2026-09-28' });
  });

  it('rejects hosts that are not bare hostnames', async () => {
    const h = await seeded();
    for (const host of ['acme.newtool.io/path', 'x.com?q=1', '', 'a b.com']) {
      expect((await h.service.handleMessage({ type: 'ignoreHost', host })).ok).toBe(false);
    }
    expect((await h.service.handleMessage({ type: 'ignoreDomain', registrable: 'acme.newtool.io' })).ok).toBe(false);
    expect((await h.service.handleMessage({ type: 'setRetention', retentionDays: 7 })).ok).toBe(false);
  });

  it('ignoreDomain / unignoreDomain edit settings', async () => {
    const h = await seeded();
    await h.service.handleMessage({ type: 'ignoreDomain', registrable: 'newtool.io' });
    expect((await h.local.get(['settings'])).settings).toMatchObject({ ignoreRegistrable: ['newtool.io'] });
    await h.service.handleMessage({ type: 'unignoreDomain', registrable: 'newtool.io' });
    expect((await h.local.get(['settings'])).settings).toMatchObject({ ignoreRegistrable: [] });
  });

  it('forgetHost removes the host from every day and its metadata', async () => {
    const h = await seeded();
    await h.service.handleMessage({ type: 'forgetHost', host: 'acme.newtool.io' });
    const dump = h.local.dump();
    expect(dump).not.toContain('acme.newtool.io');
    expect(dump).toContain('github.com');
  });

  it('clearAll removes activity and mappings but keeps retention/pause settings', async () => {
    const h = await seeded();
    await h.service.handleMessage({ type: 'setRetention', retentionDays: 30 });
    await h.service.handleMessage({ type: 'ignoreDomain', registrable: 'newtool.io' });
    await h.service.handleMessage({ type: 'clearAll' });
    expect(h.local.keys()).toEqual(['settings']);
    expect((await h.local.get(['settings'])).settings).toEqual({ retentionDays: 30, paused: false, ignoreRegistrable: [], schemaVersion: 1 });
    expect(h.session.keys()).toEqual([]);
  });

  it('overrides round-trip through export and a strict import', async () => {
    const a = await seeded();
    await a.service.handleMessage({ type: 'accept', host: 'acme.newtool.io', name: 'NewTool', category: 'Engineering' });
    await a.service.handleMessage({ type: 'ignoreHost', host: 'github.com' });
    await a.service.handleMessage({ type: 'ignoreDomain', registrable: 'example.org' });
    const file = exportOverrides(await a.local.get(null));
    expect(JSON.stringify(file)).not.toMatch(/focusedS|2026-09-28/);

    const b = makeHarness(T0);
    expect(await b.service.handleMessage({ type: 'importOverrides', data: JSON.parse(JSON.stringify(file)) })).toEqual({ ok: true });
    expect(exportOverrides(await b.local.get(null))).toEqual(file);

    const bad = { ...file, overrides: [{ host: 'x.com/path', status: 'ignored' }] };
    expect((await b.service.handleMessage({ type: 'importOverrides', data: bad })).ok).toBe(false);
    expect((await b.service.handleMessage({ type: 'importOverrides', data: { ...file, overrides: [{ host: 'x.com', status: 'ignored', title: 't' }] } })).ok).toBe(false);
  });

  it('every stored key stays inside the data contract', async () => {
    const h = await seeded();
    await h.service.handleMessage({ type: 'accept', host: 'acme.newtool.io', name: 'N', category: 'C' });
    expect(h.local.keys().every((k) => classifyLocalKey(k) !== null)).toBe(true);
    expect(h.session.keys()).toEqual([SESSION_WINDOW_KEY]);
  });
});
