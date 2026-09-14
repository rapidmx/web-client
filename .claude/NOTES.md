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
- **Deliberately deferred, not built even partially**: a full WebAuthn passkey-registration ceremony as
  a second "add a method" action (`passkeyUnlock.ts`'s `registerPasskeyForUnlock()`/`deriveFromPasskey()`
  already exist and are still used nowhere yet). "Rotate keys" (`rekey()`) and idle-timeout
  configuration both landed the same day - see the two entries directly below.

### 2026-09-11 (continued) — Real key rotation ("Rotate keys")

Closes the one deferred item from the entry above that JP asked for by name. New `react-shared`
module `crypto/keyRotation.ts`'s `rewrapPrivateKeysUnderNewMasterKey()` (see that repo's own NOTES.md,
same date) does the actual re-wrapping; this page's own "Rotate keys" form is the orchestration:

1. `rewrapPrivateKeysUnderNewMasterKey(mailboxUid, unlocked)` — fresh MK, existing private key(s)
   re-wrapped under it (same keypair/certificate, unchanged - restapi's own `rekey()` route rejects
   any `keys` entry that isn't byte-identical to what's already enrolled aside from `revokedAt`).
2. `buildPasswordWrap()`/`buildRecoveryWraps()` (already-existing helpers, same as "Add a
   password"/"Regenerate recovery codes") wrap the *new* MK under a freshly entered password and a
   fresh set of recovery codes.
3. `rekey(mailboxUid, { wrappedKeys, masterKeyWraps, keys: mailbox.keys })` — the one atomic call that
   replaces the vault server-side. `keys` is passed through completely unchanged (restapi's own
   validation requires it).
4. `unlockWithPassword(mailboxUid, mailbox.keys, newPassword)` — re-primes this session's own
   `keySession.ts` cache against the new MK via the password just set. Necessary: the underlying
   private-key `CryptoKey` objects are still valid (same bytes), but the session's cached `masterKey`
   is now stale and would silently build wrong wraps for any *later* action (a second "Add a
   password," another rotation) if left as-is.

Reuses the exact same "Save your new recovery codes" one-time-display screen "Regenerate recovery
codes" already built, with a `recoveryCodesReason` flag swapping in different explanatory copy (a
rotation also invalidates every *other* unlock method, not just recovery codes — the screen needs to
say so plainly, not just "codes changed").

### 2026-09-11 (continued) — Idle-timeout key destruction

JP's own direction on this one: "the clock needs to reset on any legitimate action in the client, not
just Mail and Settings" - ruling out the narrower option (mounting the timer inside `KeyEnrollmentGate`
itself, which only exists while Mail/Settings are open) in favor of `AppShell.tsx`, the one component
every app (Mail/Calendar/Contacts/Tasks/Settings) actually renders through.

