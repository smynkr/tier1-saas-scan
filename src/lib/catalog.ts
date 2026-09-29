// Bundled catalog validation and on-device matching (DESIGN sections 6-7).
// Strict key checks follow the style of axiomlayer's device-catalog.ts sanitizeArtifact
// (single-author file); the ECDSA signature path is dropped because the catalog ships
// inside the signed extension package. The matcher is a rewrite (not a port of
// packages/core catalog-matcher.ts): exact host, then longest-suffix walk.
import { isValidHost } from './domain';

export interface CatalogApp {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  domains: string[];
  sources: string[];
}

export interface Catalog {
  formatVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  license: 'Apache-2.0';
  apps: CatalogApp[];
}

const TOP_KEYS = ['formatVersion', 'catalogVersion', 'generatedAt', 'license', 'apps'];
const APP_KEYS = ['id', 'name', 'category', 'subcategory', 'domains', 'sources'];
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SOURCE_RE = /^(seed|wikidata:Q[1-9]\d*|awesome-genai|manual:[A-Za-z0-9#._-]{1,64})$/;

export const AI_CATEGORY = 'AI';
export const AI_SUBCATEGORIES = [
  'Chat assistant',
  'Coding assistant',
  'Image/video/audio',
  'Meeting/notes',
  'Writing',
  'Agents/automation',
  'Model/API console',
] as const;

function nonEmptyText(v: unknown, max = 80): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f<>]/.test(v);
}

export interface CatalogValidation {
  catalog: Catalog | null;
  errors: string[];
}

/** Strict validation. Any unknown key, bad host, duplicate id or duplicate domain is an error. */
export function validateCatalog(input: unknown): CatalogValidation {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { catalog: null, errors: ['not an object'] };
  const c = input as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!TOP_KEYS.includes(k)) errors.push(`unknown top-level key ${k}`);
  if (c.formatVersion !== 1) errors.push('formatVersion must be 1');
  if (!nonEmptyText(c.catalogVersion, 40)) errors.push('bad catalogVersion');
  if (typeof c.generatedAt !== 'string' || Number.isNaN(Date.parse(c.generatedAt))) errors.push('bad generatedAt');
  if (c.license !== 'Apache-2.0') errors.push('license must be Apache-2.0');
  if (!Array.isArray(c.apps)) return { catalog: null, errors: [...errors, 'apps must be an array'] };

  const ids = new Set<string>();
  const domains = new Map<string, string>();
  c.apps.forEach((raw, i) => {
    const where = `apps[${i}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${where} not an object`);
      return;
    }
    const a = raw as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!APP_KEYS.includes(k)) errors.push(`${where} unknown key ${k}`);
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) errors.push(`${where} bad id`);
    else if (ids.has(a.id)) errors.push(`${where} duplicate id ${a.id}`);
    else ids.add(a.id);
    if (!nonEmptyText(a.name)) errors.push(`${where} bad name`);
    if (!nonEmptyText(a.category, 40)) errors.push(`${where} bad category`);
    if (a.subcategory !== undefined && !nonEmptyText(a.subcategory, 40)) errors.push(`${where} bad subcategory`);
    if (a.category === AI_CATEGORY && !(AI_SUBCATEGORIES as readonly unknown[]).includes(a.subcategory)) {
      errors.push(`${where} AI app needs a known subcategory`);
    }
    if (!Array.isArray(a.domains) || a.domains.length === 0) errors.push(`${where} domains must be non-empty`);
    else {
      for (const d of a.domains) {
        if (!isValidHost(d) || d !== d.toLowerCase() || !d.includes('.')) errors.push(`${where} bad domain ${String(d)}`);
        else if (domains.has(d)) errors.push(`${where} domain ${d} already mapped to ${domains.get(d)}`);
        else domains.set(d, String(a.id));
      }
    }
    if (!Array.isArray(a.sources) || a.sources.length === 0) errors.push(`${where} sources must be non-empty`);
    else for (const s of a.sources) if (typeof s !== 'string' || !SOURCE_RE.test(s)) errors.push(`${where} bad source ${String(s)}`);
  });

  if (errors.length) return { catalog: null, errors };
  return { catalog: input as Catalog, errors };
}

export interface Matcher {
  catalog: Catalog;
  byId: Map<string, CatalogApp>;
  /** Longest-suffix match: exact host first, then parent suffixes down to two labels. */
  match(host: string): CatalogApp | null;
}

export function buildMatcher(catalog: Catalog): Matcher {
  const byDomain = new Map<string, CatalogApp>();
  const byId = new Map<string, CatalogApp>();
  for (const app of catalog.apps) {
    byId.set(app.id, app);
    for (const d of app.domains) byDomain.set(d, app);
  }
  return {
    catalog,
    byId,
    match(host: string): CatalogApp | null {
      const parts = host.toLowerCase().split('.');
      for (let i = 0; i <= parts.length - 2; i++) {
        const hit = byDomain.get(parts.slice(i).join('.'));
        if (hit) return hit;
      }
      return null;
    },
  };
}
