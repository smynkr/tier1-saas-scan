import { describe, expect, it } from 'vitest';
import { csvCell, DEFAULT_EXPORT_SCOPE, toCsv, toJson, toJsonObject, toPrintableHtml } from '../src/lib/export';
import type { Report } from '../src/lib/report';

const report: Report = {
  range: { option: 30, from: '2026-08-30', to: '2026-09-28' },
  ai: [{ key: 'chatgpt', name: 'ChatGPT', category: 'AI', subcategory: 'Chat assistant', source: 'catalog', hosts: ['chatgpt.com'], firstSeen: '2026-09-01', lastSeen: '2026-09-28', daysActive: 5, attendedS: 7200, focusedS: 9000, loginHint: true }],
  known: [
    { key: 'user:=cmd', name: '=HYPERLINK("x","y")', category: '+Evil, "quoted"', source: 'user', hosts: ['acme.internal-tool.io'], firstSeen: '2026-09-02', lastSeen: '2026-09-03', daysActive: 2, attendedS: 60, focusedS: 60, loginHint: false },
  ],
  candidates: [{ host: 'acme.newtool.io', registrable: 'newtool.io', reasons: ['login', 'tenant'], firstSeen: '2026-09-10', lastSeen: '2026-09-11', daysActive: 2, attendedS: 30, focusedS: 30 }],
  hourHistogram: Array.from({ length: 24 }, (_, i) => (i === 10 ? 3 : 0)),
  daysWithData: 5,
  catalogVersion: 'test-1',
};
const meta = { generatedAt: '2026-09-28T12:00:00.000Z' };

describe('csvCell', () => {
  it('prefixes formula-leading cells with a quote (= + - @ tab CR) and quotes every cell', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
    expect(csvCell('\rx')).toBe(`"'\rx"`);
  });
  it('sees through leading ASCII space, NBSP and other Unicode spaces', () => {
    expect(csvCell(' =1+1')).toBe(`"' =1+1"`);
    expect(csvCell('\u00A0=1+1')).toBe(`"'\u00A0=1+1"`);
    expect(csvCell('\u3000\u2003@x')).toBe(`"'\u3000\u2003@x"`);
    expect(csvCell(' \n-2')).toBe(`"' \n-2"`);
  });
  it('guards full-width formula characters', () => {
    for (const ch of ['\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']) expect(csvCell(`${ch}SUM(1)`)).toBe(`"'${ch}SUM(1)"`);
    expect(csvCell(' \uFF1D1')).toBe(`"' \uFF1D1"`);
  });
  it('quotes cells containing ; so a semicolon-separator locale cannot split out a formula', () => {
    expect(csvCell('Tool;=HYPERLINK(1)')).toBe('"Tool;=HYPERLINK(1)"');
    expect(csvCell('; separator')).toBe('"; separator"');
  });
  it('normal values are unchanged apart from quoting (RFC 4180, internal quotes doubled)', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell('1.5')).toBe('"1.5"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('')).toBe('""');
    expect(csvCell('a=b')).toBe('"a=b"');
  });
  it('guards and quotes together', () => {
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });
});

describe('default export scope', () => {
  it('omits candidates and hostnames', () => {
    const csv = toCsv(report, DEFAULT_EXPORT_SCOPE);
    const json = toJson(report, DEFAULT_EXPORT_SCOPE, meta);
    const html = toPrintableHtml(report, DEFAULT_EXPORT_SCOPE, meta);
    for (const out of [csv, json, html]) {
      expect(out).not.toContain('chatgpt.com');
      expect(out).not.toContain('acme.internal-tool.io');
      expect(out).not.toContain('newtool.io');
      expect(out).toContain('ChatGPT');
    }
    expect(JSON.parse(json).candidates).toBeUndefined();
  });

  it('candidates opt-in without hostnames shows only the registrable domain', () => {
    const csv = toCsv(report, { includeCandidates: true, detail: 'apps' });
    expect(csv).toContain('newtool.io');
    expect(csv).not.toContain('acme.newtool.io');
  });

  it('hosts opt-in includes hostnames', () => {
    const csv = toCsv(report, { includeCandidates: true, detail: 'hosts' });
    expect(csv).toContain('acme.newtool.io');
    expect(csv).toContain('chatgpt.com');
  });
});

describe('CSV', () => {
  it('has a header, CRLF line endings, and one row per app/candidate', () => {
    const csv = toCsv(report, { includeCandidates: true, detail: 'apps' });
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(['type', 'name', 'category', 'subcategory', 'days_active', 'attended_hours', 'focused_hours', 'first_seen', 'last_seen', 'login_hint', 'reasons'].map((h) => `"${h}"`).join(','));
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"",""y"")"`);
    expect(lines[2]).toContain(`"'+Evil, ""quoted"""`);
  });
});

describe('JSON', () => {
  it('matches the documented top-level schema', () => {
    const o = toJsonObject(report, { includeCandidates: true, detail: 'hosts' }, meta);
    expect(Object.keys(o)).toEqual(['schemaVersion', 'generatedAt', 'range', 'catalogVersion', 'dataContract', 'scope', 'apps', 'candidates', 'hourHistogram']);
    expect(o.schemaVersion).toBe(1);
    expect((o.apps as unknown[]).length).toBe(2);
    expect((o.hourHistogram as number[]).length).toBe(24);
  });
});

describe('printable HTML', () => {
  it('has no script, no external references and escapes content', () => {
    const html = toPrintableHtml(report, { includeCandidates: true, detail: 'hosts' }, meta);
    expect(html).not.toMatch(/<script|javascript:|https?:|\bsrc=|\bhref=|url\(|@import|<link|<img|<iframe/i);
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).not.toContain('"quoted"');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});
