# tier1-saas-scan (working name)

A free browser extension that shows **you** which SaaS apps and AI tools you use, and
which unrecognised sites look like accounts. It runs entirely on your device, keeps only
hostnames and day-level time, and never makes a network request.

Status: MVP, unpublished. Design: [`docs/DESIGN.md`](docs/DESIGN.md).
Derived from the Axiom Layer browser extension (see "Provenance" below).

**License: [Apache-2.0](LICENSE)**, covering the code and the bundled catalog data.

## Install (load unpacked)

Requires Node 22+ and Chrome/Chromium 114+ (Edge should also work, but that is untested).

```sh
npm ci            # or: npm install
npm run build     # typecheck + Vite build + no-egress scan of dist/
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Pin the extension, then browse as usual. The popup shows the last 7 days. **Open full report**
   shows everything, with export and data controls.

Chrome shows an install warning for the `tabs` permission. The wording is probably "Read your
browsing history", but that has not been checked here. The extension needs `tabs` to see the
active tab's hostname (details below).

## Privacy statement (matches the code in this repository)

**Nothing leaves your device.** The extension contains no code that sends data anywhere. The
only way data leaves is an export file that you save and then choose to share.

**What is read.** When the active tab changes or navigates, the service worker reads that tab's
URL, id and "active" flag. It never reads the title, favicon or page content. It parses the URL
in memory (in `src/lib/domain.ts`, the only module allowed to do so) and keeps only:
- the **hostname**, for example `acme.slack.com`;
- one **login hint** boolean. It is true if the hostname has a label such as `login.`, `sso.`
  or `accounts.`, or if the path matches `/login`, `/signin`, `/sign-in`, `/sso`, `/oauth` or
  `/saml`. The path is tested in memory and then discarded; it is never stored.

The extension also asks Chrome whether the computer is active, idle or locked (`chrome.idle`).

**What is stored** (in `chrome.storage` for this browser profile only):

| Key | Contents |
|---|---|
| `d:<YYYY-MM-DD>` | For each hostname: focused seconds, attended (non-idle) seconds, a 24-bit mask of the local hours with at least 60 s focused, and a login-hint 0/1 |
| `h:<hostname>` | First and last day seen, and status (auto/accepted/ignored). Also any app name and category **you** typed when accepting a candidate |
| `settings` | Retention days, paused flag, the registrable domains you ignored, schema version |
| session `win` | The open focus window (tab id, hostname, start time, idle state, login hint, and a transient hour key plus seconds counter used to set the hour bit). It is cleared when the browser restarts |

**Never stored or exported:** full URLs, paths, query strings, fragments, page titles, page
content, form values, usernames, passwords, cookies, IP addresses, device or user identifiers,
keystrokes, screenshots, and per-visit timestamps. The finest time detail is the day plus the
hour-of-day mask. Private (incognito) windows are never observed (`"incognito": "not_allowed"`).
These hosts are dropped and never stored: `localhost`, IP addresses, single-label hosts and
non-web pages.

**Retention.** The default is 90 days (you can choose 30, 90, 180 or 365). A daily sweep deletes
older days and removes hostnames that have no remaining days. Hostnames you accepted or ignored are kept
(they hold no browsing data, so imported ignore lists survive).
If storage passes 8 MB, the oldest days are pruned first. Other controls: **Pause**,
**Forget a host**, and **Clear all data**. Clear all data keeps only your retention and pause
settings.

**Exports** (CSV, JSON, printable HTML) are generated on the device and saved with a normal
file download. By default they contain **app names only**, with no hostnames and no candidates.
Adding either one is a separate opt-in. When candidates are included without hostnames, only
their registrable domain is shown, for example `newtool.io` rather than `acme.newtool.io`. Every CSV
cell is quoted (RFC 4180). A cell whose first character, after any leading spaces (including
non-breaking and other Unicode spaces), is `= + - @`, a tab, a carriage return, or a full-width
`＝ ＋ － ＠` is prefixed with `'`, so a spreadsheet cannot run it as a formula. The HTML export contains no script and no external
references.

**Hostnames can identify you.** A hostname alone can sometimes carry identifying data, for
example per-user tunnel, proxy or preview subdomains such as `abc123.ngrok-free.app`,
`my-site.translate.goog` or a preview-deploy host like `app-git-branch-user.vercel.app`.
Hostnames stay on the device and are excluded from default exports. Hosts under ngrok,
`translate.goog` and common preview-deploy domains (Vercel, Netlify, Cloudflare Pages and
similar) are never surfaced as candidates.

**Uninstalling.** Chrome normally deletes an extension's storage when it is uninstalled. This
repository has no test that verifies that, so use **Clear all data** first if it matters to you.

### How "no network requests" is enforced

1. **No content scripts.** No code from this extension runs inside web pages.
2. **Content Security Policy** for all extension pages and the service worker:
   `connect-src 'none'`, `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`,
   `form-action 'none'`. The e2e test confirmed that Chromium 148 accepts this policy and uses
   it to block a `fetch` from the service worker.
3. **Static guard** (`scripts/check-no-egress.mjs`, which `npm run build` and the unit tests
   both run). It scans `src/`, the HTML pages, the manifest and the built `dist/` for `fetch`,
   XHR, WebSocket, EventSource, `sendBeacon`, `importScripts`, native messaging,
   `chrome.identity`, WebRTC, image beacons, any `http(s)://` URL, and browser-mediated egress
   that the policy cannot block (opening a tab or window other than the extension's own report
   page, `setUninstallURL`, `chrome.storage.sync`, `chrome.downloads`). It also checks that the
   manifest has exactly the permissions `tabs`, `storage`, `alarms` and `idle`, no host
   permissions, no content scripts, and the policy above.
