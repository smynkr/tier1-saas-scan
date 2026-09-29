import { AI_CATEGORY, AI_SUBCATEGORIES, type Matcher } from '../lib/catalog';
import { DEFAULT_EXPORT_SCOPE, toCsv, toJson, toPrintableHtml, type ExportScope } from '../lib/export';
import { exportOverrides } from '../lib/overrides';
import { buildReport, type AppRow, type CandidateRow, type RangeOption, type Report } from '../lib/report';
import { classifyLocalKey, HOST_PREFIX, parseHostMeta, parseSettings, SETTINGS_KEY, STORED_SCHEMA_DESCRIPTION } from '../lib/schema';
import { RETENTION_OPTIONS, type Settings } from '../lib/types';
import { avatar, el, hours, loadMatcher, nodes, send, snapshot, suppression, today } from './common';

const RANGE_KEY = 'saas-scan.range';
let range: RangeOption = readRange();
let scope: ExportScope = { ...DEFAULT_EXPORT_SCOPE };

function readRange(): RangeOption {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (v === 'all') return 'all';
    const n = Number(v);
    return n === 7 || n === 30 || n === 90 ? n : 30;
  } catch {
    return 30;
  }
}

function writeRange(r: RangeOption): void {
  try {
    localStorage.setItem(RANGE_KEY, String(r));
  } catch {
    /* per-viewer convenience only */
  }
}

const app = document.getElementById('app') as HTMLElement;

async function render(): Promise<void> {
  const { matcher, errors } = loadMatcher();
  if (!matcher) {
    app.replaceChildren(el('p', { className: 'error', text: `Catalog failed validation: ${errors.slice(0, 5).join('; ')}` }));
    return;
  }
  const snap = await snapshot();
  const settings = parseSettings(snap[SETTINGS_KEY]);
  const report = buildReport(snap, matcher, suppression, { today: today(), range });
  const bytes = await chrome.storage.local.getBytesInUse(null);

  app.replaceChildren(
    ...nodes(
    header(settings),
    settings.paused ? el('p', { className: 'notice', text: 'Recording is paused. The report shows what was recorded before the pause.' }) : null,
    appSection('AI tools', report.ai, 'No AI tools seen in this range.'),
    el('p', {
      className: 'fine',
      text: 'AI features inside an app you already use (for example an assistant built into an office suite or a notes app) share that app\'s hostnames and cannot be told apart at this level. They are not detected separately.',
    }),
    knownSection(report),
    candidatesSection(report),
    hourSection(report),
    privacySection(snap, settings, bytes, matcher),
    exportDialog(report),
    acceptDialog(matcher),

    ),
  );
}

function header(settings: Settings): HTMLElement {
  const select = el(
    'select',
    { attrs: { 'aria-label': 'Date range' }, on: { change: (e) => void setRange((e.target as HTMLSelectElement).value) } },
    (
      [
        ['7', 'Last 7 days'],
        ['30', 'Last 30 days'],
        ['90', 'Last 90 days'],
        ['all', 'All retained'],
      ] as const
    ).map(([v, label]) => {
      const o = el('option', { text: label, attrs: { value: v } });
      if (String(range) === v) o.selected = true;
      return o;
    }),
  );
  return el('header', { className: 'row between wrap' }, [
    el('div', {}, [el('h1', { text: 'SaaS and AI tool report' }), el('p', { className: 'muted', text: 'Everything here was computed on this device from hostnames and day-level time.' })]),
    el('div', { className: 'row' }, [
      select,
      el('button', {
        text: settings.paused ? 'Resume recording' : 'Pause recording',
        on: {
          click: async () => {
            await send({ type: 'setPaused', paused: !settings.paused });
            await render();
          },
        },
      }),
      el('button', { className: 'primary', text: 'Export…', on: { click: () => (document.getElementById('export-dialog') as HTMLDialogElement).showModal() } }),
    ]),
  ]);
}

async function setRange(v: string): Promise<void> {
  range = v === 'all' ? 'all' : (Number(v) as RangeOption);
  writeRange(range);
  await render();
}

const APP_COLS = ['App', 'Subcategory', 'Hosts', 'First seen', 'Last seen', 'Days', 'Attended h', 'Focused h', 'Login'];