- `react-shared`'s new `crypto/useIdleKeyTimeout()` (see that repo's own NOTES.md, same date) listens
  for `mousedown`/`keydown`/`scroll`/`touchstart` at the **`document`** level, not scoped to any one
  app's own content area - activity in Contacts or Calendar resets the clock exactly the same as
  activity in Mail, even though only Mail/Settings ever actually read the keys it protects. Mounted
  once, unconditionally, in `AppShell.tsx` (alongside the existing `useRedirectIfUnauthenticated()` -
  same "call it every render regardless of `userUid`, let the hook itself no-op" pattern).
  `destroyUnlockedKeys()` (no argument - wipes every mailbox's session, not just one) is a no-op
  against an empty store, so mounting this before anything is ever unlocked has no observable effect.
- Settings > Encryption gained a "Session timeout" `<select>` (5/15/30/60 minutes, or Never) reading/
  writing `idleTimeout.ts`'s `localStorage`-backed preference directly - no API call, no submit
  button, applied on the very next `change` event. Takes effect the next time the user opens or
  reloads the app (`AppShell.tsx` reads the configured duration once, at its own mount - this
  framework has no client-side router, so every navigation is already a fresh mount, matching how
  every other page here already works).
- Simplified `idleTimeoutLabel()`'s hour-formatting to a plain `minutes === 60 ? "1 hour" : ...` special
  case rather than a general `minutes / 60` pluralization branch — the only >= 60 option
  `IDLE_TIMEOUT_OPTIONS_MINUTES` actually offers today is exactly 60, so the general form's plural
  branch was untestable dead code, not a real gap.

### 2026-09-11 (continued) — Mailing-list signature suppression + HP-Outer tamper-detection banner

Two more items off the "remaining E2E pieces implementable at the current restapi version" list (see
`react-shared`'s and `server`'s own NOTES.md, same date, for the other pieces: DNSSEC DnsResolver, and
confirming Rotation Notification's receive side needed no client work at all).

- `ComposeContext.tsx`'s `OpenComposeInput`/`ComposeSession` gained `suppressSigning?: boolean`.
  `MessageDetailPane.tsx`'s `handleReply()`/`handleReplyAll()` (not `handleForward()` - forwarding
  isn't a reply-to-a-list situation) now pass `suppressSigning: isLikelyMailingList({ listUnsubscribe:
  message!.listUnsubscribeHeader })` - `react-shared`'s new `Message.listUnsubscribeHeader` field
  (`ScanPipeline` already captured this server-side, just never exposed it) feeding a compose-security
  function that already existed but had no real caller yet. `ComposeWindow.tsx` seeds `signEnabled`
  from `!suppressSigning` - a default only, the user can still turn signing back on.
  `specs/end-to-end_encryption.md`'s own "Mailing lists" note under Digital Signatures: a list that
  appends a footer after signing invalidates the signature.
- `MessageDetailPane.tsx` renders a second, separate `Alert` banner when
  `security?.headerTamperDetected` is true (see `react-shared`'s `messageSecurity.ts`/`smimeMessage.ts`
  changes, same date, for where this field comes from) - deliberately not folded into the existing
  5-state `SecurityIndicator` badge, since header tampering can co-occur with any of
  encrypted/encrypted_verified/signature_failed and isn't itself one of the spec's five defined states.
  Satisfies RFC 9788's "MUST visually distinguish a message whose outer and protected headers disagree"
  as its own independent signal.
- Considered and explicitly dropped from scope: a client-local `hcp_shy` (stricter Header
  Confidentiality Policy) toggle. Re-read `specs/end-to-end_encryption.md`'s actual "Header Protection"
  section before building it - the RapidMX spec itself only says signed messages "MUST use header
  protection as defined in RFC 9788" with no mention of `hcp_shy`/`hcp_baseline` by name; that
  terminology came from RFC 9788 itself (verified earlier this session via WebFetch), not from a
  RapidMX requirement. `applyBaselineOuterHeaders()` (react-shared) already implements RFC 9788's
  actual default policy. Building a stricter opt-in tier would be speculative scope creation, not spec
  compliance - not implemented.
- Full react-shared rebuild + `yarn patch`/`patch-commit`/`yarn install` cycle run to pick up both this
  and the HP-Outer/`listUnsubscribeHeader` react-shared changes in one pass (deliberately batched
  rather than one patch cycle per change).

### 2026-09-11 (continued) — search.md Tier 1: operator-aware search UI, snippets

Ends the E2E remaining-work pass and starts on `specs/search.md`. Confirmed with JP (plan mode,
`AskUserQuestion`) that only Tier 1 - the server-side search restapi already fully implements and
mounts - is in scope for this pass; Tiers 2/3 (local encrypted SQLite index, progressive skeleton
results) are a separate future effort. See `react-shared`'s own NOTES.md, same date, for the new
`search/queryGrammar.ts`/`searchScoring.ts` modules and the rewritten `searchApi.ts` this builds on.

- `apps/www/index.tsx`'s `InboxContent` search box now runs the raw input through
  `parseSearchQuery()` before calling `searchApi.search()`, forwarding every structured field
  (`from`/`to`/`cc`/`subject`/`hasAttachment`/`before`/`after`/`folderUid`/`flags`/`labels`) alongside
  the free-text remainder as `q` - previously the entire raw string went through as `q` with no
  operator support at all. `type:` narrows the requested `entityTypes`; absent that, still defaults to
  `["message"]` as before - a non-message hit has no `Message` to resolve via the existing
  `getMessage()` call and is simply dropped by the same already-existing eventually-consistent-index
  fallback (a real multi-entity-type results view is a separate, larger UI project, not this pass).
- Each search hit's `SearchResult.snippet` (previously fetched and silently discarded) now renders in
  place of the plain `bodyPreview` in the message row, via a new `snippets: Record<uid, string>` state
  populated alongside `messages` in both the initial-load and load-more paths.
- **Test-authoring bug caught while writing the new snippet tests**: a fixture for the search-hit
  message omitted `folderUid`, defaulting to the same folder as the *initial*, pre-search listing - the
  message was therefore already on screen from the very first render, so `findByText("Matched
  message")` succeeded immediately without ever waiting for the mocked search response, and the
  assertion silently checked the pre-search DOM instead. Diagnosed by adding temporary `console.log`
  instrumentation inside the implementation itself and confirming it never fired during the failing
  test - proof the search code path hadn't run at all, not a snippet-rendering bug. Fixed by giving the
  hit fixture a distinct `folderUid` (`"f2"`), matching every other passing test's own established
  convention in this same file. Lesson: a search-hit fixture in this test file MUST use a folder
  distinct from the initial listing's folder, or a stale pre-search render can silently satisfy an
  assertion meant to prove the search round-trip happened.

### 2026-09-11 (continued) — search.md Tier 3: server-assisted narrowing over encrypted mail

Investigation into Tier 2 (the local encrypted index) surfaced two real infrastructure blockers
specific to this repo and `electron-client` (see `react-shared`'s own NOTES.md, same date, for the
full writeup) - confirmed with JP to build **Tier 3 first** instead, which needs neither. Tier 2
remains a separate future effort.

- `apps/www/index.tsx`'s `searchMessages()` now runs `react-shared`'s new
  `searchTier3.ts#searchEncryptedCandidates()` alongside the existing Tier 1 `searchMailbox()` call
  (`Promise.all`) whenever there is no `cursor` (first page only - Tier 3 has no pagination wiring
  yet, a deliberate scope trim carried over from that module's own doc comment), passing
  `getUnlockedKeys(mailboxUid)` so it silently contributes nothing when this mailbox has no unlocked
  keys this session.
- New `mergeSearchResults()`: normalizes both tiers' scores independently via `searchScoring.ts`'s
  `normalizeServerScores()` (a Postgres/OpenSearch score and Tier 3's own term-count score occupy
  unrelated ranges - interleaving raw values would rank one tier arbitrarily above the other), then
  merges by `entityUid` - a Tier 3 hit (genuinely content-verified) replaces a Tier 1 `metadataOnly`
  guess for the same message rather than rendering both. Sorted by normalized score, highest first.
- Deliberately **not** the spec's full "Progressive Results" UX (skeleton entries in place, capped
  rendering, animated reordering) - real, separate UI work; this pass waits for both tiers to resolve
  and renders one final merged list, same as how the search box already waits on one round-trip today.
- New tests mock `@rapidmx/react-shared/search/searchTier3.js`/`crypto/keySession.js` at the module
  boundary (same convention `MessageDetailPane.test.tsx` already established for
  `evaluateMessageSecurity`/`getUnlockedKeys`) - real decryption is already proven end to end with real
  WebCrypto in `react-shared`'s own `test/search/searchTier3.test.ts`, so these only verify
  `InboxContent`'s own merge/render responsibility. Needed a `beforeEach` defaulting the mocked
  `searchEncryptedCandidates()` to `[]` so every pre-existing search test (which predates Tier 3 and
  doesn't configure it) still gets a real array back rather than `undefined` — `Promise.all` happily
  wraps a non-promise `undefined` into a resolved value, so this failure mode is silent, not a thrown
  error, until something downstream (`normalizeServerScores([...undefined])`) touches it.
- Coverage note: closing the `apps/**` 100%-lines gate needed one more test than initially written -
  `mergeSearchResults()`'s `.sort()` comparator was never actually invoked by any test using fewer
  than two distinct merged results (`Array.prototype.sort` never calls its comparator for a 0- or
  1-element array), so a 2-message, differently-scored merge test was needed to exercise the real
  sort-order behavior, not just its absence.
- Full react-shared rebuild + `yarn patch`/`patch-commit`/`yarn install` cycle run to pick up
  `messageSecurity.ts`'s new `subject` field and the new `searchTier3.ts` module.

### 2026-09-12 — Phase 2 of consuming restapi's 11 post-0.6.0 commits: Archive folder

JP confirmed that batch (RFC 8823 ACME, Escrow Scoping, Labels, Archive, S3BlobStore) is done and asked
for everything it unlocks to be implemented; sequenced smallest-first. See `server`'s/`react-shared`'s
own NOTES.md for Phase 0 (the restapi patch bridge) and Phase 1 (S3BlobStore, deployment-only).

- `MailShell.tsx`'s `FOLDER_LABELS`/`FOLDER_ORDER` gained `archive: "Archive"`, positioned after Junk
  and before Deleted Items (Outlook/Gmail convention) - **restapi's `FolderType.ARCHIVE` was already
  invisible in this sidebar** even before this session's own changes, since both constants are a fixed
  allowlist and neither listed it. `MAIL_FOLDER_TYPES` (derived from `FOLDER_ORDER`) picks it up
  automatically, no separate change needed there.
- `MessageDetailPane.tsx` gained an "Archive" button alongside Reply/Reply All/Forward, calling the new
  `archiveMessage()` (`react-shared`, same date). Hidden for Outbox (`isOutbox`, existing prop) and for
  Drafts - **Drafts detection needed no new prop**: `draftsFolderUid` was already passed by every
  caller (for the Outbox→Drafts cancel-scheduled-send flow), so `message.folderUid ===
  draftsFolderUid` reuses it directly. New `onArchived` callback prop, same shape as `onRecalled`.
- Caller wiring follows each view's own pre-existing convention exactly: `apps/www/index.tsx` (a
  per-folder list) **removes** the archived message from state (same reasoning as its existing
  `onScheduledSendCanceled` - the message moved out of the currently-viewed folder);
  `ConversationThreadPane.tsx` (thread membership owned by the parent, not folder-scoped) **patches it
  in place**, matching its own existing `onScheduledSendCanceled`; `messages/[uid].tsx` (a single-message
  page) just `setMessage`s the updated copy directly.
- No `server` route changes needed at all — `MessageRoute`/`MessageRouteMongo`/`SQL` is already a
  one-line subclass of restapi's `BaseMessageRoute`, so the new `archive()` method came along for free
  the moment `server`'s restapi patch (Phase 0) landed.

### 2026-09-12 (continued) — Phase 3 of consuming restapi's 11 post-0.6.0 commits: Labels

- New `apps/www/settings/labels/index.tsx` (added to `SETTINGS_SECTIONS`) - a single self-contained
  page (no separate `/new`/`[uid]` pages like Signatures/Filters/Booking-Types have) since a `Label` is
  just `name`+`color`: one shared create/edit `Modal` (`react-shared`'s `Modal`/`FormField`/`Button`)
  and a separate delete-confirmation `Modal`, matching this codebase's established "destructive actions
  get a real confirmation dialog, never `window.confirm`" convention (confirmed nothing in this repo
  uses `window.confirm` at all before choosing this).
- `MessageDetailPane.tsx` gained a "Labels" button (hidden when the caller passes no `labels`, i.e.
  this mailbox has none defined yet) opening a `Modal` with one checkbox per mailbox label, auto-saving
  on every toggle via the new `setMessageLabels()` (no separate "Save" step - matches how classify/
  receipt actions in this same component already auto-save). Applied labels also render as small
  colored chips under the To line. New `labels`/`onLabelsChanged` props, `onLabelsChanged` **always**
  patches in place (unlike `onArchived`) since changing labels never moves a message between folders.
- All three callers (`apps/www/index.tsx`, `ConversationThreadPane.tsx`, `messages/[uid].tsx`) fetch
  the mailbox's labels once (`listLabels`, mailbox-wide not folder-scoped) and pass them down; a fetch
  failure just leaves `labels` empty (hiding the control) rather than blocking the rest of the page -
  the same "small enhancement, not critical path" posture already established for Tier 3 search.
- **Two real dead-guard removals, not just new code**: `apps/www/index.tsx`'s and `messages/[uid].tsx`'s
  new labels-fetch effects initially guarded on `if (!mailboxUid) return;`, but coverage proved that
  branch **unreachable** in both - `MailShell` never renders either component's children until
  `mailboxUid` has already resolved (the exact same invariant `searchMessages(mailboxUid!, ...)`
  already relies on a few lines away). Removed the guard and used `mailboxUid!` directly instead of
  writing a test for a branch that can't occur, matching this codebase's own established "dead guard
  the UI structurally can't trigger" removal precedent (`SettingsShell.tsx`'s own comment on the same
  pattern).