4. **Runtime e2e test** (`npm run test:e2e`, in `tests/e2e/no-egress.e2e.mjs`). It loads
   `dist/` into headless Chromium with every hostname resolved to a local fixture server, then
   browses pages with canary strings in the URL and title. It asserts zero network requests and
   zero CSP-blocked attempts from the extension, only the test's own page loads on the fixture
   server, and no canary in storage. Two negative controls inject a `fetch` into a copy of the
   service worker. With the policy in place the fetch is blocked, and the guard reports it as an
   attempt. With the policy removed, the request reaches the fixture server. Both cases show the
   guard can detect a leak.
5. **No runtime dependencies.** `package.json` has only dev dependencies, and the shipped code
   is this repository's TypeScript.

### Permissions

| Permission | Why |
|---|---|
| `tabs` | To read the active tab's URL and derive its hostname. `activeTab` only works after a click. |
| `storage` | Local aggregates (`local`) and the open focus window (`session`). |
| `alarms` | A 1-minute fold of the open window (so a crash loses at most 1 minute) and a daily retention sweep. |
| `idle` | Attended time counts only while the system is active. Locking the screen closes the window. |

There are no host permissions, content scripts, `downloads`, `webRequest`, `scripting`,
`identity`, web-accessible resources, or `key` field. `externally_connectable` is set to
`{"ids": []}`. Chrome accepts the manifest, but no test yet checks that it blocks other
extensions.

## What it can and cannot see

- **Known apps and AI tools.** Hostnames are matched against a bundled catalog
  (`src/catalog/catalog.json`) by exact host, then by the longest parent suffix. So
  `gemini.google.com` counts as Gemini (AI) and `docs.google.com` counts as Google Workspace.
  Google Search is not matched.
- **Candidates to review.** An unmatched host is listed only if it has a login hint, repeat use
  (3 or more days, or 10 or more attended minutes in the range), or a workspace-style subdomain
  beside another candidate or catalog hit. A host is never listed if it is on the curated
  suppression list (`src/catalog/suppression.json`, 370 search, news, social, shopping,
  streaming and CDN domains) or you have ignored it. You can accept a candidate by mapping it to
  a catalog app or giving it your own name and category, or ignore the host or its whole domain.
  Mappings can be exported and imported as JSON so a team can share them.
- **Limits.**
  - The extension only sees this one browser, and never native apps.
  - AI features inside an app you already use (an assistant built into an office suite or a
    notes tool) share that app's hostnames, so they are not detected separately.
  - Idle detection has a 60-second threshold, so the first minute of inactivity still counts
    as attended.
  - The hour-of-day bit needs 60 s within one focus window. Many very short switches within the
    same hour may not set it.
  - Candidate precision has not been measured against a real browsing sample (DESIGN §6
    acceptance fixture: not done).

## Catalog

295 apps, including 114 AI tools, covering 332 domains (`catalog/build.mjs`, version
`2026.09.28-mvp1`). Every entry records where it came from in `sources`:
- `seed`: the 50 entries of Axiom Layer's `supabase/seed/seed-catalog.json`, reduced to name,
  category, subcategory and domains. Three seed entries were adjusted, and each adjustment is
  recorded with its reason in `catalog/build.mjs`. These entries also carry the manual source.
- `manual:mvp-2026-09-28`: 245 entries added for this MVP from general knowledge of each
  vendor's own primary domain. **They were not individually checked against vendor sites.**
  Each needs an evidence check before a public release.

There are no logos or favicons: the UI draws letter avatars. No commercial or third-party
catalog was copied. The Wikidata and awesome-generative-ai pipelines in DESIGN §7 are not built
yet. `catalog.json` is licensed Apache-2.0 with the rest of the project. The upstream sources DESIGN §7
plans to draw on (Wikidata, awesome-generative-ai) are CC0, which is compatible.

## Development

```sh
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest (pinned to TZ=America/Los_Angeles so DST cases are deterministic)
npm run guard       # static Tier-1 and no-egress guards
npm run build       # typecheck + build + dist/ egress scan
npm run test:e2e    # needs a built dist/ and Playwright's Chromium (revision for playwright 1.60.0)
npm run catalog     # rebuild src/catalog/catalog.json from catalog/sources (offline)
```

The e2e test never downloads a browser. If Chromium is missing, it exits with code 2. A
maintainer can install it with `npx playwright install chromium`.

Layout: `src/background.ts` connects `chrome.*` events to `src/lib/service.ts`, which is pure and
tested against in-memory storage. `src/lib/*` holds capture, matching, retention, report and
export. `src/ui/*` holds the popup and report pages (vanilla TypeScript, no framework).

## Provenance

These files started from `smynkr/axiomlayer-oss` (archived snapshot). Each one comes from a file
with a single author identity (DESIGN §11), and each file's header records its origin:
`src/lib/domain.ts`, `src/lib/sanitize.ts`, `src/lib/tracker.ts` (adapted), `src/lib/storage.ts`
(interface only), the strict validation style in `src/lib/catalog.ts` (from `device-catalog.ts`),
the seed catalog, and the starting points of the domain and tracker tests. The catalog matcher
and the Tier-1 guard were rewritten, not copied. All upload, ingest, API-key, RouteShift,
telemetry, OAuth, LLM and managed-policy code was left out.
