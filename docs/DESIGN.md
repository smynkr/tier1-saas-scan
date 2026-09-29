# tier1-saas-scan: design

Status: DRAFT for owner review, 2026-09-28. Nothing is built, published or licensed yet.
Origin: derived from Axiom Layer (`smynkr/axiomlayer-oss`, wind-down ticket LAY-796).
Epistemic tags: **[confirmed]** means read or observed directly this session, **[inferred]** means reasoned
from evidence, and **[assumption]** means untested and needing a check. **[owner]** marks a decision the owner must make.

---

## 1. Goal and non-goals

**Goal.** A free browser extension that needs no server. It shows the person running it which SaaS
apps and AI tools they use, and which unrecognized sites look like accounts. It runs entirely on the
device, keeps only Tier-1 data (hostname-level time), and writes a local report the user can export.
Nothing ever leaves the machine unless the user saves an export file and chooses to share it.

**Non-goals.**
- No backend, account, telemetry, crash reporting, analytics, remote config or remote catalog updates.
- No fleet or central collection. An admin who wants a team view collects exports by hand. We will
  not build a collector, because that brings back the server, trust and support costs this design
  removes (see §13, §15).
- No Tier-2 data, even as an opt-in (§3). No blocking or DLP, and no enforcement of any kind.
- No LLM classification. No spend, license or contract data. Hosts are never uploaded for enrichment.
- No MDM or managed-policy config in v1. The `schema.json` managed storage is dropped.

**Why this and not the platform** [inferred]: the 2026-09-28 wind-down assessment found no organic
customer, and it found that a solo owner with little time cannot run a hosted product. Both research
briefs rate a *bounded free utility* as the most plausible free form. The extension is the most
extractable Axiom Layer module: it has no imports from `@axiomlayer/core` or Supabase [confirmed:
`apps/browser-extension/package.json` has only react/react-dom runtime deps; oss-candidates lane].
Success is modest: a few external people use the report more than once. Stars are secondary,
because the closest OSS analogue has 25 stars (§14).

## 2. Users

1. **Individual IT admin or MSP tech** at a small org with no SaaS-management budget. They install it
   on their own machine or a test profile, or ask a few colleagues to run it and send exports.
2. **Security-curious employee** who wants to see their own shadow-IT and shadow-AI footprint before
   a policy review, and share a sanitized version of it.
3. **Small-team lead** who wants a one-off inventory for an audit, a renewal or an AI-policy
   conversation.

In every case the user is the data subject or has their consent. The UX has to make sharing
deliberate (§8 export scope) so the tool does not drift into covert employee monitoring [inferred risk].

## 3. Tier-1 data contract

The contract is the Axiom Layer north-star §1 boundary, **narrowed further**. The original extension
stored the login-form *path* [confirmed: `src/lib/types.ts` `LoginEvent.path`]. This tool does not.

**Persisted in `chrome.storage.local` (the full list; the schema test fails on any other key):**

| Record | Fields |
|---|---|
| `DomainDay` (key `d:<YYYY-MM-DD>`, map by host) | `host` (lowercased hostname, e.g. `acme.slack.com`), `focusedS`, `attendedS` (integer seconds), `hours` (24-bit int: local hours of day with at least 60 s focused), `loginHint` (0/1) |
| `HostMeta` (key `h:<host>`) | `firstDay`, `lastDay` (YYYY-MM-DD, local), `status` (`auto` / `accepted` / `ignored`), optional `userAppId`, `userName`, `userCategory` (user-entered text) |
| `Settings` | `retentionDays`, `paused`, `ignoreRegistrable[]`, `schemaVersion` |

**Transient only (`chrome.storage.session`, cleared on browser restart):** the open focus window,
`{tabId, host, startMs, idleState}`, reused from `TrackerState` [confirmed: `src/lib/tracker.ts`].

