// Shared file walker for the static guards.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function walk(dir, exts, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts, root));
    else if (exts.some((e) => name.endsWith(e))) out.push({ path: relative(root, p), abs: p, text: readFileSync(p, 'utf8') });
  }
  return out;
}

/** Remove // line comments and block comments (good enough for this codebase's TS). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
