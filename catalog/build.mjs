#!/usr/bin/env node
// Offline, deterministic catalog build: catalog/sources/*.json -> src/catalog/catalog.json.
// This script makes no network request. Wikidata and awesome-generative-ai candidate
// generation (DESIGN section 7 steps 2-3) are NOT implemented yet; see catalog/README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_VERSION = '2026.09.28-mvp1';
const GENERATED_AT = '2026-09-28T00:00:00Z';
const MANUAL_SOURCE = 'manual:mvp-2026-09-28';

/**
 * Reviewed adjustments to the ported seed. Each one records why, and the entry's
 * sources gain MANUAL_SOURCE so provenance shows it is no longer the pure seed.
 */
const SEED_ADJUSTMENTS = {
  'Google Workspace': {
    why: 'seed mapped all of google.com, which would file Google Search as Workspace use under suffix matching',
    domains: ['workspace.google.com', 'docs.google.com', 'drive.google.com', 'mail.google.com', 'calendar.google.com', 'chat.google.com', 'admin.google.com', 'sites.google.com', 'keep.google.com'],
  },
  Webflow: {
    why: 'webflow.io hosts customer sites; visiting one is not use of Webflow',
    domains: ['webflow.com'],
  },
  'Microsoft 365': {
    why: 'add the Outlook web, SharePoint and M365 app hosts',
    domains: ['office.com', 'microsoft365.com', 'outlook.office.com', 'outlook.office365.com', 'm365.cloud.microsoft', 'sharepoint.com'],
  },
};

function slug(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Drop a domain already covered by a shorter domain of the same app (suffix match makes it redundant). */
function dedupeDomains(domains) {
  const uniq = [...new Set(domains.map((d) => d.toLowerCase()))].sort();
  return uniq.filter((d) => !uniq.some((o) => o !== d && d.endsWith(`.${o}`)));
}

export function buildCatalog() {
  const seed = JSON.parse(readFileSync(resolve(root, 'catalog/sources/seed.json'), 'utf8'));
  const manual = JSON.parse(readFileSync(resolve(root, 'catalog/sources/manual.json'), 'utf8'));
  const apps = [];
  for (const e of seed.apps) {
    const adj = SEED_ADJUSTMENTS[e.name];
    apps.push({
      id: slug(e.name),
      name: e.name,
      category: e.category,
      ...(e.subcategory ? { subcategory: e.subcategory } : {}),
      domains: dedupeDomains(adj ? adj.domains : e.domains),
      sources: adj ? ['seed', MANUAL_SOURCE] : ['seed'],
    });
  }
  for (const e of manual.apps) {
    apps.push({
      id: slug(e.name),
      name: e.name,
      category: e.category,
      ...(e.subcategory ? { subcategory: e.subcategory } : {}),
      domains: dedupeDomains(e.domains),
      sources: [MANUAL_SOURCE],
    });
  }
  apps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { formatVersion: 1, catalogVersion: CATALOG_VERSION, generatedAt: GENERATED_AT, license: 'Apache-2.0', apps };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = buildCatalog();
  writeFileSync(resolve(root, 'src/catalog/catalog.json'), `${JSON.stringify(catalog)}\n`);
  const ai = catalog.apps.filter((a) => a.category === 'AI').length;
  console.log(`catalog ${catalog.catalogVersion}: ${catalog.apps.length} apps (${ai} AI), ${catalog.apps.reduce((n, a) => n + a.domains.length, 0)} domains`);
}
