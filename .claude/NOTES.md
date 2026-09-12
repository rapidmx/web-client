# Code review notes — rapidrest/mail-server

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing decisions

- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.
- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).
- **Never bump a `package.json` `version` field, in this repo or any sibling `@rapidrest/*` repo,
  and never publish/`npm publish` one.** JP has a formal release process for that (see e.g.
  `mail-server`'s own `"version"`/`"postversion"` npm-lifecycle scripts, which sync the Helm
  chart/README and push tags — a manual version edit bypasses all of that and produces conflicts).
  This applies even when a fix in a sibling repo is otherwise done and verified: land the source
  fix, leave the version field alone, and tell JP it's ready for him to version/publish himself.
  Once he publishes, bump *this* repo's dependency constraint (e.g. `"@rapidrest/auth": "^X.Y.Z"`)
  to the version he actually published — that part is fine, since it's just declaring what this
  repo needs, not deciding a sibling repo's own release number.

## Session Log

### 2026-09-11 — Moved 8 generic UI components out to react-shared

JP: react-shared should be the home for anything reusable across *any* RapidMX front-end,
components included, not just business logic (see that repo's own NOTES.md for the full
reorg). `Button`, `Alert`, `Skeleton`+`SkeletonList`, `FormField`, `PopoverPortal`,
`MiniDatePicker`, `ContactAvatar`, and `BottomTabBar` — all genuinely domain-agnostic (no
`@rapidmx/react-shared/mail|calendar|contacts|.../*Api.js` imports, no webmail terminology) —
moved from `apps/shared/components/**` into `react-shared/src/components/**`. Every remaining
component under `apps/shared/components/` is domain-specific and stays here.

