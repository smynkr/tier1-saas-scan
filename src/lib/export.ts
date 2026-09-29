// Local exports (DESIGN section 8). All three formats share one scope:
// candidates are excluded and hostnames are omitted unless the user opts in.
import { formatHours, type AppRow, type CandidateRow, type Report } from './report';

export interface ExportScope {
  includeCandidates: boolean;
  /** 'apps' = app names only (default); 'hosts' = also list hostnames. */
  detail: 'apps' | 'hosts';
}

export const DEFAULT_EXPORT_SCOPE: ExportScope = { includeCandidates: false, detail: 'apps' };

export const DATA_CONTRACT =
  'Tier-1 only: hostname and day-level time. No URLs, paths, query strings, page titles, page content, form values, credentials or per-visit timestamps. Generated on-device; the extension makes no network requests.';

export interface ExportMeta {
  generatedAt: string;
}

// ---------- CSV (RFC 4180 + spreadsheet formula-injection guard) ----------

// OWASP CSV injection: leading = + - @ TAB CR, and their full-width forms.
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
// Leading characters a spreadsheet may skip before evaluating: ASCII space/LF/VT/FF, NBSP and other
// Unicode spaces (TAB and CR are themselves triggers, so they are not trimmed).
const LEADING_SPACE = /^[ \n\v\f\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]+/;

/**
 * Neutralise spreadsheet formulas, then quote every cell per RFC 4180 (internal quotes doubled).
 * Always quoting also stops a `;`-separator locale from splitting `x;=FORMULA` into a new cell.
 */