- Coverage note: closing the 100%-lines/functions gate needed tests that actually trigger each `Modal`'s
  own `onClose` (its "×" button) - clicking a page's own "Cancel" button alone never exercises the
  `onClose` prop itself, since Cancel has its own separate `onClick` calling the same state setter.
  Three modals (Labels-assignment, Labels-settings create/edit, Labels-settings delete) all had this
  exact same gap shape independently.
- Deliberately **not built this pass**: clickable label filters in the folder sidebar (`MailShell.tsx`).
  Typing `label:<uid>` directly into the existing search box already works today (this session's
  earlier `queryGrammar.ts` work) - a one-click shortcut into that same query is a real but separable
  UX improvement, not required for the core CRUD+assignment feature to be usable.
- Full react-shared rebuild + `yarn patch`/`patch-commit`/`yarn install` cycle run to pick up
  `labelsApi.ts`, `mailApi.ts`'s `Message.labelUids`/`setMessageLabels()`.

- **2026-09-12 (continued) — Phase 4 of consuming restapi's 11 post-0.6.0 commits: RFC 8823 ACME
  signing-certificate enrollment.** Settings > Encryption (`apps/www/settings/encryption/index.tsx`)
  gained a "Digital signatures" section: when the mailbox has no active signing key yet, an "Enable
  digital signatures" button generates a P-256 keypair + CSR (`generateKeyPairWithCsr(address, "sign")`
  - already generic across `useType`, no `react-shared` change needed there), wraps the private key
  under the already-unlocked MK (`sealWithKey`/`buildAad` with `SIGNING_PRIVATE_KEY_AAD_PURPOSE`, the
  exact same shape `keySession.ts` already unwraps it with), and calls `startSignEnrollment()`. This is
  genuinely asynchronous - a live email round-trip with a public CA, "likely minutes" - so the button
  isn't a blocking spinner: it flips to a "Requested" message and a `setInterval`-based poll (every 15s,
  `checkSignEnrollmentStatus()`) takes over, tearing down on unmount via a `cancelled` flag (two separate
  guarded await points - the status check itself and the follow-up mailbox re-fetch - both needed their
  own test to hit the branch where the component unmounts mid-flight).
  - `mailbox.keys` comes from `SettingsShell`'s one-time `listMailboxes()` fetch, taken at page load -
    once ACME issues a cert, the server auto-installs it (restapi's own `AcmeEnrollmentDriverJob`, no
    further client call), but that original fetch never sees it. This page re-fetches via the existing
    `getMailbox(uid)` once polling reports `"issued"` and merges the result into local state
    (`refreshedKeys`) rather than plumbing a refresh callback back up through `SettingsShellContext` -
    scoped to this one page, not a shared concern yet.
  - `KeyEnrollmentGate.tsx`'s `provisionEncryptionKey()` had a stale comment claiming automated signing
    enrollment "doesn't exist yet" - updated to explain why it's still a deliberate Settings opt-in
    rather than something to fold into first-sign-in mailbox setup (the async CA round-trip shouldn't
    block that gate).
  - A manual-backend deployment's `SigningCertificateEnrollment` throws when this is called (see
    `server`'s own NOTES.md) - this page has no capability-detection endpoint to hide the button on such
    a deployment, so clicking it there just surfaces whatever error message the server returns, same as
    every other ApiRequestError path on this page.
  - Full react-shared rebuild + `yarn patch`/`patch-commit`/`yarn install` cycle run to pick up
    `keyvaultApi.ts`'s `startSignEnrollment`/`checkSignEnrollmentStatus`.

- **2026-09-12 (continued) — Phase 5b of consuming restapi's 11 post-0.6.0 commits: Escrow Scoping,
  mailbox-owner wrapping.** Settings > Encryption gained an "Escrow" section, shown only when
  `mailbox.escrowScopeId` is set (an admin-only assignment - nothing to show otherwise):
  - No existing `escrow`-method wrap yet → an explanatory disclosure ("nothing has been protected yet...
    an authorized holder cannot recover this mailbox's encrypted mail until you complete this step") plus
    an "Add escrow protection" button. Clicking it calls the new `getEscrowInfo(mailboxUid)` (`server`'s
    own gap-filling proxy - see that repo's and `react-shared`'s NOTES.md for why it exists), then
    `buildEscrowWrap(unlocked.masterKey, escrowScopeId, fromBase64(publicKey.publicKey))`, then submits
    the result via the existing `addMasterKeyWrap()` and reloads the vault.
  - An existing escrow wrap → a plain disclosure that this mailbox is under legal/compliance escrow, per
    the spec's own transparency requirement ("the client MUST display escrow status to the user in
    account settings") - no action needed, no "Remove" (mirrors the "Unlock methods" list below, which
    already hides Remove for `method: "escrow"`, since removing it client-side wouldn't reflect any real
    change in what an admin/holder can still do).
  - Deliberately an explicit, disclosed opt-in action, not automatic on page load - wrapping MK is a
    real cryptographic act (however routine), and the "add" button plus its own disclosure text is where
    that consequence is actually shown to the user, not buried in a background effect.
  - `mail/mailApi.ts`'s `Mailbox` interface gained `escrowScopeId?: string`, needed for this section's own
    render guard.
  - Full react-shared rebuild + `yarn patch`/`patch-commit`/`yarn install` cycle run to pick up
    `keyvaultApi.ts`'s `getEscrowInfo()`, `masterKeyWraps.ts`'s `buildEscrowWrap()`, and
    `mailApi.ts`'s `Mailbox.escrowScopeId`.
  - Admin/holder UI (EscrowScope/Matter/EscrowAccessRequest CRUD + audit log viewer) is Phase 5c, not yet
    built - tracked as the next step in this batch.

- **2026-09-12 (continued) — Phase 5c of consuming restapi's 11 post-0.6.0 commits: Escrow Scoping,
  admin/holder UI.** Two new UI areas, split by role per the spec's own "Separation of duties" (holding
  escrow is distinct from server administration - a trusted admin with no holder grant on a scope gets the
  same 403 as anyone else from every holder-gated restapi route).
  - **Admin: `EscrowScope` CRUD**, under the existing `apps/admin` (trusted-role-gated the same way as
    every other admin page): `apps/admin/escrow-scopes/{index,new/index,[uid]}.tsx`, mirroring
    `transport-rules`'s own list/create/edit shape. A new shared sub-form,
    `apps/shared/components/admin/escrowScopes/EscrowScopeKeyAndHoldersFields.tsx`, holds the public-key
    fields (an admin pastes in an already-issued certificate's fields - nothing here generates a keypair),
    the `holderUserUids` list, and the `requiredHolders` dual-control threshold. `AdminShell.tsx` gained a
    nav entry (`HiOutlineKey`).
  - A new reusable `apps/shared/components/forms/StringListField.tsx` (add/remove controlled string-list
    field) backs `holderUserUids` here and `custodianMailboxUids` on the Matter form below -
    `MemberListCard`'s existing list-editing pattern wasn't reusable as-is (it self-persists via its own
    API call per change; this needed a plain controlled field the surrounding form owns instead).
  - **Holder-facing: a brand-new top-level `apps/escrow` app**, parallel to `apps/admin`, not nested under
    it. `apps/shared/components/escrow/layout/EscrowShell.tsx` is its shell - see that file's own doc
    comment for why its access gate is structurally weaker than `AdminShell`'s: there is no clean canary
    endpoint that 403s a non-holder (`GET /escrow/matters` returns `200 []` for any authenticated caller
    who holds nothing, the same as a holder of zero matters), so the shell only confirms "signed in and
    the API is reachable," and every actual holder-gated action (create a Matter, approve/deny a request,
    read material) enforces server-side and surfaces its own 403 on the specific page that attempted it -
    a deliberate, documented trim, not an oversight.
  - `apps/escrow/index.tsx` (Matters list), `matters/new/index.tsx` (create - takes `escrowScopeId` as a
    plain text field, not a picker: `EscrowScope` is trusted-admin-only end to end, so there is no
    holder-readable "list scopes I hold" endpoint anywhere to populate one from), `matters/[uid].tsx`
    (detail: info, its access requests, a "New access request" modal, approve/deny on pending requests,
    and "Get material" once approved - rendered as raw JSON in a `<pre>` block, not a viewer, since this
    app deliberately never attempts to decrypt anything, matching the posture established everywhere else
    in this session), `audit-log/index.tsx` (read-only list of the caller's own visible entries, plus a
    "Verify chain integrity" action shown only to a trusted caller, calling `verifyAuditChain()` and
    rendering its `{valid, brokenAtSequence?}` result plainly).
  - **Known v1 boundary, not fixed here**: `BaseEscrowAccessRequestRoute.find()` always applies its own
    held-scopes-derived filter, ignoring any client-supplied `matterId` - the Matter detail page fetches
    one `limit=200` page and filters client-side, so a holder with more than 200 total in-flight requests
    across every matter they hold won't see all of them on a single matter's page. Flagged, not built
    around, given the size of everything else in this phase.
  - A real bug surfaced (and fixed) while chasing a raw v8 branch-coverage gap, not just a coverage
    exercise: a Matter-detail test that mocked every URL as a 404 passed only because `EscrowShell`'s own
    reachability-probe error UI (which never renders `{children}`) happened to also read "not found," so
    the page's *own* `err instanceof ApiRequestError` branch had a real zero-call count despite the
    assertion passing. Fixed by giving that test a shell probe that succeeds independently of the page's
    own (deliberately failing) fetch, the same split already used by the sibling "non-API error" test.
  - Full react-shared rebuild + `yarn patch`/`patch-commit`/`yarn install` cycle run to pick up the four
    new `src/admin/escrow*Api.ts`/`mattersApi.ts` wrappers.
  - `server` needed a new mount for `apps/escrow` itself (`EscrowConsoleRoute`, mongo + sql) or it would
    have been unreachable dead code - see that repo's own NOTES.md, same date.
  - This closes out all five phases of consuming restapi's 11 post-`v0.6.0` commits (S3BlobStore, Archive
    folder, Label entity, RFC 8823 ACME signing enrollment, Escrow Scoping).