- **~100 of this repo's own imports had to change**: `@rapidmx/react-shared/components/<kind>/
  <Name>.js` instead of a relative path into `apps/shared/components/**`. Scripted via a rename
  map matched on each old import's distinguishing trailing path segment (e.g. `feedback/Alert.js`)
  regardless of the importing file's own relative depth — but that approach only catches imports
  that *include* the old folder name in their specifier. It missed **same-directory bare
  imports**: a file that already lived inside e.g. `apps/shared/components/layout/` importing
  `BottomTabBar` as plain `"./BottomTabBar.js"` has no `layout/` segment to match. Found via
  `electron-client`'s own build failing (`Could not resolve './BottomTabBar.js'`) after
  rebuilding this repo's `dist/` - not by this repo's own test suite, since Vite resolves
  `apps/**` source directly in tests and never needed the compiled `dist/` mirror. Five call
  sites needed fixing this way: `AppShell.tsx` (`BottomTabBar`), `ContactDetailPane.tsx`
  (`ContactAvatar`), and `EmojiPicker.tsx`/`GifPicker.tsx`/`ScheduleSendPicker.tsx`
  (`PopoverPortal`, all three in `mail/compose/` alongside the file that moved).
- **Added a Tailwind `@source` for `@rapidmx/react-shared`** to this repo's own
  `apps/shared/styles/app.css` (the stylesheet every consumer imports as its Tailwind entry) -
  needed now that real, heavily-used components (not just `Modal`/`Drawer`, which were already
  there and arguably already under-scanned) live in that package. See react-shared's own
  NOTES.md for the verification (grepped the actual built CSS for real classnames).
- Not committed - JP said "hold off on commit" for this whole cross-repo pass.

### 2026-09-11 — Closed the two real coverage gaps; documented the two that remain

Went from 99.53%/99.56%/99.35%/99.59% (stmts/branches/funcs/lines) to
100%/99.9%/100%/100%, closing every gap except two individually-investigated, deliberately
accepted branch gaps (see `vitest.config.ts`'s own `thresholds` comment for both).

- **`admin/branding/index.tsx` (was 84.69%/79.48% stmts/funcs) had zero coverage of its entire
  Icon section** - upload/remove/oversized-file/external-URL, and the icon-falls-back-to-logo
  preview - despite the Logo and Stylesheet sections (identical shape) being fully covered.
  Mirrored the existing Logo/Stylesheet test cases for Icon in
  `test/apps/admin/branding/index.test.tsx`.
- **`admin/_layout.tsx` (was 81.81% branches) was missing the same two cases `apps/www/_layout.tsx`'s
  own test file already covered for the identical branch shape**: a configured `stylesheetUrl`
  (never asserted at all) and `title` falling back to `companyName` when unset (the icon-falls-
  back-to-logo test doubles as this, since it sets `title: ""` alongside `companyName`). Mirrored
  `test/apps/_layout.test.tsx`'s exact 3-test structure into `test/apps/admin/_layout.test.tsx`.
- Fixed `CONTRIBUTING.md`'s bug-report/feature-request examples and "RapidREST repository" wording
  (leftover from the generic template, `@rapidrest`/`ModelRoute`/MongoDB-flavored - none of that
  applies to this package) - replaced with a `SettingsReadReceiptsPage`/component-relevant example.
- Not committed - JP said "hold off on commit" for this whole cross-repo pass (also touched
  `postfix-bridge`, `react-shared`, `ses-bridge`, and earlier `electron-client`).

### 2026-09-11 (continued) — Real bug: `server`'s Tailwind build was silently incomplete for this package's own `apps/**`

Found via JP's own `yarn dev` screenshots (giant unstyled logo, collapsed unstyled admin sidebar) -
`server`'s build was producing a genuinely *incomplete* Tailwind stylesheet, missing a large set of
real utility classes (`justify-between`, `px-6`, `max-w-md`, `shrink-0`, `md:pb-0`, and more -
confirmed by diffing every classname `AdminShell.tsx`/`MailboxProvisioning.tsx` actually use against
`server`'s own built CSS file, not guessed).

- **Root cause**: `server`'s `vite.config.ts` (`@rapidrest/react`'s `createViteConfig`) builds one
  independent Rollup entry per page - dozens of them, one per `www`/`admin` route (see
  `rapidRestHydrationPlugin` in that package's own `vite.js`). Tailwind's "automatic" content
  detection (no explicit `@source`) scans based on Vite's module graph, and with this many
  independent entries, it only ever picked up classnames from whichever *one* chunk `app.css`'s own
  processing ended up attached to - every class used *only* by files reachable through a different
  entry's own graph was silently dropped from the single shared stylesheet, even though those files
  were very much present in the actual JS bundle.
- **This package already had the identical `@source` fix for `@rapidmx/react-shared`'s own tree**
  (added earlier today) but never had one for its *own* `apps/**` tree - it happened to "work" via
  automatic detection for `electron-client` only because `electron-client`'s own `styles.css`
  already had its own explicit `@source "../../node_modules/@rapidmx/web-client/apps"` (from the
  original split), which `server` had no equivalent of.
- **Fix**: added a second `@source "../../";` to this package's own `apps/shared/styles/app.css`
  (resolves to this package's own `apps/` root from `apps/shared/styles/`) - makes the scan
  independent of Vite's per-entry chunking, for `server`'s build specifically (a no-op duplicate for
  `electron-client`, which already sources the same tree from its own side).
- Verified by diffing every classname actually used in `AdminShell.tsx` and `MailboxProvisioning.tsx`
  against `server`'s real built CSS, before and after - genuinely missing before (confirmed via the
  built file, not assumed), completely present after. This was pre-existing since the original
  2026-09-10 split, just never visible until now - the SSR "Invalid hook call" bug (see `server`'s
  own `.claude/NOTES.md`, same date) made every page 500 before anyone could see the layout render

### 2026-09-11 (continued) — Add `KeyEnrollmentGate`, and a real architectural bug found along the way

Part of the same session that added `react-shared`'s `crypto/` foundation (see that repo's own
NOTES.md) - this piece wires first-sign-in E2E key provisioning into `MailShell`. Only the
**encryption** key is auto-provisioned; the signing key's RFC 8823 ACME public-CA enrolment has no
server-side endpoint yet (tracked in `restapi`, out of scope here), so generating a signing keypair
with nowhere real to enroll it would be premature.

- **Real bug, not a test artifact**: the first version of this wiring only wrapped `AppShell` in
  `KeyEnrollmentGate` *once `mailboxUid` had resolved* ("checking"/"error" states rendered `AppShell`
  bare, ungated, reasoning that there was nothing to gate yet). This is wrong - the moment
  `mailboxUid` resolves, that's a **different component type at the same tree position**
  (`AppShell` directly vs. `KeyEnrollmentGate > AppShell`), so React unmounts and remounts the
  *entire* `AppShell` subtree right at that transition, destroying whatever state/effects it had
  already started. Caught via a real, reproducible test failure (three impersonation-banner tests
  broke only when `impersonating: true` was set - confirmed the banner rendered *immediately* during
  MailShell's own "checking" phase, then vanished the instant `status` flipped to "ready", exactly
  when `AppShell` got torn down and rebuilt from scratch). **Fix**: `KeyEnrollmentGate` now always
  wraps `AppShell`, at a stable tree position for MailShell's entire lifecycle; the gate itself
  accepts an optional `mailboxUid` and simply passes `children` through untouched until a real one is
  supplied, only starting its own async check once it has something to check. This is a real lesson
  for any future "gate real content behind an async check" component in this codebase: gate *inside*
  a stable wrapper, never by conditionally wrapping at the call site.
- **Confirmed the same real bug empirically before concluding it was a bug**, not a test quirk - spent
  significant effort first suspecting (and ruling out, one at a time, via direct instrumentation)
  `mockLocation()`'s jsdom interaction, Vite dependency-optimizer caching, `vi.mock` realm/module
  duplication, and React Strict Mode double-invoking effects, before a `console.trace()` in the
  gate's own effect cleanup showed the real cause: `commitPassiveUnmountEffectsInsideOfDeletedTree`,
  i.e. a genuine fiber-tree deletion, not a mock timing artifact.
- **Separately, a real Vite/Vitest quirk does exist** and is unrelated to the bug above:
  `vi.stubGlobal("fetch", ...)` (this suite's usual way of mocking every other `@rapidmx/react-shared`
  API call) does not reliably reach `@rapidmx/react-shared/crypto/keyvaultApi.js` specifically -
  confirmed by direct reproduction (`globalThis.fetch` read as the real, unstubbed implementation
  *inside* `KeyEnrollmentGate`'s own effect, even though the exact same check one tick earlier, in
  the test body itself, showed the stub still active). Root cause not fully isolated (tried and ruled
  out: clearing `node_modules/.vite`, `optimizeDeps.include`, `server.deps.inline` - none changed the
  outcome) - plausibly specific to this being a brand-new, not-yet-published subpath consumed via a
  fresh `yarn patch` rather than a real registry release. **Workaround**: mock
  `@rapidmx/react-shared/crypto/keyvaultApi.js` at the module level (`vi.mock(...)`) instead of
  relying on the shared `mockFetch()` helper, in any test that renders `MailShell`/anything wrapping
  `KeyEnrollmentGate`. Revisit whether this is still needed once `react-shared` gets a real publish
  past this patch.
- **`@rapidmx/react-shared` is now consumed via `yarn patch`**, not a plain registry dependency,
  specifically to pick up its new `crypto/` module ahead of a real npm publish - `.yarn/patches/
  @rapidmx-react-shared-npm-0.2.0-*.patch` replaces the installed package's `dist/` wholesale with a
  freshly-built copy from the sibling `react-shared` checkout. Patching alone does **not** pull in a
  patched package's own *new* transitive dependencies (Yarn resolves the dependency graph from the
  original, unpatched registry manifest before applying the patch) - `@peculiar/x509`, `hash-wasm`,
  and `reflect-metadata` had to be added as this repo's own **direct** dependencies too, matching
  exactly what `react-shared`'s own `package.json` newly declares. Whenever `react-shared` picks up
  more new dependencies for code this repo actually imports, mirror them here the same way until a
  real publish makes the patch unnecessary.
  at all.

### 2026-09-11 (continued) — Compose sign/encrypt wiring, message-view decrypt/verify, and an unmount-guard lesson

Wires up `react-shared`'s new `crypto/smime.ts`/`smimeMessage.ts`/`composeSecurity.ts`/
`messageSecurity.ts`/`keySession.ts` (see that repo's own NOTES.md, same date) into this app's actual
compose and message-reading UI - the rest of Phase 3 of the E2E encryption plan.

- **`KeyEnrollmentGate` gained an actual unlock step.** It previously only handled first-time key
  *provisioning* - once a mailbox had enrolled keys it rendered `children` immediately with no way to
  ever unwrap them into a usable session. Now: `getUnlockedKeys(mailboxUid)` short-circuits straight
  to `children` if this mailbox was already unlocked earlier this session; otherwise, once a fetched
  vault shows `wrappedKeys.length > 0`, it prompts for the password and calls `unlockWithPassword()`
  before rendering `children`.
- **`ComposeWindow.tsx`** now fetches its own mailbox + the system encryption policy on mount, runs
  compose-time discovery (`lookupKeys()`) against every recipient right before sending (deliberately
  *not* live as addresses are typed - a real, disclosed scope boundary: a compose-time recipient
  badge reflecting discovery results as you type is Phase 4's "Discovery & contacts UI" work, not
  this pass), and decides sign/encrypt via `composeSecurity.ts`. The "Multiple Recipients"
  all-or-nothing rule from the spec is enforced via an inline `encryptionBlocked` prompt (never a
  silent split into an encrypted-for-some/plaintext-for-others send) with a "Send without encryption"
  action. `cryptoContextReady` gates the Send/Send-later buttons alongside the pre-existing
  `!draft` check - closes a real (if narrow) race where clicking Send before the mailbox/policy
  fetch resolves would silently skip encryption the spec says should apply automatically.
- **`MessageDetailPane.tsx`** now evaluates every message's security state (not just ones flagged
  `Message.encrypted` - a signed-only message needs its raw MIME read too, since a sanitized HTML
  body never carries the detached signature part) via a new server-local
  `GET /mail/messages/:id/raw` route (added in `server`, alongside `@rapidmx/restapi`'s own
  `MessageRoute` - that library's `GET /:id/content` deliberately never serves raw MIME, since a
  browser navigating straight to it would be an XSS risk for ordinary mail; this new route labels its
  response `message/rfc822`, never `text/html`, so a stray direct navigation can't render it). A
  decrypted/verified body is client-sanitized with `dompurify` (new dependency) before being handed
  to the reading-pane iframe via `srcDoc` instead of the ordinary `src="/content"` URL - the server's
  own `sanitize-html` pass never ran against it, since the server never saw the plaintext.
- **Real bug, caught only by the full suite, never in isolation**: the new
  `getMailbox()`/`getEncryptionPolicy()` effect in `ComposeWindow.tsx` had no `cancelled` guard, so a
  promise settling after unmount could still call `setMailbox`/`setEncryptionPolicy`/
  `setCryptoContextReady`. One test's leftover in-flight promise landing during a *later*, unrelated
  test was the actual symptom - the same class of bug `KeyEnrollmentGate` already had a guard for,
  and now `MessageDetailPane.tsx`'s own new security-evaluation effect has one too. Lesson
  reinforced: any effect performing async state updates needs this guard as a matter of course, not
  just when a specific failure is observed - isolated single-file test runs will not catch its
  absence.
- Also found and fixed: **a `vi.mock()` factory throws synchronously the instant a missing export is
  *called*** (not merely accessed) - a much louder, more useful failure than silently returning
  `undefined`, but means every mock of `crypto/keyvaultApi.js` has to keep pace with new calls
  `ComposeWindow.tsx` adds to it. `MailShell.test.tsx`'s own mock was missing
  `getEncryptionPolicy`/`lookupKeys` for exactly this reason - its "clicking Compose" test mounts a
  real `ComposeWindow`, which now calls both unconditionally on mount.

### 2026-09-11 (continued) — Phase 4: compose-time discovery indicator + Contact key/fingerprint display

The two pieces of Phase 4 ("Discovery & contacts UI") that restapi's current release actually
supports. One piece from the original plan - the Key Conflict Handling accept/reject *action* - turned
out to be **unimplementable against the current restapi release** (see below), not just deferred.

- **`ComposeWindow.tsx`** now runs `lookupKeys()` on `onBlur` of the To/Cc/Bcc fields (not on every
  keystroke, and not the same lookup `assembleForSend()` already ran at send time - this is a
  best-effort UI hint, so a stale cached result here is fine to leave stale rather than re-fetching),
  caching each address's `composeSecurity.ts#resolveRecipientEncryption()` result in a
  `recipientStatuses` map and rendering a small "supports encryption"/"no encryption key found" pill
  per known recipient below the fields. Skips the lookup entirely while `mailbox`/`encryptionPolicy`
  haven't resolved yet (same guard `assembleForSend()` already uses) rather than firing a lookup it
  can't yet classify.
- **`ContactDetailPane.tsx`** gained an "Encryption" section: each pinned key's fingerprint (grouped
  into 4-char blocks - `abcd 1234 ...` - specifically because the spec's own use case is "compare this
  over the phone," and one 64-character run defeats that), marked `(revoked)` where applicable, plus
  the contact's `encryptPreference` in plain language. When `Contact.keyConflict` is set, shows an
  informational warning with the newly observed fingerprint and the date - the previously pinned key
  stays displayed unchanged alongside it (spec: "retain the previously stored key," never silently
  replace).
- **Real, disclosed restapi-release gap, not a deferral**: the spec's Key Conflict Handling requires
  "explicit user action to replace the pinned key," implying an actual accept/reject action - but
  `@rapidmx/restapi`'s `BaseContactRoute.ts` hard-rejects (400) any client attempt to set `keys`/
  `encryptPreference`/`keysFirstSeen`/`lastMessageSeen`/`keyConflict` directly (`DISCOVERY_MANAGED_FIELDS`,
  its own doc comment: "trust-on-first-use pinning, anti-downgrade, and key-conflict detection all
  depend on these never being set by an ordinary client-facing edit"), and there is no dedicated
  resolve-conflict route anywhere in that library either. Unlike the RFC 8823 ACME signing-key gap
  (tracked, expected to land later), this specific mechanism doesn't exist in restapi at all yet - the
  banner above is informational-only, with no action button pretending to do something the server
  can't currently accept. Revisit once restapi adds a real resolution endpoint.

### 2026-09-11 (continued) — Phase 5 (partial): Settings > Encryption page

New `apps/www/settings/encryption/index.tsx` (added to `SETTINGS_SECTIONS`), covering the subset of
Phase 5 buildable against the current `@rapidmx/restapi` release and this session's own crypto/
foundation, without a large new subsystem of its own:

- **Status**: this mailbox's enrolled keys (fingerprint, sign/encrypt, revoked) straight from the
  already-loaded `Mailbox.keys` - no extra fetch.
- **Unlock methods**: lists `KeyVault.masterKeyWraps` (own `getKeyVault()` fetch) with a Remove action
  per method (`removeMasterKeyWrap()`) and the spec-required "not true revocation" caveat displayed
  inline, not just implied. An `escrow` wrap never gets a Remove button (restapi's own route rejects
  removing one through this endpoint anyway - see `BaseKeyVaultRoute.removeMasterKeyWrap()`'s own
  403).
- **Add a password**: reuses `masterKeyWraps.ts`'s `buildPasswordWrap()` against this session's already-
  unlocked MK (`getUnlockedKeys()`), then `addMasterKeyWrap()`.
- **Regenerate recovery codes**: removes every existing `recovery`-method wrap by its own `methodId`
  (`removeMasterKeyWrap()` requires one whenever more than one wrap shares a method - recovery always
  has several), then `buildRecoveryWraps()` + `addMasterKeyWrap()` per new one, then the same one-time-
  display-plus-confirm-checkbox UI `KeyEnrollmentGate`'s own first-enrollment flow already uses.
- **Destroy keys now**: purely local - `destroyUnlockedKeys(mailboxUid)` (`keySession.ts`), no server
  call. Shows a confirmation screen instead of a reload, since there's no clean way to re-run
  `KeyEnrollmentGate`'s own mount-time unlock check without one.
- **`SettingsShell` doesn't already gate its children behind `KeyEnrollmentGate`** the way `MailShell`
  does (a user can reach Settings without ever opening Mail this session) - this page wraps its own
  content in `KeyEnrollmentGate` a second time instead, which is safe by that component's own design
  (short-circuits to `children` immediately once a mailbox is unlocked anywhere else this session too).
- **Real, disclosed-not-silent test flake found while adding coverage**: a test asserting on
  vault-derived content (`vault.masterKeyWraps`, populated by this page's own separate `getKeyVault()`
  effect) via a bare `screen.getByText(...)` right after an `await screen.findByText(...)` for
  *mailbox-key*-derived content (`Mailbox.keys`, already available before this page even mounts) raced
  the still-pending vault fetch - passed in isolation, failed under the full suite's added scheduling
  pressure. Two different async sources feeding the same page means every assertion needs to `await
  findByText` the *specific* thing it actually depends on, not just the first thing the test happened
  to await.
- **Deliberately deferred, not built even partially** (all three would roughly double this page's own
  scope): a full WebAuthn passkey-registration ceremony as a second "add a method" action (`
  passkeyUnlock.ts`'s `registerPasskeyForUnlock()`/`deriveFromPasskey()` already exist and are already
  used nowhere yet); a "rotate keys" action (`keyvaultApi.ts`'s `rekey()` - full atomic vault
  replacement, the actual revocation mechanism for a captured wrap, per that function's own doc
  comment); and idle-timeout configuration (this needs a session-wide activity-tracking mechanism
  mounted somewhere like `AppShell.tsx`, not just a page-level setting with nothing enforcing it - a
  control with no effect would be worse than no control). Revisit as a follow-up pass.