function appTable(rows: AppRow[]): HTMLElement {
  return el('div', { className: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, APP_COLS.map((c) => el('th', { text: c, attrs: { scope: 'col' } })))]),
      el(
        'tbody',
        {},
        rows.map((r) =>
          el('tr', {}, [
            el('td', {}, [el('span', { className: 'row' }, [avatar(r.name), r.source === 'user' ? `${r.name} (yours)` : r.name])]),
            el('td', { text: r.subcategory ?? '' }),
            el('td', { className: 'hosts', text: r.hosts.join(', ') }),
            el('td', { text: r.firstSeen }),
            el('td', { text: r.lastSeen }),
            el('td', { className: 'num', text: String(r.daysActive) }),
            el('td', { className: 'num', text: hours(r.attendedS) }),
            el('td', { className: 'num', text: hours(r.focusedS) }),
            el('td', { text: r.loginHint ? 'yes' : '' }),
          ]),
        ),
      ),
    ]),
  ]);
}

function appSection(title: string, rows: AppRow[], empty: string): HTMLElement {
  return el('section', {}, [el('h2', { text: `${title} (${rows.length})` }), rows.length ? appTable(rows) : el('p', { className: 'muted', text: empty })]);
}

function knownSection(report: Report): HTMLElement {
  const byCat = new Map<string, AppRow[]>();
  for (const r of report.known) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)?.push(r);
  }
  return el('section', {}, [
    el('h2', { text: `Known apps by category (${report.known.length})` }),
    byCat.size
      ? el(
          'div',
          {},
          [...byCat.entries()].map(([cat, rows]) => {
            const d = el('details', {}, [el('summary', { text: `${cat} (${rows.length})` }), appTable(rows)]);
            d.open = true;
            return d;
          }),
        )
      : el('p', { className: 'muted', text: 'No catalog apps seen in this range.' }),
  ]);
}

let acceptTarget: string | null = null;

function candidatesSection(report: Report): HTMLElement {
  const rows = report.candidates;
  return el('section', {}, [
    el('h2', { text: `Candidates to review (${rows.length})` }),
    el('p', {
      className: 'muted',
      text: 'Unrecognised sites with a login signal, repeat use, or a workspace-style subdomain. Accept one to count it as an app, or ignore it.',
    }),
    rows.length
      ? el('div', { className: 'table-wrap' }, [
          el('table', {}, [
            el('thead', {}, [
              el('tr', {}, ['Host', 'Domain', 'Reasons', 'First seen', 'Last seen', 'Days', 'Attended h', 'Actions'].map((c) => el('th', { text: c, attrs: { scope: 'col' } }))),
            ]),
            el('tbody', {}, rows.map(candidateRow)),
          ]),
        ])
      : el('p', { className: 'muted', text: 'Nothing to review.' }),
  ]);
}

function candidateRow(c: CandidateRow): HTMLElement {
  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    await render();
  };
  return el('tr', {}, [
    el('td', { className: 'hosts', text: c.host }),
    el('td', { text: c.registrable }),
    el('td', { text: c.reasons.join(', ') }),
    el('td', { text: c.firstSeen }),
    el('td', { text: c.lastSeen }),
    el('td', { className: 'num', text: String(c.daysActive) }),
    el('td', { className: 'num', text: hours(c.attendedS) }),
    el('td', { className: 'actions' }, [
      el('button', {
        text: 'Accept…',
        on: {
          click: () => {
            acceptTarget = c.host;
            const d = document.getElementById('accept-dialog') as HTMLDialogElement;
            (d.querySelector('.accept-host') as HTMLElement).textContent = c.host;
            d.showModal();
          },
        },
      }),
      el('button', { text: 'Ignore host', on: { click: () => void act(() => send({ type: 'ignoreHost', host: c.host })) } }),
      el('button', { text: `Ignore ${c.registrable}`, on: { click: () => void act(() => send({ type: 'ignoreDomain', registrable: c.registrable })) } }),
    ]),
  ]);
}

