import { buildReport } from '../lib/report';
import { parseSettings, SETTINGS_KEY } from '../lib/schema';
import { avatar, el, hours, loadMatcher, nodes, send, snapshot, suppression, today } from './common';

async function render(): Promise<void> {
  const app = document.getElementById('app') as HTMLElement;
  const { matcher, errors } = loadMatcher();
  if (!matcher) {
    app.replaceChildren(el('p', { className: 'error', text: `Catalog failed validation: ${errors.slice(0, 3).join('; ')}` }));
    return;
  }
  const snap = await snapshot();
  const settings = parseSettings(snap[SETTINGS_KEY]);
  const report = buildReport(snap, matcher, suppression, { today: today(), range: 7 });
  const top = [...report.ai, ...report.known].sort((a, b) => b.attendedS - a.attendedS).slice(0, 5);

  const pause = el('button', {
    className: settings.paused ? 'primary' : '',
    text: settings.paused ? 'Resume' : 'Pause',
    attrs: { 'aria-pressed': String(settings.paused) },
    on: {
      click: async () => {
        await send({ type: 'setPaused', paused: !settings.paused });
        await render();
      },
    },
  });

  app.replaceChildren(
    ...nodes(
    el('header', { className: 'row between' }, [el('h1', { text: 'SaaS Scan' }), pause]),
    settings.paused ? el('p', { className: 'notice', text: 'Paused. Nothing is being recorded.' }) : null,
    typeof chrome.idle === 'undefined' ? el('p', { className: 'notice', text: 'Idle detection unavailable: attended time cannot be measured.' }) : null,
    el('p', { className: 'muted', text: 'Last 7 days' }),
    el('div', { className: 'stats' }, [
      stat(report.known.length, 'known apps'),
      stat(report.ai.length, 'AI tools'),
      stat(report.candidates.length, 'to review'),
    ]),
    el('h2', { text: 'Top apps by attended time' }),
    top.length
      ? el(
          'ol',
          { className: 'top' },
          top.map((r) => el('li', {}, [avatar(r.name), el('span', { className: 'grow', text: r.name }), el('span', { className: 'muted', text: `${hours(r.attendedS)} h` })])),
        )
      : el('p', { className: 'muted', text: 'Nothing recorded yet. Browse as usual; data stays on this device.' }),
    el('button', {
      className: 'primary wide',
      text: 'Open full report',
      on: { click: () => void chrome.tabs.create({ url: chrome.runtime.getURL('report.html') }) },
    }),
    el('p', { className: 'fine', text: 'On-device only. This extension makes no network requests.' }),

    ),
  );
}

function stat(n: number, label: string): HTMLElement {
  return el('div', { className: 'stat' }, [el('strong', { text: String(n) }), el('span', { text: label })]);
}

void render();