export function csvCell(value: string | number | boolean): string {
  let s = String(value);
  if (FORMULA_START.test(s.replace(LEADING_SPACE, ''))) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(cells: Array<string | number | boolean>): string {
  return cells.map(csvCell).join(',');
}

export function toCsv(report: Report, scope: ExportScope): string {
  const withHosts = scope.detail === 'hosts';
  const header = ['type', 'name', 'category', 'subcategory', 'days_active', 'attended_hours', 'focused_hours', 'first_seen', 'last_seen', 'login_hint', 'reasons'];
  if (withHosts) header.push('hosts');
  const lines = [csvRow(header)];
  const appLine = (r: AppRow) => {
    const cells: Array<string | number> = [
      r.source === 'user' ? 'app (user)' : 'app',
      r.name,
      r.category,
      r.subcategory ?? '',
      r.daysActive,
      formatHours(r.attendedS),
      formatHours(r.focusedS),
      r.firstSeen,
      r.lastSeen,
      r.loginHint ? 'yes' : 'no',
      '',
    ];
    if (withHosts) cells.push(r.hosts.join(' '));
    lines.push(csvRow(cells));
  };
  report.ai.forEach(appLine);
  report.known.forEach(appLine);
  if (scope.includeCandidates) {
    for (const c of report.candidates) {
      const cells: Array<string | number> = [
        'candidate',
        candidateLabel(c, scope),
        '',
        '',
        c.daysActive,
        formatHours(c.attendedS),
        formatHours(c.focusedS),
        c.firstSeen,
        c.lastSeen,
        c.reasons.includes('login') ? 'yes' : 'no',
        c.reasons.join(' '),
      ];
      if (withHosts) cells.push(c.host);
      lines.push(csvRow(cells));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** In app-names mode a candidate is shown only by its registrable domain, never its full host. */
function candidateLabel(c: CandidateRow, scope: ExportScope): string {
  return scope.detail === 'hosts' ? c.host : c.registrable;
}

// ---------- JSON ----------

export function toJsonObject(report: Report, scope: ExportScope, meta: ExportMeta): Record<string, unknown> {
  const withHosts = scope.detail === 'hosts';
  const app = (r: AppRow) => ({
    name: r.name,
    category: r.category,
    ...(r.subcategory ? { subcategory: r.subcategory } : {}),
    source: r.source,
    ...(withHosts ? { hosts: r.hosts } : {}),
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    daysActive: r.daysActive,
    attendedHours: Number(formatHours(r.attendedS)),
    focusedHours: Number(formatHours(r.focusedS)),
    loginHint: r.loginHint,
  });
  const out: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: meta.generatedAt,
    range: report.range,
    catalogVersion: report.catalogVersion,
    dataContract: DATA_CONTRACT,
    scope,
    apps: [...report.ai, ...report.known].map(app),
  };
  if (scope.includeCandidates) {
    out.candidates = report.candidates.map((c) => ({
      [withHosts ? 'host' : 'registrableDomain']: candidateLabel(c, scope),
      reasons: c.reasons,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      daysActive: c.daysActive,
      attendedHours: Number(formatHours(c.attendedS)),
      focusedHours: Number(formatHours(c.focusedS)),
    }));
  }
  out.hourHistogram = report.hourHistogram;
  return out;
}

export function toJson(report: Report, scope: ExportScope, meta: ExportMeta): string {
  return `${JSON.stringify(toJsonObject(report, scope, meta), null, 2)}\n`;
}

// ---------- Printable HTML (no script, no external references) ----------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

export function toPrintableHtml(report: Report, scope: ExportScope, meta: ExportMeta): string {
  const withHosts = scope.detail === 'hosts';
  const th = (cols: string[]) => `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const td = (cols: Array<string | number>) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`;
  const appCols = ['App', 'Category', 'Subcategory', 'Days', 'Attended h', 'Focused h', 'First seen', 'Last seen', 'Login hint', ...(withHosts ? ['Hosts'] : [])];
  const appRow = (r: AppRow) =>
    td([r.name, r.category, r.subcategory ?? '', r.daysActive, formatHours(r.attendedS), formatHours(r.focusedS), r.firstSeen, r.lastSeen, r.loginHint ? 'yes' : 'no', ...(withHosts ? [r.hosts.join(' ')] : [])]);
  const section = (title: string, head: string, body: string[]) =>
    `<h2>${escapeHtml(title)}</h2>${body.length ? `<table>${head}${body.join('')}</table>` : '<p>None in this range.</p>'}`;

  const parts = [
    section('AI tools', th(appCols), report.ai.map(appRow)),
    section('Known apps', th(appCols), report.known.map(appRow)),
  ];
  if (scope.includeCandidates) {
    parts.push(
      section(
        'Candidates (unrecognised sites that look like accounts)',
        th([withHosts ? 'Host' : 'Registrable domain', 'Reasons', 'Days', 'Attended h', 'First seen', 'Last seen']),
        report.candidates.map((c) => td([candidateLabel(c, scope), c.reasons.join(', '), c.daysActive, formatHours(c.attendedS), c.firstSeen, c.lastSeen])),
      ),
    );
  }
  parts.push(
    section('Activity by hour of day (days active)', th(report.hourHistogram.map((_, h) => String(h))), [td(report.hourHistogram)]),
  );
  const rangeText = report.range.from ? `${report.range.from} to ${report.range.to}` : `all retained days to ${report.range.to}`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>SaaS and AI tool report</title>',
    '<style>body{font:13px/1.4 system-ui,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0 20px}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}h1{font-size:20px}h2{font-size:16px;margin-top:24px}p.meta{color:#444}@media print{h2{break-after:avoid}tr{break-inside:avoid}}</style>',
    '</head><body>',
    '<h1>SaaS and AI tool report</h1>',
    `<p class="meta">Range: ${escapeHtml(rangeText)}. Generated ${escapeHtml(meta.generatedAt)}. Catalog ${escapeHtml(report.catalogVersion)}.</p>`,
    `<p class="meta">${escapeHtml(DATA_CONTRACT)}</p>`,
    '<p class="meta">AI features inside an already-known app (for example an assistant built into an office suite) share that app\'s hostnames and are not detected separately.</p>',
    ...parts,
    '</body></html>',
    '',
  ].join('\n');
}
