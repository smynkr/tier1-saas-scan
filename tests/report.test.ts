import { describe, expect, it } from 'vitest';
import catalogJson from '../src/catalog/catalog.json';
import suppressionJson from '../src/catalog/suppression.json';
import { buildMatcher, validateCatalog, type Catalog } from '../src/lib/catalog';
import { buildReport } from '../src/lib/report';

const matcher = buildMatcher(validateCatalog(catalogJson).catalog as Catalog);
const suppression = new Set(suppressionJson.domains);
const TODAY = '2026-09-28';

type E = { f?: number; a?: number; h?: number; l?: 0 | 1 };
function snap(days: Record<string, Record<string, E>>, extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { ...extra };
  for (const [day, hosts] of Object.entries(days)) {
    out[`d:${day}`] = Object.fromEntries(
      Object.entries(hosts).map(([host, e]) => [host, { focusedS: e.f ?? 60, attendedS: e.a ?? e.f ?? 60, hours: e.h ?? 0, loginHint: e.l ?? 0 }]),
    );
  }
  return out;
}
const report = (s: Record<string, unknown>, range: 7 | 30 | 90 | 'all' = 30) => buildReport(s, matcher, suppression, { today: TODAY, range });

describe('app resolution', () => {
  it('groups hosts into catalog apps, AI first', () => {
    const r = report(snap({ '2026-09-27': { 'acme.slack.com': { f: 600 }, 'app.slack.com': { f: 60 }, 'chatgpt.com': { f: 300 } }, '2026-09-28': { 'acme.slack.com': { f: 60 } } }));
    expect(r.ai.map((a) => a.name)).toEqual(['ChatGPT']);
    const slack = r.known.find((a) => a.name === 'Slack');
    expect(slack).toMatchObject({ hosts: ['acme.slack.com', 'app.slack.com'], daysActive: 2, focusedS: 720, firstSeen: '2026-09-27', lastSeen: '2026-09-28' });
  });

  it('applies accepted overrides: mapped to a catalog app, or a user app', () => {
    const r = report(
      snap({ '2026-09-28': { 'wiki.acme.internal.io': { f: 900 }, 'tool.example.dev': { f: 60 } } }, {
        'h:wiki.acme.internal.io': { status: 'accepted', userAppId: 'notion' },
        'h:tool.example.dev': { status: 'accepted', userName: 'Example Tool', userCategory: 'AI' },
      }),
    );
    expect(r.known.find((a) => a.name === 'Notion')?.hosts).toEqual(['wiki.acme.internal.io']);
    expect(r.ai.find((a) => a.name === 'Example Tool')).toMatchObject({ source: 'user', category: 'AI' });
    expect(r.candidates).toEqual([]);
  });

  it('filters by range', () => {
    const s = snap({ '2026-09-01': { 'github.com': {} }, '2026-09-25': { 'github.com': {} } });
    expect(report(s, 7).known[0].daysActive).toBe(1);
    expect(report(s, 30).known[0].daysActive).toBe(2);
    expect(report(s, 'all').range.from).toBeNull();
  });
});

describe('candidate rules', () => {
  it('login signal makes a candidate on its own and ranks first', () => {
    const r = report(snap({ '2026-09-28': { 'app.newtool.io': { f: 10, l: 1 }, 'app.other.dev': { f: 700 } } }));
    expect(r.candidates.map((c) => [c.host, c.reasons])).toEqual([
      ['app.newtool.io', ['login']],
      ['app.other.dev', ['repeat']],
    ]);
  });

  it('repeat use: 3+ distinct days or 10+ attended minutes', () => {
    const three = snap({ '2026-09-26': { 'x.tool.io': { f: 10 } }, '2026-09-27': { 'x.tool.io': { f: 10 } }, '2026-09-28': { 'x.tool.io': { f: 10 } } });
    expect(report(three).candidates[0]?.reasons).toEqual(['repeat']);
    const two = snap({ '2026-09-27': { 'x.tool.io': { f: 10 } }, '2026-09-28': { 'x.tool.io': { f: 10 } } });
    expect(report(two).candidates).toEqual([]);
    const tenMin = snap({ '2026-09-28': { 'x.tool.io': { f: 600, a: 600 } } });
    expect(report(tenMin).candidates[0]?.reasons).toEqual(['repeat']);
    const focusedOnly = snap({ '2026-09-28': { 'x.tool.io': { f: 3600, a: 0 } } });
    expect(report(focusedOnly).candidates).toEqual([]);
  });

  it('tenant shape: a subdomain beside another candidate (weak signal, ranked last)', () => {
    const r = report(snap({ '2026-09-28': { 'login.newtool.io': { f: 5, l: 1 }, 'acme.newtool.io': { f: 30 } } }));
    expect(r.candidates.map((c) => [c.host, c.reasons])).toEqual([
      ['login.newtool.io', ['login']],
      ['acme.newtool.io', ['tenant']],
    ]);
  });

  it('suppressed, ignored and ignored-domain hosts never become candidates', () => {
    const s = snap(
      { '2026-09-28': { 'www.nytimes.com': { f: 3000 }, 'accounts.google.com': { f: 5, l: 1 }, 'a.tool.io': { f: 900 }, 'b.other.io': { f: 900 } } },
      { 'h:a.tool.io': { status: 'ignored' }, settings: { retentionDays: 90, paused: false, ignoreRegistrable: ['other.io'], schemaVersion: 1 } },
    );
    expect(report(s).candidates).toEqual([]);
  });

  it('per-user tunnel, translate-proxy and preview-deploy hosts never become candidates', () => {
    const s = snap({
      '2026-09-27': { 'abc123.ngrok-free.app': { f: 900, l: 1 }, 'my-site-com.translate.goog': { f: 900 }, 'proj-git-feat-user.vercel.app': { f: 900, l: 1 }, 'deploy-preview-7--site.netlify.app': { f: 900 } },
      '2026-09-28': { 'abc123.ngrok-free.app': { f: 900 }, 'my-site-com.translate.goog': { f: 900 }, 'proj-git-feat-user.vercel.app': { f: 900 }, 'deploy-preview-7--site.netlify.app': { f: 900 }, 'acme.newtool.io': { f: 5, l: 1 } },
    });
    expect(report(s).candidates.map((c) => c.host)).toEqual(['acme.newtool.io']);
  });

  it('ordinary short visits are not candidates', () => {
    expect(report(snap({ '2026-09-28': { 'some-blog.example': { f: 120 } } })).candidates).toEqual([]);
  });
});

describe('hour histogram', () => {
  it('counts days with any activity in each local hour', () => {
    const r = report(snap({ '2026-09-27': { 'github.com': { h: (1 << 9) | (1 << 10) }, 'chatgpt.com': { h: 1 << 10 } }, '2026-09-28': { 'github.com': { h: 1 << 10 } } }));
    expect(r.hourHistogram[9]).toBe(1);
    expect(r.hourHistogram[10]).toBe(2);
    expect(r.hourHistogram.reduce((a, b) => a + b, 0)).toBe(3);
    expect(r.daysWithData).toBe(2);
  });
});
