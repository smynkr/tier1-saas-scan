import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import catalogJson from '../src/catalog/catalog.json';
import suppressionJson from '../src/catalog/suppression.json';
import { AI_CATEGORY, buildMatcher, validateCatalog, type Catalog } from '../src/lib/catalog';
import { isValidHost } from '../src/lib/domain';

const bundled = validateCatalog(catalogJson);

describe('bundled catalog', () => {
  it('passes strict validation', () => {
    expect(bundled.errors).toEqual([]);
    expect(bundled.catalog).not.toBeNull();
  });

  it('records provenance on every entry', () => {
    for (const app of (catalogJson as Catalog).apps) {
      expect(app.sources.length).toBeGreaterThan(0);
    }
    const seed = (catalogJson as Catalog).apps.filter((a) => a.sources.includes('seed'));
    expect(seed.length).toBe(50);
  });

  it('has an AI category that the seed lacked', () => {
    const ai = (catalogJson as Catalog).apps.filter((a) => a.category === AI_CATEGORY);
    expect(ai.length).toBeGreaterThanOrEqual(100);
  });

  it('stays within the 300 KB size budget', () => {
    expect(JSON.stringify(catalogJson).length).toBeLessThanOrEqual(300 * 1024);
  });

  it('ships no logo or favicon assets', () => {
    const files = readdirSync(resolve(__dirname, '../src/catalog'));
    expect(files.filter((f) => /\.(png|jpe?g|gif|svg|ico|webp)$/i.test(f))).toEqual([]);
    expect(JSON.stringify(catalogJson)).not.toMatch(/logo|favicon|https?:/i);
  });

  it('does not map all of google.com (search is not Workspace)', () => {
    const m = buildMatcher(bundled.catalog as Catalog);
    expect(m.match('www.google.com')).toBeNull();
    expect(m.match('docs.google.com')?.id).toBe('google-workspace');
    expect(m.match('gemini.google.com')?.category).toBe('AI');
  });
});

describe('longest-suffix matcher', () => {
  const c: Catalog = {
    formatVersion: 1,
    catalogVersion: 't',
    generatedAt: '2026-09-28T00:00:00Z',
    license: 'Apache-2.0',
    apps: [
      { id: 'workspace', name: 'Google Workspace', category: 'Productivity', domains: ['google.com'], sources: ['seed'] },
      { id: 'gemini', name: 'Gemini', category: 'AI', subcategory: 'Chat assistant', domains: ['gemini.google.com'], sources: ['manual:t'] },
      { id: 'slack', name: 'Slack', category: 'Communication', domains: ['slack.com'], sources: ['seed'] },
    ],
  };
  const m = buildMatcher(c);
  it('prefers the most specific entry: gemini.google.com beats google.com', () => {
    expect(m.match('gemini.google.com')?.id).toBe('gemini');
    expect(m.match('x.gemini.google.com')?.id).toBe('gemini');
    expect(m.match('docs.google.com')?.id).toBe('workspace');
  });
  it('matches exact hosts and tenant subdomains', () => {
    expect(m.match('slack.com')?.id).toBe('slack');
    expect(m.match('acme.slack.com')?.id).toBe('slack');
  });
  it('never matches on a bare TLD or a look-alike', () => {
    expect(m.match('com')).toBeNull();
    expect(m.match('notslack.com')).toBeNull();
    expect(m.match('slack.com.evil.io')).toBeNull();
  });
});

describe('validateCatalog rejects bad input', () => {
  const good = { formatVersion: 1, catalogVersion: 'x', generatedAt: '2026-09-28T00:00:00Z', license: 'Apache-2.0', apps: [{ id: 'a', name: 'A', category: 'Productivity', domains: ['a.com'], sources: ['seed'] }] };
  const bad = (patch: (o: any) => void) => {
    const o = JSON.parse(JSON.stringify(good));
    patch(o);
    return validateCatalog(o).catalog;
  };
  it('accepts the minimal good catalog', () => expect(validateCatalog(good).catalog).not.toBeNull());
  it('rejects unknown keys, logos, bad hosts, duplicates and bad provenance', () => {
    expect(bad((o) => (o.extra = 1))).toBeNull();
    expect(bad((o) => (o.apps[0].logo = 'x.png'))).toBeNull();
    expect(bad((o) => (o.apps[0].domains = ['https://a.com']))).toBeNull();
    expect(bad((o) => (o.apps[0].domains = ['A.com']))).toBeNull();
    expect(bad((o) => o.apps.push({ ...o.apps[0], id: 'b' }))).toBeNull();
    expect(bad((o) => (o.apps[0].sources = ['g2']))).toBeNull();
    expect(bad((o) => (o.apps[0].sources = []))).toBeNull();
    expect(bad((o) => (o.license = 'MIT'))).toBeNull();
    expect(bad((o) => Object.assign(o.apps[0], { category: 'AI' }))).toBeNull(); // AI needs a subcategory
  });
});

describe('suppression list', () => {
  it('is a list of valid hostnames within the 300-500 target', () => {
    const d = suppressionJson.domains;
    expect(d.every((h) => isValidHost(h) && h.includes('.'))).toBe(true);
    expect(new Set(d).size).toBe(d.length);
    expect(d.length).toBeGreaterThanOrEqual(300);
    expect(d.length).toBeLessThanOrEqual(500);
  });
  it('does not suppress a domain the catalog maps exactly', () => {
    const catalogDomains = new Set((catalogJson as Catalog).apps.flatMap((a) => a.domains));
    expect(suppressionJson.domains.filter((d) => catalogDomains.has(d))).toEqual([]);
  });
});
