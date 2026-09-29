#!/usr/bin/env node
// Tier-1 boundary guard (a rewrite of the idea in axiomlayer scripts/check-tier1-boundary:
// schema allowlist + Tier-2 denylist; DESIGN section 10). Static layers:
//   1. Schema: persisted interfaces in src/lib/types.ts may only have the DESIGN section 3 fields.
//   2. Denylist: Tier-2 identifiers anywhere in src/ (comments stripped), plus URL-part access
//      (.pathname/.search/.hash/.href/new URL) outside the single URL-parsing module, and DOM
//      access (document.) outside the extension-page UI.
// The behavioral canary test (tests/tier1-canary.test.ts) is the runtime layer.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, walk } from './lib-walk.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SCHEMA_ALLOWLIST = {
  DayEntry: ['attendedS', 'focusedS', 'hours', 'loginHint'],
  HostMeta: ['firstDay', 'lastDay', 'status', 'userAppId', 'userCategory', 'userName'],
  Settings: ['ignoreRegistrable', 'paused', 'retentionDays', 'schemaVersion'],
  FocusWindow: ['host', 'hourKey', 'hourS', 'idleState', 'loginHint', 'startMs', 'tabId'],
};

/** The only module allowed to parse URLs or read URL parts. */
export const URL_MODULE = 'src/lib/domain.ts';
/** Extension-page UI may use the DOM of its own pages. */
export const UI_DIR = 'src/ui/';

export const TIER2_TOKENS = [
  'pagetitle', 'page_title', 'keystroke', 'keylog', 'screenshot', 'screencapture', 'capturevisibletab',
  'productivityscore', 'productivity_score', 'pagecontent', 'page_content', 'full_url', 'fullurl',
  'innertext', 'outerhtml', 'clipboard', 'document.title', 'getselection', 'chrome.cookies',
  'chrome.history', 'chrome.webrequest', 'chrome.webnavigation', 'chrome.scripting', 'executescript',
  'content_scripts',
];

/**
 * Credential identifiers, matched case-sensitively so the DESIGN section 3 field
 * `userName` (a user-typed app label) is not confused with an account username.
 */
export const CREDENTIAL_CASE_RE = /\b(?:username|user_name|password|passwd|passcode|otp_code|Password|Username)\b/;

export function interfaceFields(src, name) {
  const start = src.search(new RegExp(`(?:interface\\s+${name}\\s*|type\\s+${name}\\s*=\\s*)\\{`));
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const body = stripComments(src.slice(open + 1, end));
  const fields = [];
  let d = 0;
  for (const line of body.split('\n')) {
    const m = d === 0 ? line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/) : null;
    if (m) fields.push(m[1]);
    for (const ch of line) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
  }
  return fields.sort();
}

export function checkSchema(typesSrc) {
  const v = [];
  for (const [name, allowed] of Object.entries(SCHEMA_ALLOWLIST)) {
    const fields = interfaceFields(typesSrc, name);
    if (!fields) {
      v.push(`types.ts: persisted type ${name} not found (guard cannot verify it)`);
      continue;
    }
    for (const f of fields) if (!allowed.includes(f)) v.push(`types.ts: ${name}.${f} is not in the Tier-1 allowlist`);
  }
  return v;
}

export function checkTokens(files) {
  const v = [];
  for (const f of files) {
    const code = stripComments(f.text);
    const lower = code.toLowerCase();
    for (const t of TIER2_TOKENS) if (lower.includes(t)) v.push(`${f.path}: Tier-2 token "${t}"`);
    const cred = code.match(CREDENTIAL_CASE_RE);
    if (cred) v.push(`${f.path}: credential identifier "${cred[0]}"`);
    if (f.path !== URL_MODULE) {
      for (const [id, re] of [
        ['url-part', /\.(pathname|search|hash|href|username|password)\b/],
        ['new-url', /\bnew\s+URL\s*\(/],
        ['tab-title', /\.title\b/],
        ['favicon', /favIconUrl/],
      ]) {
        if (re.test(code)) v.push(`${f.path}: ${id} access outside ${URL_MODULE}`);
      }
    }
    if (!f.path.startsWith(UI_DIR) && /\bdocument\./.test(code)) v.push(`${f.path}: document. access outside ${UI_DIR}`);
  }
  return v;
}

function main() {
  const files = walk(resolve(root, 'src'), ['.ts']).map((f) => ({ ...f, path: `src/${f.path}` }));
  const problems = [...checkSchema(readFileSync(resolve(root, 'src/lib/types.ts'), 'utf8')), ...checkTokens(files)];
  if (problems.length) {
    console.error(`tier1 guard: ${problems.length} violation(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`tier1 guard: OK (${files.length} source files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
