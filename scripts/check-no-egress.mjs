#!/usr/bin/env node
// No-egress guard (DESIGN sections 4.3 and 10). Scans source, extension pages, the
// manifest and (when present) the built dist/ for any network-capable API or remote
// URL, and checks the manifest for host permissions and the connect-src 'none' CSP.
//
//   node scripts/check-no-egress.mjs              scan src/, *.html, manifest.json, and dist/ if built
//   node scripts/check-no-egress.mjs --dist-only  scan dist/ only (fails if dist/ is missing)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './lib-walk.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each rule: [id, regex]. Applied to raw text (comments included: zero tolerance). */
export const EGRESS_RULES = [
  ['fetch', /\bfetch\s*\(/],
  ['xhr', /XMLHttpRequest/],
  ['websocket', /\bWebSocket\b/],
  ['eventsource', /\bEventSource\b/],
  ['sendBeacon', /sendBeacon/],
  ['importScripts', /importScripts/],
  ['nativeMessaging', /connectNative|sendNativeMessage/],
  ['identity', /chrome\.identity/],
  ['webrtc', /RTCPeerConnection|RTCDataChannel/],
  ['imageBeacon', /new\s+Image\s*\(/],
  ['windowOpen', /window\.open\s*\(/],
  ['navigation', /\blocation\.(assign|replace)\s*\(|\blocation\.href\s*=/],
  // Browser-mediated egress that connect-src cannot block: opening or redirecting a tab or
  // window to a remote page, an uninstall URL, Chrome Sync storage, or the downloads API.
  // The one allowed tab open is the extension's own report page via runtime.getURL.
  ['tabNavigation', /\btabs\.create\s*\((?!\s*\{\s*url\s*:\s*chrome\.runtime\.getURL\s*\()|\btabs\.update\s*\(|\bwindows\.create\s*\(/],
  ['uninstallUrl', /setUninstallURL/],
  ['storageSync', /\bstorage\.sync\b/],
  ['downloadsApi', /\bchrome\.downloads\b/],
  ['httpUrl', /\bhttps?:\/\//i],
  ['wsUrl', /\bwss?:\/\//i],
  ['protocolRelative', /(?:src|href|action)\s*=\s*["']?\/\//i],
  ['cssImport', /@import\b/],
  ['cssRemoteUrl', /url\(\s*["']?(?:https?:)?\/\//i],
];

export function scanForEgress(files) {
  const violations = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((line, i) => {
      for (const [id, re] of EGRESS_RULES) {
        if (re.test(line)) violations.push(`${f.path}:${i + 1} [${id}] ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return violations;
}

export const REQUIRED_PERMISSIONS = ['alarms', 'idle', 'storage', 'tabs'];
const FORBIDDEN_MANIFEST_KEYS = [
  'host_permissions', 'optional_host_permissions', 'optional_permissions', 'content_scripts',
  'web_accessible_resources', 'key', 'oauth2', 'update_url', 'chrome_url_overrides', 'storage',
  'declarative_net_request', 'sandbox',
];

export function checkManifest(m) {
  const v = [];
  if (m.manifest_version !== 3) v.push('manifest_version must be 3');
  const perms = [...(m.permissions ?? [])].sort();
  if (JSON.stringify(perms) !== JSON.stringify(REQUIRED_PERMISSIONS)) v.push(`permissions must be exactly ${REQUIRED_PERMISSIONS.join(',')}, got ${perms.join(',')}`);
  for (const k of FORBIDDEN_MANIFEST_KEYS) if (k in m) v.push(`forbidden manifest key: ${k}`);
  if (m.incognito !== 'not_allowed') v.push('incognito must be "not_allowed"');
  if (JSON.stringify(m.externally_connectable) !== JSON.stringify({ ids: [] })) v.push('externally_connectable must be {"ids":[]}');
  const csp = m.content_security_policy?.extension_pages ?? '';
  for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "form-action 'none'"]) {
    if (!csp.includes(d)) v.push(`CSP missing ${d}`);
  }
  if (/unsafe-|https?:|\*/.test(csp)) v.push('CSP must not contain unsafe-*, remote origins or wildcards');
  if (m.background?.service_worker !== 'background.js') v.push('background.service_worker must be background.js');
  const json = JSON.stringify(m);
  if (/https?:\/\/|<all_urls>|\*:\/\//.test(json)) v.push('manifest contains a URL or match pattern');
  return v;
}

export function collectSourceFiles() {
  return [
    ...walk(resolve(root, 'src'), ['.ts', '.css', '.json', '.html']).map((f) => ({ ...f, path: `src/${f.path}` })),
    ...['popup.html', 'report.html', 'manifest.json'].map((p) => ({ path: p, text: readFileSync(resolve(root, p), 'utf8') })),
  ];
}

export function collectDistFiles() {
  const dist = resolve(root, 'dist');
  if (!existsSync(dist)) return null;
  return walk(dist, ['.js', '.mjs', '.html', '.css', '.json', '.map', '.txt', '.svg']).map((f) => ({ ...f, path: `dist/${f.path}` }));
}

function main() {
  const distOnly = process.argv.includes('--dist-only');
  const problems = [];
  let scanned = 0;
  if (!distOnly) {
    const src = collectSourceFiles();
    scanned += src.length;
    problems.push(...scanForEgress(src));
    problems.push(...checkManifest(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))).map((p) => `manifest.json: ${p}`));
  }
  const dist = collectDistFiles();
  if (dist) {
    scanned += dist.length;
    problems.push(...scanForEgress(dist));
    const dm = resolve(root, 'dist/manifest.json');
    if (!existsSync(dm)) problems.push('dist/manifest.json missing');
    else problems.push(...checkManifest(JSON.parse(readFileSync(dm, 'utf8'))).map((p) => `dist/manifest.json: ${p}`));
  } else if (distOnly) {
    problems.push('dist/ not found; run the build first');
  }
  if (problems.length) {
    console.error(`no-egress guard: ${problems.length} violation(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`no-egress guard: OK (${scanned} files${dist ? ', including dist/' : ', dist/ not built'})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