function acceptDialog(matcher: Matcher): HTMLElement {
  const names = [...matcher.catalog.apps].sort((a, b) => a.name.localeCompare(b.name));
  const nameInput = el('input', { attrs: { list: 'catalog-names', maxlength: '80', required: '', 'aria-label': 'App name' } });
  const catInput = el('input', { attrs: { list: 'category-names', maxlength: '80', 'aria-label': 'Category', placeholder: 'Category' } });
  const categories = [...new Set([...matcher.catalog.apps.map((a) => a.category), AI_CATEGORY])].sort();
  const status = el('p', { className: 'error' });
  const dialog = el('dialog', { attrs: { id: 'accept-dialog', 'aria-labelledby': 'accept-title' } }, [
    el('h2', { attrs: { id: 'accept-title' } }, ['Accept ', el('span', { className: 'accept-host' })]),
    el('p', { className: 'muted', text: 'Pick a catalog app to map this host to it, or type your own app name and category.' }),
    el('label', {}, ['App ', nameInput]),
    el('datalist', { attrs: { id: 'catalog-names' } }, names.map((a) => el('option', { attrs: { value: a.name } }))),
    el('label', {}, ['Category ', catInput]),
    el('datalist', { attrs: { id: 'category-names' } }, categories.map((c) => el('option', { attrs: { value: c } }))),
    el('p', { className: 'fine', text: `AI subcategories used in the catalog: ${AI_SUBCATEGORIES.join(', ')}.` }),
    status,
    el('div', { className: 'row end' }, [
      el('button', { text: 'Cancel', on: { click: () => dialog.close() } }),
      el('button', {
        className: 'primary',
        text: 'Accept',
        on: {
          click: async () => {
            if (!acceptTarget) return;
            const typed = nameInput.value.trim();
            if (!typed) {
              status.textContent = 'Enter an app name.';
              return;
            }
            const hit = matcher.catalog.apps.find((a) => a.name.toLowerCase() === typed.toLowerCase());
            const res = hit
              ? await send({ type: 'accept', host: acceptTarget, appId: hit.id })
              : await send({ type: 'accept', host: acceptTarget, name: typed, category: catInput.value.trim() || 'Other' });
            if (!res.ok) {
              status.textContent = res.error ?? 'Failed.';
              return;
            }
            dialog.close();
            await render();
          },
        },
      }),
    ]),
  ]);
  return dialog;
}

function hourSection(report: Report): HTMLElement {
  const max = Math.max(1, ...report.hourHistogram);
  const bars = el(
    'div',
    { className: 'bars', attrs: { 'aria-hidden': 'true' } },
    report.hourHistogram.map((n, h) => {
      const bar = el('span', { className: 'bar' });
      bar.style.height = `${Math.round((n / max) * 100)}%`;
      return el('div', { className: 'bar-col' }, [el('div', { className: 'bar-track' }, [bar]), el('span', { className: 'bar-label', text: String(h) })]);
    }),
  );
  const table = el('details', {}, [
    el('summary', { text: 'Show as table' }),
    el('div', { className: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { text: 'Hour', attrs: { scope: 'col' } }), el('th', { text: 'Days active', attrs: { scope: 'col' } })])]),
        el('tbody', {}, report.hourHistogram.map((n, h) => el('tr', {}, [el('td', { text: `${h}:00` }), el('td', { className: 'num', text: String(n) })]))),
      ]),
    ]),
  ]);
  return el('section', {}, [
    el('h2', { text: 'Activity by hour of day' }),
    el('p', { className: 'muted', text: `Days (of ${report.daysWithData} with data) with at least one minute of browsing in each local hour. No per-day timeline is kept.` }),
    bars,
    table,
  ]);
}

function download(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a', { attrs: { href: url, download: filename } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportDialog(report: Report): HTMLElement {
  const cand = el('input', { attrs: { type: 'checkbox' } });
  cand.checked = scope.includeCandidates;
  const hostsMode = el('input', { attrs: { type: 'checkbox' } });
  hostsMode.checked = scope.detail === 'hosts';
  const sync = () => {
    scope = { includeCandidates: cand.checked, detail: hostsMode.checked ? 'hosts' : 'apps' };
  };
  cand.addEventListener('change', sync);
  hostsMode.addEventListener('change', sync);
  const stamp = () => new Date().toISOString();
  const base = () => `saas-scan-${report.range.to}`;
  const dialog = el('dialog', { attrs: { id: 'export-dialog', 'aria-labelledby': 'export-title' } }, [
    el('h2', { text: 'Export', attrs: { id: 'export-title' } }),
    el('p', { className: 'muted', text: 'Files are generated on this device. Sharing them is your decision. Review the scope first.' }),
    el('label', { className: 'check' }, [cand, ' Include candidates (unrecognised sites)']),
    el('label', { className: 'check' }, [hostsMode, ' Include hostnames (otherwise app names only; candidates show only their registrable domain)']),
    el('div', { className: 'row wrap' }, [
      el('button', { text: 'CSV', on: { click: () => download(`${base()}.csv`, 'text/csv', toCsv(report, scope)) } }),
      el('button', { text: 'JSON', on: { click: () => download(`${base()}.json`, 'application/json', toJson(report, scope, { generatedAt: stamp() })) } }),
      el('button', { text: 'Printable HTML', on: { click: () => download(`${base()}.html`, 'text/html', toPrintableHtml(report, scope, { generatedAt: stamp() })) } }),
      el('button', { text: 'Close', on: { click: () => dialog.close() } }),
    ]),
  ]);
  return dialog;
}