**Derived in memory and immediately discarded:** the tab URL. The service worker parses it with
`getDomainFromUrl` to get the hostname. It computes `loginHint` from host labels
(`login.`, `auth.`, `sso.`, `accounts.`, `id.`, `signin.`), or from a transient regex test of the path
for `/(login|signin|sign-in|sso|oauth|saml)(/|$)/`. Only the boolean survives. [owner] If the owner
would rather never read a path even transiently, the fallback is host-label-only, which gives a weaker
signal.

**Explicitly NOT collected, stored or exported:** full URLs, paths, query strings, fragments, page
titles, page content or DOM, form values, usernames, credentials or password hashes (contrast with
hazcod/shade in §14), keystrokes, clicks, screenshots, clipboard, cookies, IP addresses, device or
user identifiers, per-visit timestamps (the finest grain is day plus hour-of-day bit), productivity
scores, and incognito browsing (`"incognito": "not_allowed"`).

**Excluded hosts** (dropped at capture, never stored): non-http(s) schemes, `localhost`, IP literals,
single-label hosts, and the extension's own pages.

## 4. Zero network egress by design

**Invariant:** the shipped extension makes no network request of any kind. There is no `fetch`, XHR,
WebSocket, EventSource, `sendBeacon`, remote `<img>`/`<link>`/`<script>`, `importScripts` from a URL,
`chrome.runtime.connectNative`, `chrome.identity`, or `RTCPeerConnection`. Catalog updates ship only
as extension releases.

**Enforcement is layered, so one layer failing does not open egress:**
1. **Nothing to intercept.** There are no content scripts, so no code runs in web-page context,
   where extension CSP does not apply. The logic runs only in the service worker and extension pages.
2. **CSP.** `content_security_policy.extension_pages` =
   `default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'self' data: blob:; style-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'`.
   Chrome applies the extension-pages policy to the popup, the extension tabs **and the background
   worker**, and does not apply it to content scripts [confirmed: developer.chrome.com CSP reference,
   fetched 2026-09-28]. Chrome sets a minimum (`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`)
   that a policy cannot relax. The docs do not say that stricter directives such as `connect-src 'none'`
   and `object-src 'none'` are accepted [assumption]. The e2e test in §10 must prove Chrome loads the
   manifest and blocks a deliberate `fetch` from the worker.
3. **Static no-egress test** over `src/` and the built `dist/`. It denylists the APIs above and any
   `http://`/`https://` literal outside `README`/`docs`, and it snapshots the manifest (§5) so a new
   permission or host permission fails CI.
4. **Runtime e2e test.** Playwright loads the unpacked build and browses local fixture hosts. It
   asserts that CDP network events from the extension's service-worker and page targets number
   **zero**, and that the fixture server sees no requests beyond the page loads the test itself makes.
5. **Supply chain.** Zero runtime dependencies (vanilla TS, no React) and a lockfile. Dev dependencies
   never enter `dist/`, which a bundle-content test checks.

Exports are made locally as a `Blob` plus `<a download>`, so neither the `downloads` permission nor
a network request is needed.

## 5. Manifest permissions: every entry justified

| Entry | Why | Alternative rejected |
|---|---|---|
| `tabs` | Read the active tab's URL to derive its hostname on activation/update. Install warning: "Read your browsing history" [inferred wording; verify on the CWS listing]. | `activeTab` grants access only after a user click, so it cannot observe passively. `<all_urls>` host permissions give a broader warning and content-script reach we do not need. |
| `storage` | Local aggregates (`local`) and the open focus window (`session`). | IndexedDB would work, but `chrome.storage` keeps the proven MV3 suspend-safe pattern. |
| `alarms` | A 1-min flush of the open window into `DomainDay`, and a daily retention sweep. | Timers do not survive service-worker teardown. |
| `idle` | "Attended" time (focused while the OS reports `active`), and closing the window on `locked`. It replaces the old content-script interaction signal. | Content scripts: ruled out by §4. |
| `"incognito": "not_allowed"` | Private windows are never observed, even if the user flips the toggle. | — |
| `"externally_connectable": {"ids": []}` | Refuses messages from other extensions and web pages [assumption: an empty `ids` array blocks all; test it]. | — |