- **2026-09-12 (continued) — Adversarial review pass over the restapi-consumption batch: a real,
  highest-severity finding, fixed.** `handleRotateKeys()` in Settings > Encryption (`apps/www/settings/
  encryption/index.tsx`) built fresh password/recovery wraps under a newly-generated MK but never touched
  escrow, even though `getEscrowInfo()`/`buildEscrowWrap()` (the exact functions the "Add escrow
  protection" button above already calls) were sitting right there in the same file. Traced what restapi
  actually does with the old escrow wrap on a `rekey()`: `BaseKeyVaultRoute.persistRekey()` preserves it
  **verbatim** (its own doc comment explicitly documents this as an accepted "correctness gap ... for the
  escrow holder to resolve out of band, not a security one" - `rekey()`'s own `validateMasterKeyWrap()`
  always passes `allowEscrow: false`, so a client literally cannot submit a fresh escrow wrap through this
  endpoint at all, by restapi's own design). The old wrap still decrypts to the master key that rotation
  just discarded - it silently stops working, while this page's `hasEscrowWrap` check (mere presence of a
  `method: "escrow"` entry) kept showing "This mailbox is under legal/compliance escrow" as if nothing had
  changed. A mailbox owner rotating keys for an unrelated reason (lost device, password hygiene) would
  silently and permanently break a compliance/legal-hold guarantee with no error anywhere - discovered
  only later, when a holder tries to pull material during an actual investigation and it doesn't decrypt.
  - Fix: since `rekey()` can never accept a fresh escrow wrap, `handleRotateKeys()` now performs a
    *separate* `addMasterKeyWrap()` call right after a successful `rekey()` - re-fetching the scope's
    public key and building a fresh wrap under the *new* MK, exactly the same path "Add escrow protection"
    already uses, whenever `hasEscrowWrap` was true going in. This restores real, decryptable escrow
    coverage for the current MK; it does **not** remove the old, now-stale wrap restapi preserved (removal
    is blocked for the `escrow` method through this same endpoint, by the identical design choice, and
    isn't this fix's job to work around) - a holder's own offline tooling ends up trying two wraps instead
    of one and simply discarding whichever fails to decrypt, the same "try every slot, keep the one that
    works" pattern `decryptEnvelopedData()` itself already uses for multi-recipient CMS.
  - A failure in this re-wrap step is deliberately **not** reported as a rotation failure - the rotation
    itself (password/recovery, the thing the user actually asked for) has already succeeded by that point
    and must not be second-guessed for an unrelated, independently-retriable escrow hiccup. Surfaced
    instead via the existing `escrowError` state, which the Escrow section's own `<Alert>` now renders
    unconditionally rather than only inside its "not yet protected" branch - `hasEscrowWrap` stays `true`
    after a failed re-wrap (the old, stale wrap is still technically present), so gating the error's
    visibility on that same flag would have hidden it behind the very "Enabled" claim it needs to correct.
  - Added three tests: the happy path (escrow re-wrap runs and succeeds during rotation), the failure path
    (re-wrap fails but rotation still completes, and the error becomes visible once the recovery-codes
    screen is dismissed), and the non-`ApiRequestError` fallback-message branch.
  - This is a client-side mitigation, not a complete fix - the fundamental gap (a rekey can't carry a
    fresh escrow wrap through restapi's own `rekey()` endpoint, so the client's `hasEscrowWrap` flag can
    never *prove* freshness, only presence) is restapi's own, already-disclosed, out-of-scope design
    limit. This just makes the common case (this page performing the rotation) actually re-establish real
    coverage automatically, instead of silently leaving a dead wrap as the only one on file.

- **2026-09-12 (continued) — Phase 2 of consuming restapi's next batch (compliance roadmap Groups A-F):
  Legal Hold enforcement (Group A).** restapi now 409s a permanent message delete or a mailbox delete
  when the target mailbox is a custodian on an open `Matter` - entirely transparent server-side (no new
  fields/routes on this repo's side; `server`'s `MailboxRoute`/`MessageRoute` already inherit restapi's
  own concrete `matterClass` wiring with zero changes needed there - see `server`'s own NOTES.md). The
  one real gap: nothing anywhere in this app could actually trigger a mailbox delete, so the enforcement,
  while real, had no reachable UI path to exercise it. Added a "Delete mailbox" button + confirmation
  `Modal` to `apps/admin/mailboxes/[uid].tsx`, calling the already-existing (but never-wired)
  `deleteMailbox(uid, version)` from `react-shared`'s `mailApi.ts` - surfaces the 409's own message
  (naming the blocking Matter uid verbatim) exactly like every other destructive-action error in this
  codebase, no special-casing. A dedicated "empty trash"/purge-a-single-message UI is deliberately not
  built here - Phase 6 (GDPR erasure, later in this batch) already gives a real end-to-end path that
  exercises this exact block when erasing a held mailbox, so this phase only needed to make the plainer
  mailbox-delete path reachable.

- **2026-09-12 (continued) — Phase 3 of consuming restapi's next batch: Retention Policy (Group C).**
  New `apps/admin/retention-policy/index.tsx` - two optional number inputs (message/audit-log retention
  in days), surfacing the endpoint's own 400 validation messages verbatim rather than duplicating them
  client-side (positive-integer check, the 2190-day audit-log floor via `MIN_AUDIT_LOG_RETENTION_DAYS`).
  Load/save shape mirrors `apps/admin/branding/index.tsx`'s own simpler singleton-settings pattern. A
  blank field is simply omitted from the `PUT` patch (not sent as `null`/`0`) - matches the endpoint's
  own real behavior of "only supplied fields change, no way to clear one back to unset," so the UI
  doesn't invent a clear-field affordance the API can't honor. `AdminShell` gained a `retentionPolicy`
  nav entry (`HiOutlineClock`). Full react-shared rebuild + patch cycle to pick up
  `admin/retentionPolicyApi.ts`.

- **2026-09-12 (continued) — Phase 4 of consuming restapi's next batch: GDPR data export (Group D1).**
  New Settings page `apps/www/settings/privacy/index.tsx` ("Privacy & Data") - its first section,
  "Export my data": a format picker (JSON/Mbox), a "Request export" button, and a list of the caller's
  own past requests with a status pill (mirroring the status-pill styling already established in
  `apps/escrow/matters/[uid].tsx`'s access-request list) and a "Download" link that only appears once
  `status === "ready"`. The download link is a plain `<a href={exportRequestDownloadUrl(uid)}>` - no JS
  fetch/blob handling - the browser downloads it natively via the endpoint's own
  `content-disposition: attachment` header. Added a `privacy` entry to `SettingsShell`'s
  `SETTINGS_SECTIONS`, same pattern as `encryption`/`labels`. Admin-mediated export creation/browsing is
  deferred to the shared `apps/admin/data-requests` page built in Phase 6, alongside import and erasure.
  Full react-shared rebuild + patch cycle to pick up `mail/dataExportApi.ts`.

- **2026-09-12 (continued) — Phase 5 of consuming restapi's next batch: Mailbox import, Mbox + PST
  (Group D2).** Second section on the Privacy & Data settings page, "Import mail": a destination-folder
  `<select>` (populated via the already-existing `listFolders()`, filtered to exclude
  calendar/contacts/tasks/notes-type folders - importing mail into those wouldn't make sense), a hidden
  file input plus a visible "Upload Mbox or PST file" button (same two-element pattern
  `apps/admin/branding/index.tsx` already established for its own file uploads), and a status list
  showing `importedCount`/`failedCount` once `completed` or `errorMessage` once `failed`. The upload
  format (`mbox` vs `pst`) is inferred client-side from the picked file's own extension - the server takes
  it as an explicit query param with no server-side content sniffing, so getting this wrong would import
  nothing rather than auto-correct, but every real Mbox/PST export tool already names its files correctly
  by convention.
  - Removed a `(current) => current || ...` functional-updater guard on the initial destination-folder
    selection after confirming it was genuinely dead: this effect only runs once per mount (`[mailboxUid]`
    never changes without a full page reload in this MPA), so "preserve an already-selected folder across
    a second run" can never actually happen - same "remove a guard the surrounding architecture makes
    unreachable, don't write an untestable test for it" precedent already established earlier this
    session for `MailShell`-gated effects.
  - Admin-mediated import (into someone else's mailbox) is deferred to the shared
    `apps/admin/data-requests` page built in Phase 6, alongside export and erasure.
  - Full react-shared rebuild + patch cycle to pick up `mail/mailboxImportApi.ts`.

- **2026-09-12 (continued) — Phase 6 of consuming restapi's next batch: GDPR right-to-erasure (Group E) +
  the shared admin "Data Requests" page.**
  - Third section on Settings > Privacy & Data, "Delete my account": a clearly-worded, no-undo warning,
    a `Modal`-gated confirmation (same pattern as the mailbox-delete/escrow-scope-delete modals elsewhere
    in this codebase) before actually submitting, a request list showing status and (for a `denied`
    request) the admin's own reason, and the create button disabled while a request is already `pending`
    (mirrors the route's own 409 duplicate-check, though the button-disable is just a UX nicety - the
    server is still the real gate). No cancel action exists server-side, so none is offered client-side.
  - **New `apps/admin/data-requests/index.tsx`** - the shared admin surface promised in Phases 4-6: three
    stacked sections (no tab component exists in this codebase, and building one felt like scope creep
    for a page with only three sections - matches the "Encryption" settings page's own precedent of
    multiple stacked sections on one page):
    - **Export requests**: a mailbox-UID text field (no mailbox search/autocomplete component exists
      either - matches `apps/escrow/matters/new/index.tsx`'s own precedent of a plain UID field for the
      same reason) + format picker + "Create export", plus the full list of every export request across
      every mailbox (an admin sees all, per the route's own visibility rule).
    - **Import requests**: mailbox-UID field, on blur fetching that mailbox's folders (`listFolders()`)
      to populate a destination-folder picker - same fetch-on-demand pattern, just keyed to an
      admin-entered UID instead of the signed-in caller's own mailbox - then the same file-upload
      button/hidden-input pair as the self-service version.
    - **Erasure requests**: read-only list plus Approve/Deny on `pending` rows - no create form here at
      all, since `createErasureRequest()` has no admin-on-behalf-of path to begin with. Deny opens a
      `Modal` requiring a reason (disabled until non-empty, matching the route's own 400 validation).
      Approve surfaces a legal-hold 409 verbatim, naming the blocking Matter - the natural place Phase 2
      (Legal Hold) and Phase 6 (erasure) become end-to-end observable together.
  - `AdminShell` gained a `dataRequests` nav entry (`HiOutlineDocumentArrowDown`).
  - Full react-shared rebuild + patch cycle to pick up `mail/erasureRequestApi.ts`.
  - This closes out all seven features in restapi's compliance-roadmap batch except Group F (eDiscovery
    Matter export/search), which is Phase 7, not yet built.

- **2026-09-12 (continued) — Phase 7 of consuming restapi's next batch: eDiscovery, Matter export +
  Matter-scoped search (Group F).** Extended `apps/escrow/matters/[uid].tsx` (already a holder-facing
  page, never admin/self-service) with two new sections:
  - **"Export this matter"**: a "+ New export" button (`createMatterExportRequest`) plus the matter's own
    list of past export requests, filtered client-side the same "no server-side single-matter filter,
    fetch a generous page and filter locally" way `REQUESTS_FETCH_LIMIT`'s existing doc comment already
    covers for access requests - `listMatterExportRequests()` has the identical held-scopes-derived
    scoping, not a per-matter one. Status pill + `errorMessage` on `failed`, a plain
    `<a href={matterExportRequestDownloadUrl(uid)}>` Download link once `ready` (same native-download
    pattern as Phase 4/6's export links).
  - **"Search this matter's custodians"**: a single free-text input (the existing operator grammar - e.g.
    `from:alice@example.com` - already works here since `searchMatter()` reuses
    `search/searchApi.ts`'s own `buildSearchParams()` verbatim, not a separate parser) + Search button,
    results rendered grouped under an `<h3>` per `mailboxUid` - no merged cross-mailbox ranking or
    pagination beyond one page per custodian, matching the route's own documented scope trim.
  - `reload()` widened from a two-item to a three-item `Promise.all` (added `listMatterExportRequests()`);
    every pre-existing test in `test/apps/escrow/matters/[uid].test.tsx` needed a default
    `/api/escrow/matter-export-requests` mock response added to the shared `mockMatterFetch()` helper,
    plus the two tests that bypass that helper with their own inline `mockFetch()` fallback chains, since
    the new third fetch call was otherwise unmocked and threw. Two new tests written against grouped
    search results initially collided with existing "pending"/"mb1" text already on the page from the
    access-request section and the matter's own custodian-mailbox list - fixed by scoping those two
    assertions to `getByRole("heading", {level: 3, name: ...})` for the search results and by stubbing
    access-requests to `[]` in the export-list test, rather than loosening the assertions.
  - This closes out the full seven-feature compliance-roadmap batch (Legal Hold, non-owner access
    auditing, retention policy, GDPR export, mailbox import, GDPR erasure, eDiscovery) across `server`,
    `react-shared`, and `web-client`.

- **2026-09-12 (continued) — Adversarial review pass over the compliance-roadmap batch: a real race
  condition, fixed; a weak test, strengthened.** Two independent reviewers each read the full
  `cb8e585..99962f7` diff plus the react-shared wrappers/restapi contracts it calls. Verified findings:
  - **Stale-response race** in every "create/upload" section whose form/button isn't gated behind the
    section's own `loading` flag: `ExportRequestsSection`/`ImportRequestsSection` in `apps/admin/
    data-requests/index.tsx`, and `ExportSection`/`ImportSection` in `apps/www/settings/privacy/index.tsx`.
    Each has an unconditional mount-effect `loadRequests()` plus a second, independent `loadRequests()`
    call after a successful create/upload - both unconditionally call `setRequests()` on resolution, with
    no ordering guarantee between them. If the initial mount fetch is slower than the create-triggered one
    (a slow admin-panel network, not an exotic race), its now-stale response lands last and silently
    reverts the list, hiding the record the user just created until a manual page reload. Not present in
    the erasure sections (their action controls render only inside their own `{loading ? ... : ...}`
    branch) or in `apps/escrow/matters/[uid].tsx` (the whole page is gated behind one top-level
    `if (loading) return <Loading/>`).
    - Fix: each of the four `loadRequests()` functions now closes over a `useRef(0)` sequence counter,
      incremented on every call; the response handler only calls `setRequests`/`setLoadError` if its own
      captured sequence number still matches the ref's current value, so only the most-recently-issued
      call's response is ever applied - a strictly-older response arriving late is silently discarded.
    - Added a test per affected section (`test/apps/admin/data-requests/index.test.tsx`,
      `test/apps/settings/privacy/index.test.tsx`) using a manually-controlled deferred `Promise` for the
      first GET call so its resolution can be forced to land *after* the create/upload-triggered reload's
      response has already been applied - confirming the guard actually discards the stale data rather
      than just asserting the create call fired.
  - **Weak test**, not a functional bug: `test/apps/escrow/matters/[uid].test.tsx`'s "creates a new export
    request and reloads the list" only asserted a mock-local boolean flag was flipped by the POST handler,
    never that the export list actually re-rendered with the new request - it would have passed unchanged
    even if `reload()` silently failed after a successful POST. Strengthened to assert the "No export
    requests yet." placeholder is replaced by the new request's own pending-status pill.
  - Everything else both reviewers checked (Legal Hold 409 message surfacing, upload Content-Type/XSS,
    download-link premature-render races, IDOR-shaped UID foot-guns, Enter-key modal bypass) was verified
    clean against the real restapi contracts and this codebase's own components - explicitly noted as
    "checked, nothing found" rather than omitted.
  - A `server`-side finding from the same review round (the new `max_body_size` cap's memory footprint
    against the deployed Helm resource limits) is that repo's own NOTES.md entry, same date - no
    `web-client` change needed for it.

- **2026-09-12 (continued) — Fixed a real bug in `apps/escrow/matters/[uid].tsx`'s Matter search
  section, found while auditing outstanding spec work: `handleSearch()` passed the raw search-box text
  straight to `searchMatter()` with no operator-grammar parsing at all - unlike the inbox search UI
  (`apps/www/index.tsx`), which calls `queryGrammar.ts#parseSearchQuery()` first and forwards the
  structured fields separately. `searchMatter()`/`buildSearchParams()` expect exactly that split (operators
  already extracted into discrete params, only the free-text remainder in `q`) - so typing e.g.
  `from:alice@example.com` into this box did nothing useful; it was sent as four literal free-text words,
  not a sender filter. This directly contradicted this repo's own Phase 7 NOTES.md entry, which claimed
  the operator grammar "already works here" - it never actually went through the parser. Fixed by mirroring
  the inbox UI's own `parseSearchQuery()` → structured-`SearchParams` conversion. Added a regression test
  asserting the actual request URL carries `q=budget&from=alice%40example.com`, not the raw unparsed text.
  Rebuilt/refreshed the `react-shared` patch alongside this to also pick up a related Tier 3 free-text
  fix (quotes/negation/OR parity with Tier 1) - see that repo's own NOTES.md, same date.

- **2026-09-13 — Implemented the two items the Tier 2 search work had explicitly deferred: `specs/
  search.md` §8's composite pagination cursor, and §_Progressive Results_' skeleton/reorder/prune UX.**
  Both live entirely in `apps/www/index.tsx` plus small, self-contained additions to the Tier 2 worker -
  no `react-shared` change was needed for either, deliberately, to avoid that package's own
  publish+patch cycle (see this file's many earlier entries on that friction).
  - **Composite cursor (§8)**: `apps/www/index.tsx` now encodes/decodes a `CompositeCursor` (`tier1Cursor`,
    `tier2Offset`, `tier3Offset`, a `fingerprint` guarding against replay against a different query) and
    threads it through both the fresh-search pass and `loadMore()`. Tier 1 keeps using the server's own
    opaque cursor unchanged. Tier 2 gained real `OFFSET` pagination: `localIndexWorker.ts#search()` now
    takes an `offset`, fetches `limit + 1` rows to detect `hasMore` without a separate `COUNT(*)`, and
    returns `{ hits, hasMore }` (was a bare array) - threaded through `localIndexRpcClient.ts`/
    `searchTier2.ts`'s `Tier2SearchOutcome.hasMore`. Tier 3 (`searchEncryptedCandidates()` in
    `react-shared`, deliberately left untouched) doesn't get a real cursor at all - instead, its one
    decrypt-and-match pass per distinct (mailbox, query, "Search all mail" toggle, unlocked-or-not) is
    fetched once at a larger bound (`TIER3_CANDIDATE_LIMIT = 200`) and cached in a `Map` ref
    (`Tier3Cache`), with every page after the first just slicing further into that same array - avoids
    both a `react-shared` signature change and repeat decrypt cost, at the price of a search whose true
    candidate set exceeds 200 simply running out of pages (`hasMore` reflects this honestly).
    - **Real bug caught before it shipped**: the Tier 3 cache key initially didn't include whether the
      search ran with `unlocked` present. An on-demand unlock mid-search (`handleUnlockSearch()`) re-runs
      the same query, and without that dimension the second pass silently reused the *locked* pass's
      cached-empty Tier 3 result instead of actually re-fetching with real keys - caught by the existing
      "shows an unlock banner... and includes Tier 3 results once unlocked" test, which started failing
      the moment the cache was introduced. Fixed by adding an `unlocked: boolean` dimension to
      `tier3CacheKey()`.
    - Tier 3's own candidate window is also tightened to `before: coverage.indexedFrom` (Tier 2's already-
      covered range) by default, via `tightenBeforeToCoverage()` - re-decrypting what Tier 2 already fully
      covers would be pure waste. "Search all mail" (a new button next to the results count, shown once
      Tier 2 has reported) sets a `searchAllMail` flag that removes this bound for one re-run.
  - **Progressive Results**: the search effect no longer `Promise.all()`s all three tiers before setting
    any state. Tier 1 + Tier 2 fire together; the moment they resolve, results render immediately with any
    Tier 1 `metadataOnly` hit not yet confirmed by Tier 2 shown as a shimmering skeleton row (real
    `Skeleton` component, not the old static "Encrypted message" text) at its Tier-1-assigned position -
    per the spec's own precise wording, a Tier 3 candidate Tier 1 never itself surfaced has no provisional
    score/position and is deliberately never pre-rendered as a skeleton, only appearing once Tier 3
    actually confirms it. Tier 3 then runs (bounded as above) and does the final pass: anything still
    unconfirmed gets pruned outright rather than lingering as a permanent skeleton. A `tier1Done && tier2Done
    && tier3Done` gate withholds a hard result count ("n of ??" until settled, then "n results"). Every
    async stage is guarded by a monotonic `searchRunIdRef` (same pattern as `settings/privacy`'s
    `ExportSection.loadSeq`) so a stale in-flight pass from an already-superseded query can't clobber
    newer state. `loadMore()` pages are deliberately *not* progressive (fetched and appended in one shot,
    same as before this work) - reordering/growing skeletons under content a reader has already scrolled
    past would be worse UX than the first-page-only progressive reveal this implements; documented inline
    as a deliberate scope trim.
  - **Tooling gotcha hit while writing this**: an `Edit` tool call containing the literal 6-character
    escape sequence `\u0000` inside a JSON `old_string`/`new_string` parameter gets decoded as an actual
    NUL byte (0x00) written into the file, not preserved as literal backslash-u-0000 text - happened
    while writing `tier3CacheKey()`'s original separator. The corrupted file still round-tripped through
    `Read` (which silently renders embedded NUL as visually-empty/space-like output) and `tsc`/`vitest`
    without any visible error, so it went unnoticed until a later, unrelated `Edit` call on a *different*
    line inexplicably failed its exact-string match. Found via `Buffer.indexOf(0)` on the raw file bytes.
    Fixed by a small Node script swapping the two literal NUL bytes for a plain `|` separator (`latin1`
    read+write round-trip, which preserves every other byte - including this file's own em dashes/
    ellipses - exactly). Lesson: never rely on a visual `Read` diff to confirm a suspected encoding issue;
    check the actual bytes.
  - **Verification**: `tsc --noEmit` clean; full `web-client` suite green (121 files/1392 tests, confirmed
    across two separate full runs - one run's 2 unrelated failures, in `index.test.tsx`'s plain-folder
    infinite-scroll test and an unrelated `settings/filters/new` test, did not reproduce on a second full
    run or in isolation, matching this file's own prior notes on this suite's pre-existing test-order
    flakiness). The real `OFFSET`/`LIMIT + 1` SQL added to `localIndexWorker.ts#search()` can't be
    exercised by vitest at all (no environment here implements OPFS/Worker) - verified instead against the
    *real* `@journeyapps/wa-sqlite` engine (real FTS5, real `bm25()`) via a disposable static-file-served
    page driven by Playwright: 12 rows, 3 pages of `limit=5`, confirmed no gaps/overlap across pages and
    correct `hasMore` on each. Added test coverage in `test/apps/index.test.tsx` for the composite cursor
    (Tier 2 offset threading + Tier 3 cache reuse across a `loadMore()`) and Progressive Results (skeleton
    render/prune, settled-count gate, "Search all mail" removing Tier 3's bound).

- **2026-09-14 — Shared mailboxes: Sharing settings page, multi-mailbox Mail/Calendar.** Spans restapi
  (`BaseMailboxAccessRoute`: list/grant/revoke delegates as viewer/manager, gated at ACL `update`; and
  `GET /mail/mailboxes/lookup-by-email`), server (route wrappers + restapi patch), react-shared
  (`mailboxAccessApi.ts`, `accentColorForMailbox()`), and here.
  - **No backend inheritance work was needed**: every folder's ACL already has `parentUid: mailboxUid`,
    and events/contacts/tasks/messages have no ACL of their own, so one mailbox grant covers everything.
    Booking links for a shared mailbox also already worked via the Settings mailbox switcher (now pinned
    by a restapi `BookingTypeRoute` test: manager delegate 200, viewer 403).
  - **No user directory exists** in this platform (identity is an external auth-server restapi never
    calls), so "add by email" resolves against `Mailbox.primarySmtpAddress`/aliases and uses that
    mailbox's `ownerUserUid`. Shared (ownerless) mailboxes never resolve.
  - `MailShell` now renders every mailbox's folder tree plus an "All Mailboxes" section (`?aggregate=`);
    `MailShellContextValue.folders` was replaced by `mailboxFolders`. Aggregate views: first page per
    mailbox only (no load more), search and Focused/Other disabled, unlock/decrypt scoped to the caller's
    own mailbox (other mailboxes' encrypted rows stay locked until opened directly - user-accepted).
  - `CalendarShell` loads all mailboxes' calendars; uncolored calendars outside the caller's own mailbox
    fall back to `accentColorForMailbox()` so a shared calendar isn't the same default blue. EventModal is
    scoped to the target calendar's own mailbox (organizer address + calendar picker).
  - **Test gotcha**: `mockLocation()` never restores `window.location`, so setting `.search` in one test
    leaks into later tests in the same file - reset with `mockLocation()` afterwards.
  - **Yarn gotcha**: `yarn patch <pkg> --update` on an already-patched dependency stacks a second
    patch-of-a-patch resolution. For a clean single patch, run `yarn patch "<pkg>@npm:<version>"` against
    the original and copy in *all* changed build files, then `patch-commit` (it rewrites the same file).
  - **Not verified live**: the `server` repo consumes this package as published `@rapidmx/web-client`
    ^0.3.1, so these UI changes aren't visible in `yarn dev` there until web-client (and react-shared) are
    published or patched into `server` too. The restapi routes were verified in a real `yarn dev` boot.

- **2026-09-14 — Review fixes, mail/search side (Tier 2 local index hardening + inbox races).** Not
  committed. Admin/plugins/setup/react-shared were another agent's scope and untouched here.
  - **Real Worker tests now exist**: `test/apps/_search/localIndexWorker.test.ts` runs the actual worker
    module against the real wa-sqlite Asyncify build in node (pass `{ wasmBinary: readFileSync(...wasm) }`
    to the factory - its own fetch fails in node) with the real `EncryptingVFS`/WebCrypto; only
    `AccessHandlePoolVFS` is swapped for wa-sqlite's `MemoryVFS` over a shared per-name map (survives
    close/reopen like OPFS) and `self`/`navigator` are stubbed. Supersedes the "can't run under vitest at
    all" notes above - use this harness for any further worker change.
  - **Asyncify gotcha (root cause of "corruption never rebuilds")**: an exception thrown from an async
    VFS `jRead`/`jWrite` does NOT reach the awaiting `sqlite3.*` call - it becomes an unhandled rejection
    and the SQLite call hangs forever (reproduced in node). `EncryptingVFS.jRead/jWrite` now catch, set
    `corruptionDetected`, and return `SQLITE_IOERR_READ/WRITE`; the worker treats that flag (or
    `SQLITE_CORRUPT`/`NOTADB`/"malformed") as corruption: discard the pool directory and reopen empty,
    both at open time (incl. wrong key) and mid-session (`withConnection()`). An ordinary bad FTS5 MATCH
    still fails soft.
  - **Serial queue**: every worker request runs through a per-mailbox promise chain (`runExclusive`) -
    concurrent `postMessage` requests were re-entering the non-reentrant Asyncify module, and two racing
    `init`s opened two VFS instances over one pool. Verified the concurrency test fails with the queue
    bypassed. Each mailbox has its own module instance, so per-mailbox (not global) is sufficient.
  - **Schema v2**: `entity_version` column (builder skips messages already indexed at `version:folderUid`,
    one batched `IN (...)` lookup per page) and `auto_vacuum=INCREMENTAL`. A version mismatch now deletes
    and recreates the whole file (auto_vacuum only applies before the first table exists).
  - **Budget**: measured as `(page_count - freelist_count) * page_size` (counts FTS shadow tables), bulk
    eviction by an oldest date/rowid cutoff sized from a running `byte_size` weight total, then
    `incremental_vacuum`. `indexEntities` returns `budgetReached`; the builder stops walking that folder.
    Fetch/decrypt concurrency capped at 6. Archive folders are now indexed too (were never walked).
  - **Coverage completeness**: new `Coverage.complete` + `covered_from` meta. A pass is complete only if
    every folder reached its time floor with no listing/fetch failure and no budget stop.
    `tightenBeforeToCoverage()` only narrows Tier 3 when `complete && !building`, and `indexedFrom` is then
    `max(MIN(date), time floor)` (a folder's last page can reach further back than another's). A complete
    pass also prunes rows the server no longer lists within the floor (deletes/moves from any client).
  - **Stale entries in-session**: `MessageDetailPane` archive/cancel-scheduled-send call
    `moveLocalEntity()`. There is no message delete action in the mail UI, so `removeLocalEntity()` still
    has no UI caller - build-pass pruning covers deletions. Both helpers no-op (no Worker spawn) for a
    mailbox not indexed in this tab.
  - **Logout / other users**: `destroyAllLocalIndexes()` enumerates OPFS for `rapidmx-localsearch-*`
    (new `localIndexStorage.ts`, wa-sqlite-free so the main thread can use it), closes this tab's
    connections via the worker first only if one is running, and is awaited by `AppShell` sign-out with a
    3s timeout. `LocalIndexLifecycle` gets `accessibleMailboxUids` from `MailShell` and prunes directories
    for any other mailbox (a previous user's) once per distinct list.
  - **Cross-tab**: an exclusive, `ifAvailable` Web Lock per mailbox; the second tab's `init` fails with a
    logged reason. `destroyLocalIndex()` now resolves `false` (and logs) instead of swallowing failures.
  - **Lifecycle**: tracks every mailbox it built (not just the active one) and never resets the unlocked
    state in the effect body, so a key destruction between polls isn't lost to a re-render/mailbox switch.
  - **Inbox (`apps/www/index.tsx`)**: run id bumped on every effect run (and on cleanup), checked by the
    folder/conversation/aggregate listings and `loadMore()`; `loadMore` appends only unseen uids; Tier 2
    `ORDER BY` has an `entity_uid` tiebreaker. Labels are fetched for the selected message's own mailbox
    (same in `messages/[uid].tsx`). Verified all six new inbox tests fail against the HEAD version.
  - **Other**: `UnlockPromptProvider` joins a same-mailbox request to the open dialog and rejects a
    superseded different-mailbox request; calendar `reload()` has a sequence guard (no date range - the
    API deliberately fetches whole calendars, see `listCalendarEvents()`); `AppShell` only asks
    `getSetupStatus()` for a `trusted` caller.
  - **Writable mailboxes** (`writableMailboxes.ts`): `Mailbox` has no per-caller role, so writability is
    "owned, or `listMailboxAccess()` succeeds" (that route is gated at `update`: manager/admin yes, viewer
    403). Only a 403 hides a mailbox; other errors fail open. Applied to Compose From (session's own mailbox
    always kept), EventModal mailbox options, ContactForm, and the task quick-add picker. Compose From switch
    now creates the new draft before deleting the old one (old one kept if creation fails).
  - Lint: fixed pre-existing errors in the touched files, including stale
    `eslint-disable react-hooks/exhaustive-deps` comments (that plugin isn't configured, so the disable
    itself is an error).

- **2026-09-14 — Round-2 review fixes, admin side (Plugins, setup wizard, mailbox/retention policy).** Not
  committed. Coded against restapi's concurrent contract changes (`expectedPlan.version` checked; planning an
  installed plugin at its installed version uses the stored manifest; a PUT that leaves a plugin disabled
  ignores `expectedPlan`).
  - **Plugin settings (`PluginsManager` `SettingsModal`)**: round 1's "send only changed settings" wiped every
    other saved setting, because restapi replaces the whole `settings` object. Now every setting is sent: an
    untouched one as saved (`null` when unsaved, so it keeps following the plugin default rather than pinning the
    displayed default), a changed one as entered. Kept: a required select with no saved value/default starts on
    (and saves) its first option; nothing changed still just closes.
  - **Enable**: planned at the installed version (no registry needed per the contract). If the plan request
    itself fails, falls back to a plain `updatePlugin({enabled:true})` with no `expectedPlan`, then reloads the
    list; server refusals show as usual. Install/version-change plan failures still just show the error.
  - **Version change / Upgrade of a disabled plugin**: no plan, no confirmation - `updatePlugin({packageVersion})`.
  - **Busy rows**: a `Set` of busy uids; a row whose change is waiting in the dependency confirmation is also busy
    (derived from `confirming.uid`), so it stays disabled until that dialog closes.
  - **Reload failure** after a change that brought in other plugins shows "may be out of date" + Retry.
  - **Status polling**: one read in flight at a time (`statusRequest` ref shared by ticks/`watchRollout`); when no
    status has ever been read, retries with backoff 5s, 10s, 20s... capped at 60s.
  - **AddPluginModal**: an add that resolves after the dialog closed no longer sets error/busy on a reopened dialog
    (`openToken`); closing also resets `busy`.
  - **SetupWizard**: `requestGoTo(step)` for the step already shown is a no-op (it used to clear `unsaved` while the
    forms kept their edits, so a later Continue dropped them without asking).
  - **MailboxPolicyForm**: sends only changed fields, each only if its GB text changed, so untouched quotas keep
    their exact bytes; GB shown unrounded (`bytes / 1e9`, e.g. 4 MB = 0.004 instead of "0" which blocked saves).
    Nothing changed = "Saved." without a request. A quota rounding to < 1 byte is rejected client-side.
  - **RetentionPolicyForm - not fixed as asked**: restapi's `BaseRetentionPolicyRoute.validateUpdate()` rejects
    `null` (400, must be a positive integer) and `extractPatch()` ignores omitted fields, so a configured retention
    period can't be cleared at all (its doc comment says so: a fast-follow). Instead of a false "Saved.", blanking a
    period that's already set now shows an error and sends nothing. Needs a restapi change to support clearing.
  - Sharing page access members (finding 11) is mail-side - left to that agent.

- **2026-09-14 — Round-2 review fixes, mail/search side (Tier 2 coverage honesty, build lifecycle, compose From).**
  Not committed. Supersedes parts of the round-1 mail/search entry above where they conflict.
  - **Coverage only counts a pass completed this session, and only up to when it started**: nothing indexes mail
    arriving after a pass, so `build_complete` alone went stale (reload, new mail). The worker now clears
    `building`/`build_complete`/`covered_from`/`covered_until` whenever it opens an index (`init`), and a complete
    pass records `covered_until` = pass start minus `CLOCK_SKEW_MARGIN_MS` (10 min). `Coverage.indexedUntil` is
    set only while complete. Chose this over incremental indexing of new mail (simpler, same correctness).
  - **Tier 3 narrowing** (`apps/www/index.tsx`): `tightenBeforeToCoverage()` replaced by `tier3Windows()`, which
    returns the query range minus `[indexedFrom, indexedUntil]` - up to two windows (`before: indexedFrom`,
    `after: indexedUntil`), none if the query lies inside the coverage; no narrowing without `indexedUntil`.
    `searchTier3Windows()` runs each and de-dupes by uid. The Tier 3 cache key is now the JSON of the windows
    actually run (+ mailbox, unlocked), and `CompositeCursor.tier3Key` carries it so `loadMore()` slices the same
    entry (it no longer recomputes a key; it does nothing while the current query has no cursor yet).
  - **Folders**: `user` (custom) folders are walked; any folder type in neither the mail nor the known non-mail set
    (`calendar/contacts/tasks/notes`) makes the pass incomplete.
  - **Offset pagination during a long walk**: `listMessages()` has no cursor/`before` param (react-shared), so the
    builder reads folder `totalCount`s (`listFolders`) before and after each walk; a folder whose count changed is
    re-walked (up to `MAX_WALK_ATTEMPTS` = 3, version skip keeps it cheap). Only steady folders are "reliable":
    `pruneEntities` takes `folderUids` and only deletes unseen rows filed in those; the pass is complete only if
    every mail folder was reliable. Count lookup failure = indexed but not reliable. Known gap: a +1/-1 change
    during a walk leaves the count equal.
  - **Build generations**: `nextLocalIndexGeneration()` (rpc client) is one counter shared by builds and destroys.
    Every build call (`init/setWindow/setBuilding/indexEntities/pruneEntities`) carries its generation; the worker
    records a destroy's generation synchronously on arrival (so an already-queued stale call is rejected too) and
    rejects older generations with `StaleGenerationError`; `destroyAll` records a global one. The builder also keeps
    one pass per mailbox (`AbortController`; a new pass aborts and awaits the old) and exports
    `cancelLocalIndexBuild()`, which `LocalIndexLifecycle` calls on a lock transition. Final `setBuilding(false)`
    failures are swallowed.
  - **Eviction watermark**: `applyEviction` stores `evicted_before` (newest cutoff deleted; never moves backwards);
    `indexEntities`/`setWindow` return it. The builder skips fetching messages strictly older than it and stops a
    folder when a page's oldest message is older (only if the watermark is inside the time floor) - replaces
    "stop when anything was evicted", so older retained pages refresh flags again. `setWindow` clears it when the
    budget is 0 or used bytes are <= 90% of budget (hysteresis). Budget-limited passes still count as incomplete;
    prune `since` is the watermark when it's inside the floor.
  - **Worker hardening**: the fresh connection after a discard (open-time and mid-session) is closed if schema
    creation fails (`openFreshConnection`). Corruption = `LocalIndexCorruptedError`, `vfs.corruptionDetected`,
    `SQLITE_CORRUPT`/`SQLITE_NOTADB`, or an exact "database disk image is malformed"/"file is not a database"
    message - the old `/malformed|not a database/` substring match wiped the index on FTS5 errors echoing the query.
  - **Sign-out / deletions**: `destroyAllLocalIndexes()` broadcasts `{type:"sign-out"}` on BroadcastChannel
    `rapidmx-localsearch`; a tab with a Worker (listener registered in `getWorker()`) runs `destroyAll`, and every
    tab refuses further `initLocalIndex` (`signedOut`). Worker `destroyAll` now closes and removes each mailbox's
    directory inside that mailbox's queue. Failed deletions are recorded in localStorage
    (`rapidmx-localsearch-pending-deletions`; `"*"` is written before a sign-out starts = remove everything) and
    retried once per page load before the first `init` (`retryPendingLocalIndexDeletions()`). Accepted cost: a
    pending entry for an index another tab legitimately reopened gets deleted later and rebuilt.
  - **Compose From / writability** (`writableMailboxes.ts`): uses `getMyMailboxAccess(uid).canCreate`
    (`GET /mail/mailboxes/:id/access/me`, restapi side in progress) instead of `listMailboxAccess()` (wrong proxy:
    gated at `update`). Owner or `trusted` short-circuits to writable (`AppShell` passes `trusted && !impersonating`
    through `ComposeProvider`); answers are cached per page load in module maps with in-flight de-dupe; errors
    (incl. a 404 from an older server) are "unknown" = listed and not cached. `filterWritableMailboxes()` removed;
    new `useMailboxWritability()`/`peekMailboxWritability()`. Pickers list everything immediately and drop view-only
    mailboxes as answers arrive (was: only owned ones until every check settled). ComposeWindow never defaults to a
    known view-only mailbox, and switches a sender that turns out view-only (e.g. a reply in a read-only share) to
    the caller's own / a writable / an unknown mailbox via `handleFromChange`. Tests must call
    `clearMailboxWritabilityCache()` between cases. Calendar/Contacts pages don't get `trusted` (not plumbed).
  - **Small ones**: ComposeWindow deletes `supersededDraftsRef` drafts on unmount (close/send). MailShell passes
    `accessibleMailboxUids` only when `listMailboxes` returned fewer than `MAILBOX_LIST_LIMIT` (100). A 503 from
    `autoProvisionMailbox()` shows "Couldn't check right now" + Retry instead of "No mailbox available".
  - **Test gotcha**: a builder test whose `listMessages` mock resolves immediately forever never yields to timers,
    so `vi.waitFor` can't poll and the fork dies with exit 134 (OOM) - make endless mocks `await` a `setTimeout`.