function privacySection(snap: Record<string, unknown>, settings: Settings, bytes: number, matcher: Matcher): HTMLElement {
  const retention = el(
    'select',
    {
      attrs: { 'aria-label': 'Retention' },
      on: {
        change: async (e) => {
          await send({ type: 'setRetention', retentionDays: Number((e.target as HTMLSelectElement).value) });
          await render();
        },
      },
    },
    RETENTION_OPTIONS.map((d) => {
      const o = el('option', { text: `${d} days`, attrs: { value: String(d) } });
      if (d === settings.retentionDays) o.selected = true;
      return o;
    }),
  );
  const forgetInput = el('input', { attrs: { placeholder: 'hostname, e.g. app.example.com', 'aria-label': 'Hostname to forget', maxlength: '253' } });
  const forgetStatus = el('span', { className: 'muted' });
  const importStatus = el('span', { className: 'muted' });
  const fileInput = el('input', { attrs: { type: 'file', accept: 'application/json,.json', 'aria-label': 'Import overrides file' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const res = await send({ type: 'importOverrides', data: JSON.parse(await file.text()) });
      importStatus.textContent = res.ok ? 'Imported.' : `Rejected: ${res.error ?? 'invalid file'}`;
      if (res.ok) await render();
    } catch {
      importStatus.textContent = 'Rejected: not valid JSON.';
    }
  });

  const overrides: HTMLElement[] = [];
  for (const [key, value] of Object.entries(snap)) {
    if (classifyLocalKey(key) !== 'host') continue;
    const meta = parseHostMeta(value);
    if (!meta || meta.status === 'auto') continue;
    const host = key.slice(HOST_PREFIX.length);
    const label =
      meta.status === 'accepted'
        ? `${host} → ${meta.userAppId ? (matcher.byId.get(meta.userAppId)?.name ?? meta.userAppId) : `${meta.userName} (${meta.userCategory ?? 'Other'})`}`
        : `${host} (ignored)`;
    overrides.push(
      el('li', {}, [
        label,
        ' ',
        el('button', {
          className: 'link',
          text: 'Reset',
          on: {
            click: async () => {
              await send({ type: 'resetHost', host });
              await render();
            },
          },
        }),
      ]),
    );
  }
  for (const d of settings.ignoreRegistrable) {
    overrides.push(
      el('li', {}, [
        `${d} and all its subdomains (ignored)`,
        ' ',
        el('button', {
          className: 'link',
          text: 'Un-ignore',
          on: {
            click: async () => {
              await send({ type: 'unignoreDomain', registrable: d });
              await render();
            },
          },
        }),
      ]),
    );
  }

  return el('section', { className: 'privacy' }, [
    el('h2', { text: 'Data and privacy' }),
    el('p', { text: 'This extension makes no network requests. Its security policy blocks all connections, and the repository README describes the automated tests that check this.' }),
    el('h3', { text: 'Exactly what is stored (in this browser profile only)' }),
    el('ul', {}, STORED_SCHEMA_DESCRIPTION.map((s) => el('li', {}, [el('code', { text: s.key }), `: ${s.fields}`]))),
    el('p', { className: 'muted', text: 'Never stored: full URLs, paths, query strings, page titles, page content, form values, credentials, per-visit timestamps. Private (incognito) windows are never observed.' }),
    el('p', {}, [`Storage in use: ${(bytes / 1024).toFixed(1)} KB. Catalog: ${matcher.catalog.catalogVersion} (${matcher.catalog.apps.length} apps).`]),
    el('div', { className: 'row wrap' }, [el('label', {}, ['Keep data for ', retention])]),
    el('h3', { text: 'Forget a host' }),
    el('div', { className: 'row wrap' }, [
      forgetInput,
      el('button', {
        text: 'Forget',
        on: {
          click: async () => {
            const res = await send({ type: 'forgetHost', host: forgetInput.value.trim().toLowerCase() });
            forgetStatus.textContent = res.ok ? 'Forgotten.' : 'Not a valid hostname.';
            if (res.ok) await render();
          },
        },
      }),
      forgetStatus,
    ]),
    el('h3', { text: 'Your mappings and ignores' }),
    overrides.length ? el('ul', {}, overrides) : el('p', { className: 'muted', text: 'None yet.' }),
    el('div', { className: 'row wrap' }, [
      el('button', {
        text: 'Export mappings (JSON)',
        on: { click: () => download('saas-scan-mappings.json', 'application/json', `${JSON.stringify(exportOverrides(snap), null, 2)}\n`) },
      }),
      el('label', {}, ['Import mappings ', fileInput]),
      importStatus,
    ]),
    el('h3', { text: 'Clear everything' }),
    el('button', {
      className: 'danger',
      text: 'Clear all data…',
      on: {
        click: async () => {
          if (!confirm('Delete all recorded activity, mappings and ignores from this browser? This cannot be undone.')) return;
          await send({ type: 'clearAll' });
          await render();
        },
      },
    }),
  ]);
}

void render();
