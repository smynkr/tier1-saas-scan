// Static guards run as tests, each with a negative control proving it can see a violation.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkManifest, collectDistFiles, collectSourceFiles, scanForEgress } from '../scripts/check-no-egress.mjs';
import { checkSchema, checkTokens } from '../scripts/check-tier1.mjs';

const root = resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

describe('no-egress guard', () => {
  it('source, pages and manifest are clean', () => {
    expect(scanForEgress(collectSourceFiles())).toEqual([]);
    expect(checkManifest(manifest)).toEqual([]);
  });

  it('built dist/ is clean when present (npm run build also enforces this)', () => {
    const dist = collectDistFiles();
    if (!dist) return;
    expect(dist.length).toBeGreaterThan(0);
    expect(scanForEgress(dist)).toEqual([]);
    const dm = JSON.parse(readFileSync(resolve(root, 'dist/manifest.json'), 'utf8'));
    expect(checkManifest(dm)).toEqual([]);
    const { version, ...rest } = dm;
    const { version: _v, ...srcRest } = manifest;
    expect(rest).toEqual(srcRest);
    expect(version).toBe(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version);
  });

  it('negative control: every denylisted API or remote URL is caught', () => {
    const samples = [
      "fetch('http://127.0.0.1:9/x')",
      'const r = await fetch (u)',
      'new XMLHttpRequest()',
      "new WebSocket('wss://x')",
      'navigator.sendBeacon(u, d)',
      "new EventSource('/s')",
      "importScripts('x.js')",
      "chrome.runtime.connectNative('h')",
      'chrome.identity.getAuthToken()',
      'new RTCPeerConnection()',
      'const i = new Image(); i.src = u',
      "window.open('x')",
      "const u = 'https://example.com'",
      '<script src="//cdn.example/x.js"></script>',
      '@import "x.css";',
      'background: url(https://x/y.png)',
      'chrome.tabs.create({ url: remote })',
      'chrome.tabs.update(id, { url: u })',
      'chrome.windows.create({ url: u })',
      'chrome.runtime.setUninstallURL(u)',
      'chrome.storage.sync.set(x)',
      'chrome.downloads.download({ url: u })',
    ];
    for (const s of samples) expect(scanForEgress([{ path: 'x.ts', text: s }]), s).not.toEqual([]);
  });

  it('allows only the extension-page tab open (source and minified forms)', () => {
    for (const s of [
      "chrome.tabs.create({ url: chrome.runtime.getURL('report.html') })",
      'chrome.tabs.create({url:chrome.runtime.getURL("report.html")})',
    ]) {
      expect(scanForEgress([{ path: 'x.ts', text: s }]), s).toEqual([]);
    }
  });

  it('manifest snapshot: exact permissions and no host access', () => {
    expect(manifest.permissions).toEqual(['tabs', 'storage', 'alarms', 'idle']);
    expect(manifest.content_security_policy.extension_pages).toBe(
      "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'self' data: blob:; style-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(Object.keys(manifest).sort()).toEqual(
      ['action', 'background', 'content_security_policy', 'description', 'externally_connectable', 'incognito', 'manifest_version', 'minimum_chrome_version', 'name', 'permissions', 'short_name', 'version'].sort(),
    );
  });

  it('negative control: manifest widening is caught', () => {
    const widen = (patch: Record<string, unknown>) => checkManifest({ ...manifest, ...patch });
    expect(widen({ host_permissions: ['<all_urls>'] })).not.toEqual([]);
    expect(widen({ permissions: [...manifest.permissions, 'webRequest'] })).not.toEqual([]);
    expect(widen({ content_scripts: [{ matches: ['*://*/*'], js: ['c.js'] }] })).not.toEqual([]);
    expect(widen({ content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" } })).not.toEqual([]);
    expect(widen({ incognito: 'spanning' })).not.toEqual([]);
    expect(widen({ key: 'MIIB...' })).not.toEqual([]);
  });
});

describe('Tier-1 static guard', () => {
  it('source is clean', () => {
    expect(checkSchema(readFileSync(resolve(root, 'src/lib/types.ts'), 'utf8'))).toEqual([]);
    const files = collectSourceFiles().filter((f) => f.path.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    expect(checkTokens(files)).toEqual([]);
  });

  it('negative control: a new persisted field is caught', () => {
    const src = readFileSync(resolve(root, 'src/lib/types.ts'), 'utf8').replace('loginHint: 0 | 1;', 'loginHint: 0 | 1;\n  pageTitle: string;');
    expect(checkSchema(src)).toEqual(['types.ts: DayEntry.pageTitle is not in the Tier-1 allowlist']);
  });

  it('negative control: Tier-2 access is caught outside the URL module', () => {
    const bad = [
      'const t = tab.title;',
      'const p = new URL(u).pathname;',
      'const q = location.search;',
      'document.body.innerText',
      'chrome.tabs.captureVisibleTab()',
      'const password = form.value;',
      "chrome.scripting.executeScript({})",
    ];
    for (const text of bad) expect(checkTokens([{ path: 'src/lib/x.ts', text }]), text).not.toEqual([]);
    expect(checkTokens([{ path: 'src/background.ts', text: 'document.querySelector("x")' }])).not.toEqual([]);
    // Allowed: URL parsing inside the one module, and DOM use in extension-page UI.
    expect(checkTokens([{ path: 'src/lib/domain.ts', text: 'const p = new URL(u).pathname;' }])).toEqual([]);
    expect(checkTokens([{ path: 'src/ui/report.ts', text: 'document.getElementById("app")' }])).toEqual([]);
  });

  it('the service worker never reads more than id/url/active from a tab', () => {
    const bg = readFileSync(resolve(root, 'src/background.ts'), 'utf8');
    expect(bg).toMatch(/\{ id: tab\.id, url: tab\.url, active: tab\.active \}/);
    expect(existsSync(resolve(root, 'src/content.ts'))).toBe(false);
  });
});