**Deliberately absent:** `host_permissions`, `content_scripts`, `optional_host_permissions`,
`downloads`, `unlimitedStorage` (10 MB is enough, §9), `webRequest`, `scripting`, `identity`,
`web_accessible_resources`, `nativeMessaging`, the managed `storage.managed_schema`, and the Axiom
`key` field. That key would pin the Axiom Layer extension ID [confirmed present in
`apps/browser-extension/manifest.json`], so a new ID is generated.

## 6. On-device catalog matching

Axiom Layer's `matchToCatalog` has 7 steps [confirmed: `packages/core/src/discovery/catalog-matcher.ts`].
Steps 1-2 need no server, the OAuth step has no signal here, and steps 4-6 depend on an LLM and
Supabase. Per north-star §1, "the catalog stages port to the device, the LLM stage does not."

| Axiom step | Here |
|---|---|
| 1 exact domain | **Ported.** Exact host lookup in a bundled `Map<host, appId>`. |
| 2 subdomain strip | **Ported and changed.** A *longest-suffix* walk: `acme.slack.com` → `slack.com`. The most specific entry wins, so `gemini.google.com` (AI) beats `google.com` (Workspace). This replaces `stripSubdomain`, which jumps straight to the registrable domain and would misfile that case [confirmed from source]. |
| 3 OAuth client ID | **Dropped.** No OAuth signal in a Tier-1 browser tool. |
| 3.5 human alias | **Ported as user overrides.** The user maps a host to a catalog app or to a custom app and category. Stored in `HostMeta`, with import/export as JSON so a small team can share its mappings by hand. |
| 4-5 LLM cache/classify | **Dropped.** Replaced by the candidate heuristics below. |
| 6 review queue | **Ported as the local "Candidates" list** (§8). |

**Unknown-host surfacing (without an LLM).** A catalog miss is the interesting case (north-star §1),
but most misses are ordinary browsing. A host becomes a **candidate** only if it is unmatched, is not
in the bundled **suppression list**, is not user-ignored, and meets at least one of these:
- **Login signal** (`loginHint` on any day). This is the strongest signal and ranks first.
- **Repeat use**: seen on 3 or more distinct days, or 10 or more minutes of attended time in the window.
- **Tenant shape**: a subdomain under a registrable domain that already has another candidate or
  catalog hit (e.g. `acme.newtool.io`). This is a weak signal.

The suppression list is hand-curated, about 300-500 registrable domains: search, news, social,
shopping, streaming, CDN and ad hosts. It lives in-repo, with its own tests. The user can Accept a
candidate (name + category), Ignore the host, or Ignore its whole registrable domain. Grouping by
registrable domain reuses the curated multi-part suffix set in `src/lib/domain.ts` [confirmed]. The
full Public Suffix List (MPL-2.0) is optional, adds about 200 KB, and is not needed in v1 [inferred].
Precision of these heuristics is unmeasured [assumption]. The v1 acceptance fixture is a 2-week
personal browsing sample; it must yield 20 or fewer candidates, most of them real accounts.

**AI tools category.** The catalog carries `category: "AI"` with subcategories: chat assistant, coding
assistant, image/video/audio, meeting/notes, writing, agents/automation, and model/API console. The
report puts AI first. **Known limit** [inferred]: AI features *inside* an already-known SaaS (Notion AI,
Copilot in M365) share that SaaS's hosts and cannot be told apart at Tier-1. The report says so, and it
must not claim to detect them. `normalizeAIGovernanceVendor` in `packages/core/src/discovery/ai-governance.ts`
is vendor-*name* keyword rules. It serves only as a checklist of vendors to include; its code is not reused.

## 7. Catalog: size, provenance, format

