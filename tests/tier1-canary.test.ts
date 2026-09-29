// Behavioral Tier-1 guard (DESIGN section 10): drive the real service handlers with
// URLs carrying canary strings in every URL part plus a canary tab title, then dump
// every storage area and every export format and assert no canary survives and every
// persisted key/field is on the DESIGN section 3 allowlist.
import { describe, expect, it } from 'vitest';
import catalogJson from '../src/catalog/catalog.json';
import { buildMatcher, validateCatalog, type Catalog } from '../src/lib/catalog';
import { toCsv, toJson, toPrintableHtml } from '../src/lib/export';
import { exportOverrides } from '../src/lib/overrides';
import { buildReport } from '../src/lib/report';
import { classifyLocalKey, DAY_ENTRY_FIELDS, HOST_META_FIELDS, SESSION_WINDOW_KEY, SETTINGS_FIELDS, WINDOW_FIELDS } from '../src/lib/schema';
import { FLUSH_ALARM } from '../src/lib/service';
import { makeHarness } from './helpers';

const T0 = new Date(2026, 8, 28, 9, 0, 0).getTime();
const CANARY_URLS = [
  'https://user:CANARYPW@acme.newtool.io/CANARYPATH/login?token=CANARYQ#CANARYF',
  'https://chatgpt.com/c/CANARYPATH2?q=CANARYQ2#CANARYF2',
  'https://app.unknownsaas.dev/CANARYPATH3/settings?email=CANARYQ3@x.com',
  'https://CANARYHOSTUPPER.example.org/', // hosts are lowercased; check the lowercase form below
];

describe('Tier-1 canary', () => {
  it('no URL part, title or favicon ever reaches storage or any export', async () => {
    const h = makeHarness(T0);
    let id = 1;
    for (const url of CANARY_URLS) {
      await h.activate(id++, url, { title: 'CANARYTITLE secret doc', favIconUrl: 'https://cdn.example/CANARYICON.png' });
      h.advance(11 * 60_000);
      await h.service.onAlarm(FLUSH_ALARM);
      await h.navigate(id - 1, `${url.split('#')[0]}&more=CANARYNAV`);
      h.advance(61_000);
    }
    await h.service.onIdleStateChanged('idle');
    h.advance(30_000);
    await h.service.onWindowFocusChanged(null);
    await h.service.handleMessage({ type: 'accept', host: 'app.unknownsaas.dev', name: 'Unknown SaaS', category: 'Engineering' });

    const local = await h.local.get(null);
    const matcher = buildMatcher(validateCatalog(catalogJson).catalog as Catalog);
    const report = buildReport(local, matcher, new Set(), { today: '2026-09-28', range: 'all' });
    const scope = { includeCandidates: true, detail: 'hosts' as const };
    const outputs = {
      local: h.local.dump(),
      session: h.session.dump(),
      csv: toCsv(report, scope),
      json: toJson(report, scope, { generatedAt: 'now' }),
      html: toPrintableHtml(report, scope, { generatedAt: 'now' }),
      overrides: JSON.stringify(exportOverrides(local)),
    };

    for (const [name, text] of Object.entries(outputs)) {
      const lower = text.toLowerCase();
      for (const canary of ['canarypw', 'canarypath', 'canaryq', 'canaryf', 'canarytitle', 'canaryicon', 'canarynav', 'token=', 'email=', '/login', 'user:']) {
        expect(lower, `${name} leaked ${canary}`).not.toContain(canary);
      }
    }

    // Sanity: the run really recorded the canary hosts, so the leak assertion above is meaningful.
    expect(outputs.local).toContain('acme.newtool.io');
    expect(outputs.local).toContain('chatgpt.com');
    expect(outputs.csv).toContain('acme.newtool.io');
    expect(report.candidates.map((c) => c.host)).toContain('acme.newtool.io');


    // Every persisted key and field is on the allowlist.
    for (const [key, value] of Object.entries(local)) {
      const kind = classifyLocalKey(key);
      expect(kind, `unexpected key ${key}`).not.toBeNull();
      if (kind === 'day') {
        for (const entry of Object.values(value as Record<string, object>)) {
          expect(Object.keys(entry).every((f) => (DAY_ENTRY_FIELDS as readonly string[]).includes(f))).toBe(true);
        }
      } else if (kind === 'host') {
        expect(Object.keys(value as object).every((f) => (HOST_META_FIELDS as readonly string[]).includes(f))).toBe(true);
      } else {
        expect(Object.keys(value as object).sort()).toEqual([...SETTINGS_FIELDS].sort());
      }
    }
    const session = await h.session.get(null);
    for (const [key, value] of Object.entries(session)) {
      expect(key).toBe(SESSION_WINDOW_KEY);
      expect(Object.keys(value as object).every((f) => (WINDOW_FIELDS as readonly string[]).includes(f))).toBe(true);
    }
  });
});