**Current seed is too small and too narrow** [confirmed]: `supabase/seed/seed-catalog.json` has 50
entries and 84 domains. It has no AI category (Productivity 15, Engineering 8, others 2-4 each).
One commit identity authored it on 2026-03-23. Its `typical_monthly_price`, `billing_sender_domains`
and `oauth_client_ids` fields are unverified or irrelevant here, so they are dropped.

**Target:** about 1,000 apps for v1, including 150 or more AI tools, and about 2,000 by v1.x. This is
an [assumption] about what covers a typical small-org footprint. It is validated by the fixture
coverage metric: the share of attended time on catalog-matched hosts.

**Build pipeline** (build-time scripts in `catalog/`, maintainer-run; the network use is by the
maintainer's script, never by the extension):
1. **Seed port**: the 50 entries, reduced to name, domains and category.
2. **Wikidata** (CC0 structured data [confirmed: Wikidata:Licensing, fetched 2026-09-28]). A SPARQL
   query for software, web-service and SaaS items with official website P856. It produces
   *candidates*, which the maintainer reviews for category and domain before merging. The yield and
   quality of the category mapping are unknown [assumption].
3. **AI tools**: `steven2358/awesome-generative-ai` [confirmed CC0-1.0 via GitHub API 2026-09-28;
   pushed 2026-09-16] as the list of names. The maintainer resolves each tool's own domain on its
   official site.
4. **Manual PRs**: one entry per line, with the evidence URL (the vendor's own site) in the PR.

**Excluded sources:** commercial catalogs and review sites (G2, Nudge's 175k-profile database, Zylo),
any scraped data whose terms are unclear, logos and favicons (the Axiom repo's 97 vendored logos are a
known redistribution problem [confirmed: oss-candidates lane]), and runtime favicon fetches, which
would also break §4. The UI uses generated letter-avatars.

**Format:** `catalog.json` =
`{formatVersion:1, catalogVersion, generatedAt, license:"Apache-2.0", apps:[{id, name, category, subcategory?, domains[], sources[]}]}`.
`sources` records provenance per entry: `seed` | `wikidata:Q…` | `awesome-genai` | `manual:#PR`.
Validation reuses `validHost` / `sanitizeArtifact`-style strict key checks from `src/lib/device-catalog.ts`
[confirmed]. The ECDSA signature path is dropped, because the catalog is bundled and integrity comes
from store package signing. A size budget test keeps it at 300 KB or less minified [assumption: about
120 B per entry].

[owner] License the catalog data as CC0-1.0, separate from the code license. That matches both
upstream sources. Whether domain-to-vendor facts are copyrightable is a legal question and is not
answered here.

## 8. Report UX and exports

**Popup** (about 320 px): counts (known apps · AI tools · candidates to review) for the last 7 days;
the top 5 apps by attended time; a **Pause** toggle with state visible; a notice when paused or
`idle` is unavailable; and "Open full report".

**Full report** (`report.html`, extension tab). Range selector 7/30/90 days/all.
1. **AI tools**: app, subcategory, hosts, first seen, last seen, days active, attended h, focused h, login hint.
2. **Known apps by category**: collapsible groups with the same columns.
3. **Candidates to review**: host, registrable domain, reasons (login / repeat / tenant-shape),
   first/last seen, days, attended h, with Accept / Ignore host / Ignore domain.
4. **Activity by hour**: a 24-column histogram of days-active per hour of day. This is the "active
   time buckets" view. It is a bar list with an accessible table fallback. No per-day timeline is
   shown, by design.
5. **Data & privacy**: exactly what is stored (rendered from the §3 schema), bytes in use, retention
   setting, clear controls, overrides import/export, catalog version, and a "this extension makes no
   network requests" statement that links to the test in the repo README (text only, no live link needed).

**Exports.** All three share one scope dialog. **Include candidates** is off by default, and
**Hostnames or app names only** defaults to app names. Accepted user overrides count as apps.
- **CSV**, RFC 4180: one row per app or candidate. Any cell starting with `= + - @ \t \r` is
  prefixed with `'` to block formula injection in spreadsheets (an edge case, and tested).
- **JSON**: `{schemaVersion, generatedAt, range, catalogVersion, dataContract, apps[], candidates[]?, hourHistogram}`.
- **Printable HTML**: one self-contained file with inline CSS, **no script and no external
  references**, laid out for Print to PDF. The static test in §4 also scans it.

## 9. Retention and MV3 architecture

**Retention.** The default is 90 rolling days (options 30/90/180/365). A daily `alarms` sweep deletes
`d:<day>` keys older than the window and `HostMeta` rows with no remaining days, except accepted
overrides. There is also **Clear all data** (with a confirm), **Forget this host**, **Pause**, and a
storage guard: if `getBytesInUse` exceeds 8 MB, the oldest days are pruned first. Budget: 300 hosts ×
90 days × about 60 B ≈ 1.6 MB, well under the 10 MB `storage.local` quota [confirmed quota: Chrome
storage API docs, fetched 2026-09-28, 10 MB since Chrome 114]. Chrome removes extension storage on
uninstall [inferred; state it in the README only after a test confirms it].

**Components.**
- `background.ts`, the service worker, event-driven. It uses `tabs.onActivated` / `onUpdated` / `onRemoved`,
  `windows.onFocusChanged` (`WINDOW_ID_NONE` closes the window), `idle.onStateChanged`,
  `alarms.onAlarm`, `runtime.onStartup` / `onInstalled`. The listener set matches the current
  extension [confirmed: `background.ts` lines 345-531]. The upload path, queue and permission-gap
  telemetry are removed.
- The open window lives in `storage.session`. It is **eagerly folded** into `DomainDay` in `storage.local`
  on every transition and on the 1-min alarm, so at most one minute is lost on a crash. Every
  load-mutate-save runs under one promise lock, the `withState` pattern [confirmed in `background.ts`].
- **Time edge cases (design inputs, each tested):** a window that crosses local midnight is split
  across days; hour bits come from local time at the moment of folding; DST and clock jumps are
  handled by clamping negative or over-2h elapsed time to 0 and recording nothing; `locked`
  closes the window; `idle` stops attended time accrual but not focused time; SW teardown mid-window
  is resumed from absolute `startMs` [confirmed pattern: `closeActiveWindow`].
- Extension pages: `popup.html` and `report.html` in vanilla TS and CSS, with a light/dark theme via
  `prefers-color-scheme`.
- Build: Vite plus a plain MV3 manifest. Whether `@crxjs/vite-plugin` (a beta in the current repo
  [confirmed `^2.0.0-beta.23`]) stays or is replaced by a plain multi-entry Vite build is an implementation choice.
  The lighter option is preferred.

## 10. Test strategy

- **Unit (Vitest, plain Node; the pure `src/lib/` split is kept):** domain parsing, suffix-walk
  matcher (including the `gemini.google.com` vs `google.com` precedence), candidate rules,
  suppression, tracker/day-split/DST/idle, retention sweep, byte guard, CSV escaping, JSON schema,
  catalog validation, and a catalog size budget.
- **Tier-1 guard, behavioral:** feed the tracker URLs carrying canary strings in the path, query,
  fragment and userinfo (`/CANARYPATH`, `?token=CANARYQ`, `#CANARYF`, `user:CANARYPW@`), plus a fake tab
  `title: "CANARYTITLE"`. Then dump every storage area and every export format and assert that no
  canary substring appears and that every persisted key matches the §3 allowlist exactly.
- **Tier-1 guard, static:** a rewrite of `scripts/checks/tier1-boundary.mjs`'s two layers (schema-type
  allowlist plus Tier-2 token denylist), extended with `.title`, `pathname`, `search`, `hash` and
  `document.` outside the one URL-parsing module.
- **No-egress guard:** the static denylist and manifest snapshot (§4.3), and the Playwright e2e
  zero-request test (§4.4), including a *negative control*. A test build that calls
  `fetch('http://127.0.0.1:…')` from the worker must be blocked by CSP and must fail the zero-request
  assertion, which proves the guard can see a violation.
- **CI:** one GitHub Actions workflow (typecheck, unit, static guards, build, e2e on headless Chromium).

## 11. Reuse vs rewrite from `apps/browser-extension`

Reuse is limited to files whose whole history is **one commit identity** (the owner's primary)
[confirmed via `git log --format=%ae`, redacted]. That keeps contributor consent (§13) off the
critical path. Two small files that include a second identity are rewritten instead.

| Source | Decision |
|---|---|
| `src/lib/domain.ts` | Reuse: `getDomainFromUrl`, `appNameFromDomain`, multi-part suffix set. Drop `getPathFromUrl`. |
| `src/lib/sanitize.ts` | Reuse `sanitizeUrlToHost`, `isSafeHost`. Drop the login/path message builders. |
| `src/lib/tracker.ts` | Reuse and adapt: attended time comes from `idle`, not content-script activity. Add day/hour folding. |
| `src/lib/storage.ts` | Reuse the `KeyValueStorage` seam and the tolerant-migration style of `loadState`. |
| `src/lib/device-catalog.ts` | Reuse the strict artifact/host validation. Drop ECDSA verify. |
| `src/lib/usage.ts`, `privacy-mode.ts` | Rewrite: fold into `DomainDay` rather than upload rows or aggregates. |
| `packages/core/.../catalog-matcher.ts`, `scripts/checks/tier1-boundary.mjs` | **Rewrite** (second identity in history; both are small). |
| `payload.ts`, `queue.ts`, `idempotency.ts`, `extension-settings.ts`, `credential-destination.ts`, `routeshift-usage.ts`, `content.ts`, options page, `schema.json`, React popup, Axiom icons, manifest `key` | **Drop.** These are upload, backend, RouteShift or brand coupling. |
| Tests: `domain`, `sanitize`, `tracker`, `storage` | Reuse as the starting point. |

Copying is done with `git show <sha>:<path>` from a recorded commit. Untracked or local files
(`.env*`, `.vercel`, settings) are never copied, and each reused file's header notes where it came from.

## 12. Distribution

[owner] **Chrome Web Store.** A one-time US$5 developer registration fee [confirmed:
developer.chrome.com/docs/webstore/register and 2026 secondary sources, searched 2026-09-28]. The
listing needs a privacy disclosure ("no data collected or transmitted"), which is true by
construction. The `tabs` warning should be explained on the listing. Axiom Layer never published a
CWS item [confirmed: data-obligations lane, `error-unknownApplication`], so no ID or brand carries over.
**Edge Add-ons** takes the same package for no fee [inferred; verify]. **Firefox (later):** MV3 there
uses `background.scripts` rather than `service_worker`, so a small manifest variant and an AMO review
are needed [inferred]. Out of v1.
**Sideload path** is always available: a signed-off release zip on GitHub plus "Load unpacked" steps,
for people who will not install from a store.
**Naming and brand:** no Axiom marks or domains [owner: final name].

## 13. Maintenance budget (≤ 1 h/week) and license

**Budget, averaged** [assumption]: the catalog PR queue takes about 30 min/week, batched monthly. Chrome
MV3 or policy changes take about 15 min/week, averaged as a quarterly check. Issue triage takes about
15 min/week. Anything larger waits or is declined. What keeps the budget small: no server, zero
runtime deps, no remote catalog, no support SLA, and issue templates that ask for host plus category
only. If the budget is exceeded for 2 months running, the README says the catalog is frozen and the
repo moves to archive-with-sideload.

**License: TBD pending contributor consent.** [owner] The Axiom Layer history has more than one human
author identity [confirmed: critic gap; seven author names and six emails across all refs]. Until
consent is recorded, the new repo gets no LICENSE file and is not published. The oss-candidates lane
recommends Apache-2.0 for code [research-lane reported], with the catalog data under CC0-1.0 (§7).

## 14. Positioning (checked 2026-09-28)

| Tool | Model | Relevance |
|---|---|---|
| **Nudge Security** free shadow-AI/IT inventory | Needs a read-only Google Workspace / M365 email connection. ML on email metadata on their servers. The page says "preview… start a free trial", so it is a **trial, not free-forever** [confirmed from page text; this corrects the 2026-09-28 brief's "free inventory" wording]. | Org-wide and far broader. Needs admin OAuth and hands metadata to a vendor. This tool needs no admin, no OAuth and no vendor, but sees only one browser. |
| **SaaSLens** (Wondermove-Inc) | MIT; 25★ / 1 fork; created 2026-04-17, last push 2026-07-17 [confirmed GitHub API]. A self-hosted Next.js/Postgres platform with an optional login-capture extension and optional OpenAI classification. | Needs a server and ops. Closest OSS analogue; its low adoption sets the expectations here. |
| **hazcod/shade** | Apache-2.0; 45★; last push 2026-08-05 [confirmed]. An extension plus a Go backend. It captures domain, **username, SHA-512 password hash**, MFA status, IP and hostname [confirmed README]. | The anti-pattern. Credential-adjacent collection is exactly what §3 forbids. |

**Differentiator:** there is no server, no account, no admin consent and no credential contact, and
the Tier-1 contract and zero egress are both enforced by tests. **Weakness:** one browser only, no
native apps, AI-inside-SaaS is invisible, and a hand-maintained catalog.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Used for covert employee monitoring | Local-only, scope dialog defaults to app names without candidates, no fleet mode, visible Pause, README ethics note. It cannot be prevented entirely [inferred]. |
| `tabs` install warning deters installs | The listing explains it; the no-egress proof is linked; the sideload path remains. |
| Stricter CSP directives rejected by Chrome | Checked on day one by the e2e test (§4). Fallback: the minimum CSP plus the static and e2e guards. |
| Candidate noise overwhelms users | Suppression list, thresholds, ignore-domain, and the fixture acceptance bar (§6). |
| Catalog goes stale and coverage drops | Coverage metric in the fixture; frozen-catalog clause (§13). |
| Wikidata yield is poor | The AI list and manual PRs are enough for v1; scale the target down rather than scrape. |
| CWS policy or review changes | Sideload zip; the Firefox/Edge ports stay optional. |
| Owner time exceeds budget | Archive clause (§13). |
| Reused code license blocked | Reuse only single-identity files (§11); rewrite the rest. |

## 16. Research inputs and gaps

**Reused:** `~/.omp/research/axiom-layer-commercial-viability-2026-09-25.md` (including the
2026-09-28 refresh), `axiom-layer-product-polish-2026-08-26.md`, the wind-down `assessment.json`
(oss-candidates, commercial-viability, data-obligations lanes and critic), and axiomlayer wiki
`north-star.md` §1 and `discovery-and-classification.md`, all in the private upstream repository's internal wiki (not published).

**Fetched 2026-09-28:**
- developer.chrome.com: extension CSP reference, storage API, webstore/register.
- nudgesecurity.com/try-nudge/free-shadow-ai-inventory-tool.
- github.com/Wondermove-Inc/saaslens, github.com/hazcod/shade, github.com/steven2358/awesome-generative-ai (GitHub API).
- wikidata.org Wikidata:Licensing (via search result).

**Gaps:**
- There is no user evidence (reviews, interviews, playtests) that anyone wants a single-browser local
  report, so demand is unvalidated [unknown].
- Candidate-heuristic precision, Wikidata yield, the CSP strict-directive acceptance, the
  `externally_connectable` empty-ids behavior and Edge's fee all need checks before or during build.
- The shared `~/.omp/research/INDEX.md` was not updated, because this task was scoped to the target
  directory.


> **Decision 2026-09-29 (owner):** the whole project, code and catalog data, is licensed Apache-2.0. This supersedes the CC0-for-data proposal in §7/§13.
