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

- **2026-09-14 — Round-3 review fixes, www pages (W1: inbox, settings, contacts/tasks/calendar pages).** Not committed.
  - **Encryption settings**: regenerating recovery codes now *adds* the new wraps first, then removes the old ones by
    `methodId`. `buildRecoveryWraps()` always labels wraps `recovery-1..N`, and restapi's remove deletes every wrap
    with a matching `methodId`, so each new wrap is relabelled `recovery-<batch>-<i>` before it's added. The button is
    disabled until the vault loads. Whatever codes saved are shown even on partial failure, with a warning on the
    codes screen. If not every new code saved, the old codes are kept. If some old ones couldn't be removed, the
    warning says so. Removing an unlock method now needs confirmation, and the last non-escrow method shows "Your
    only unlock method" with no Remove button (restapi also returns 409). Key rotation: refused unless the unlocked
    session covers every active key in `displayedKeys` (e.g. a signing key issued after unlocking), since `rekey()`
    would drop it. It sends `displayedKeys` (including `refreshedKeys`). Codes show as soon as `rekey()` commits.
    Escrow re-wrap and re-unlock handle their own errors. If re-unlock fails, the session keys and local index are
    destroyed, and the "keys removed" screen explains why once the codes are acknowledged.
  - **Inbox (`apps/www/index.tsx`)**: Tier 1 `search()` and Tier 3 `searchEncryptedCandidates()` pass the open
    `mailboxUid`, on the first page and on load-more. A `subscribeKeySession` "locked" event for `activeMailboxUid`
    clears `decryptedRows`, `snippets` and the Tier 3 cache, and a live search re-runs. The sentinel is now a
    callback ref kept in state, so the observer re-attaches whenever the node remounts. It also renders in the
    empty-filtered branch. After a page lands with the sentinel still in view, loading continues. Offset paging:
    `listedOffsetRef` counts server rows fetched and goes down by one per local removal (archive or scheduled-send
    cancel). Load-more requests `floor(offset/50)`, and `appendUnseenMessages` removes the overlap. Aggregate mode
    picks `ownerUserUid === userUid`.
  - **Privacy**: export and erasure only show while the selected mailbox is the caller's own. Otherwise a notice
    names the own mailbox. Both sections name their target. ImportSection shows an error when `listFolders` fails.
  - **Auto-reply / read receipts**: keep the version each `updateMailbox()` returns. Cleared OOF dates are sent as
    `null`. Read receipts gained federated request/auto-send toggles (default false, same as restapi).
  - **Booking type detail**: separate load and save errors, so the form stays on a failed save. `description` is
    sent as `null` to clear it (cast: `UpdateBookingTypeInput` doesn't declare null). The contact detail page shows
    a delete error above the contact instead of replacing the page.
  - **Filter detail**: folders load for `original.mailboxUid`.
  - **Tasks/calendar**: date-only values are parsed with `parseISO()` (local day). Tests can set `process.env.TZ`
    at runtime (e.g. `America/Los_Angeles`) and restore it, which Node honours even under the suite's TZ=UTC.
  - **Deletes and lists**: tasks (single + bulk) and contacts bulk delete now need confirmation in a Modal.
    Contacts/tasks lists page through all results via `apps/shared/mail/listAllPages.ts` (500 per page, 40-page
    safety cap). The contacts Add category request sends only `{uid, version, categories}`. The vCard export URL
    is revoked after 60s. Focused Inbox lowercases the sender address (restapi normalizes it anyway).
  - **Test gotcha**: in `test/apps/index.test.tsx`, other tests replace `window.location` with `mockLocation()`,
    so `history.pushState` doesn't reach `location.search` later in the file. Set `search` on a fresh
    `mockLocation()` instead. A vitest coverage dir lock can outlive a killed background run, so use a new
    `reportsDirectory` name if a run reports the directory is in use.

- **2026-09-14 — Round-3 review fixes, admin + escrow consoles (W3).** Not committed.
  - **Branding**: `BrandingChrome` sanitizes header/footer HTML with DOMPurify (also strips style/form/input/
    button/iframe/object/embed/svg/math/link/meta/base and `action`/`formaction`/`srcdoc`). With no DOM (SSR) it
    renders nothing rather than raw HTML. The escrow console skips branding HTML and the custom stylesheet
    entirely: `EscrowShell` calls `getBranding()` only for the rail icon (not `useBranding()`, which injects the
    stylesheet), and `apps/escrow/_layout.tsx` no longer links it. `BrandingForm` refuses SVG logo/icon uploads by
    MIME type or `.svg` name, and the file inputs accept raster types only.
  - **Escrow scopes**: `selfAsHolderError()` (in `EscrowScopeKeyAndHoldersFields.tsx`) blocks adding the signed-in
    admin as a holder on the new page, the `[uid]` page (only if newly added), and the setup wizard's escrow step
    (`SetupWizard` passes `adminUid`). The generated-key step also warns that whoever downloads the key must not be
    a holder. `[uid]` shows a "Confirm escrow scope changes" diff (holders added/removed, required approvals, key,
    fingerprint, validity) before saving any of those; name/description-only saves go straight through.
  - **Paging**: `apps/shared/components/admin/usePagedList.tsx` (`usePagedList` + `LoadMoreButton`, 50 per page) is
    used by all three data-request lists and the matter page's access/export request lists (with `matterId`; rows
    are still filtered client-side in case an older server ignores it). Only the latest `reload()` applies, and a
    Load more that was in flight during a reload is dropped. Ingest queue got Previous/Next paging (25) with a
    cancelled-effect guard.
  - **Confirmations**: erasure Approve (names the mailbox, irreversible, errors shown in the modal); matter Close
    (custodians + date range) and access-request Approve (matter, mailbox, date range, approval count); quarantine
    "Mark released" (reason, date, original message uid - `QuarantineEntry` has no sender/subject, so those aren't
    shown; `releaseQuarantineEntry()` still sends `releasedAt`/`releasedByUserUid`, which the server now overwrites);
    share Revoke (the owner row, via the new `ownerUserUid` prop, has no Revoke); impersonation ("Access this
    mailbox", error stays in the modal instead of replacing the page); retention (setting message retention when
    none is set, or lowering it, compared against the last saved value); transport rules without conditions
    (blocked when any action is reject/quarantine, "Apply to every message?" otherwise - uses W2's exported
    `hasConditions()` via `checkRuleConditions()` in `_transportRuleConfig.tsx`).
  - **Matter page**: closed matters hide "+ New export", the search form, and "Get material". Closing clears any
    open material and search results. "Get material" has a sequence guard, so a response that arrives after its
    modal was closed (or for an earlier request) is ignored.
  - **Smaller**: ShareAccessCard grants merge with the uid's existing actions (never downgrade) and say "already has
    this access" when nothing is missing. ResourceSettingsCard sends `null` for cleared numbers. Admin audit log
    debounces filter typing (`FILTER_DEBOUNCE_MS` 300), never fetches before the URL filters are read, and ignores
    stale responses. Escrow audit log labels `matter_export.*` and falls back to the raw action. DomainDnsSetup shows
    verify/refresh failures next to a "Try again" button and keeps the panel. New `EscrowScopeCard` on the admin
    mailbox page assigns `escrowScopeId` (or `null`). PluginsManager's rollout banner lists errors reported under
    plugin name `"*"`.
  - **Test gotchas**: AdminShell also fetches `/api/system/setup` etc., so a mock that hangs or fails "everything
    but release-notes" catches the shell's own calls too - match the page's URL prefix instead. userEvent `clear`
    on the required-holders number input leaves `1` (the `|| 1` fallback), so typing appends; use `fireEvent.change`.

- **2026-09-14 — Round-3 review fixes, W2 (mail panes/compose, calendar, contacts, rules, AppShell).** Not committed.
  - **EventModal**: "This event only" hides the Repeats editor and never sends a rule (react-shared's
    `detachOccurrence` also forces it off). "Entire series" no longer sends the occurrence's dates: unchanged times
    aren't sent; changed ones fetch the master (`getCalendarEvent`) and apply only the time-of-day delta + new
    duration to the master start (`toSeriesFields`; all-day<->timed transitions handled). `organizer` only on create.
    An event whose organizer isn't this mailbox (and no `isOrganizer` attendee matching it) is read-only: fields in a
    disabled `<fieldset>`, no Save/scope choice, RSVP block moved to the top. Updates in place send `null` for cleared
    location/reminder/recurrenceRule/autoReplyMessage (creates/detaches omit them).
  - **All-day = date-only** (`calendar/allDay.ts`): stored as UTC midnight of the first day, exclusive `endDate` (UTC
    midnight after the last day); the modal shows the inclusive last day. Reading rounds to the nearest UTC midnight
    so legacy local-midnight values land on the intended date (wrong only for UTC-12/+13/+14 creators). Month/week/
    split views use `occursOnDay` - multi-day events show on every covered day (timed blocks clipped per day); only
    the start day's chip/block is draggable (`startsOnDay`), later days render non-draggable continuation copies
    (dnd-kit ids must be unique). Test fixtures with `allDay: true` must use midnight dates.
  - **RecurrenceEditor**: empty interval/count keep the previous value, <1 clamps to 1; "Ends on" stores the end of
    the chosen *local* day; an empty date input is ignored.
  - **ContactForm**: keeps/edits all `addresses` (first entry keeps the old "Address type"/"Remove address" labels,
    later ones get an index suffix); update is a `ContactPatch` (uid/version + fields, no mailbox/folder) with `null`
    for cleared text fields.
  - **RuleBuilder**: exports `hasConditions(conditions)` (non-blank list entry, truthy boolean, non-empty select) and a
    `showValidation` prop; always shows an "Add at least one condition" hint (becomes `role=alert`/danger with
    `showValidation`). **W1 (www settings/filters) and W3 (admin transport-rules) pages must call `hasConditions()`
    before saving and pass `showValidation` after a rejected save.** Typed-but-not-added list text commits on blur
    (so clicking Save captures it). Removing a list's last entry deletes the key; unticking a boolean stores
    `undefined`. `removeListEntry`'s `?? []` fallback is gone, so the vitest.config branch-exception comment about it
    is stale.
  - **AppShell sign-out**: `destroyUnlockedKeys()`, then in parallel `destroyAllLocalIndexes()` and auth-server logout
    (`authApiFetch(authServerUrl, "/auth/logout", POST)` = `${authServerUrl}/api/auth/logout`, credentials include,
    aborted after `LOGOUT_TIMEOUT_MS` 3s, errors ignored), then navigate. Other tabs: AppShell listens on
    `SIGN_OUT_CHANNEL` (the `{type:"sign-out"}` `destroyAllLocalIndexes` already broadcasts) and destroys keys +
    navigates; the originating tab ignores its own message (`signingOutRef`). AdminShell/EscrowShell (W3) still only
    navigate. Tests that mock `crypto/keySession.js` and reach sign-out or ComposeWindow need `destroyUnlockedKeys`/
    `subscribeKeySession` in the mock.
  - **KeyEnrollmentGate** `canProvision` (default true); MailShell passes `activeMailbox.ownerUserUid === userUid`, so
    a shared mailbox without a vault is never provisioned by a delegate. Unlock is unaffected.
  - **ComposeWindow/ComposeContext**: sign/encrypt that can't happen (keys locked, mailbox/policy fetch failed while
    encryption is possible) blocks send with a banner + explicit "Send without ..." override and re-prompts unlock;
    re-renders on `subscribeKeySession`. Overrides replay a pending schedule time and are disabled while sending.
    Encrypt + Bcc is blocked (one draft/one envelope, no per-recipient copies). Inline images (cid:/uploaded
    attachment URLs) are blocked when signing/encrypting. Autosave after `DEFAULT_AUTOSAVE_DELAY_MS` (2s, prop
    `autosaveDelayMs`) via the existing draft save, never for encrypted messages; discard asks (in-app Modal) and
    deletes the draft; close saves (or deletes a blank draft). Mobile keeps background sessions mounted but hidden.
    **react-shared follow-up**: `crypto/smimeMessage` `buildSignedOnlyMessage()`/`buildEncryptedMessage()` write the
    body part without `Content-Transfer-Encoding` (raw UTF-8, TipTap HTML is one long line) - should base64/QP it.
  - **MessageDetailPane**: client-rendered HTML uses a dedicated DOMPurify instance allowing only `data:`/`cid:` URLs
    (attributes, inline/`<style>` `url()`/`image-set`, no `@import`/link/meta/base) plus a CSP meta in `srcDoc`;
    `result.text` renders in a `<pre>`. Raw content is fetched only for `encrypted || hasAttachments` (no signed
    flag exists; S/MIME parts arrive as attachments - so ordinary attachment mail still fetches raw; a restapi
    `signed` flag would fix it). `getMessageRawContent` takes no AbortSignal, so stale results are dropped via a
    cancelled flag. `signature_failed` shows the `signatureFailureReason` as a neutral status. Key lock clears the
    decrypted body. Inner component keyed by `message.uid`; label toggles build on the newest version.
  - **ConversationThreadPane**: generation counter drops stale loads/errors/mark-read results; mark-read and
    attachment fetches once per message uid with the current version.

- **2026-09-14 — Round-4 review fixes, W3 (admin + escrow consoles).** Not committed.
  - **Escrow scope edit** (`apps/admin/escrow-scopes/[uid].tsx`): `buildPublicKeyUpdate()` sends `publicKey` only when a
    key field changed (the form shows dates to the minute - re-sending always truncated them). An untouched date keeps
    its stored epoch-ms; `revokedAt` is carried over when only the validity window changed and dropped when the key
    material/type/fingerprint is replaced (a new key isn't revoked - judgment call). Server compares keys semantically
    anyway (fingerprint case-insensitive, seconds, revokedAt). The confirm diff now lists `notifySubjectOnAccess`; a
    cleared description sends `null` (update is a merge - omitted = unchanged).
  - **Matter detail**: closed matters hide export Download (server refuses) and Approve/Deny. Search has a `searchSeq`
    guard bumped by close, so an in-flight search's results/error never render after closing.
  - **AdminShell/EscrowShell sign-out** -> `apps/shared/components/admin/signOut.ts` `signOutOfConsole()`: broadcasts
    `{type:"sign-out"}` on `CONSOLE_SIGN_OUT_CHANNEL`, awaits auth-server logout (3s abort, errors ignored), navigates.
    Channel name is **duplicated** from `apps/shared/search/localIndexRpcClient.ts` `SIGN_OUT_CHANNEL`
    ("rapidmx-localsearch") to keep the Worker client out of the console bundles; `signOut.test.ts` asserts they match.
    Consoles don't listen for other tabs' sign-out (no keys/indexes live there) - possible follow-up.
  - **PluginsManager**: enabling never falls back to an unplanned enable when the preview fails; the error Alert shows a
    "Try again" (re-runs `toggle` on the currently listed plugin; hidden once it's enabled or another row action runs).
  - **EscrowScopeCard**: assign/clear goes through a "Change escrow scope" confirm showing From/To scope name, holders
    and M-of-N (or "No escrow" / "Unknown scope (uid)").
  - **RetentionPolicyForm**: starting/lowering audit-log retention is confirmed too; modal is now "Delete older data?" /
    "Save and delete older data" with one paragraph per shortened period.
  - **Busy modals**: data-requests approve/deny, mailbox access/delete and escrow-scope delete ignore Escape/Close while
    their request runs (matter close modal still closable while closing - left as is).
  - **usePagedList.loadMore** re-reads page N-1 with page N and appends after the last shown row's uid (deletions shift
    rows back a page; repeats still deduped). If that uid isn't in the two pages it `reload()`s from page 0 (drops
    extra loaded pages). Costs one extra request per Load more.
  - **Transport rules list**: `listTransportRules()` has no sort param (server supports `sort=`, wrapper doesn't pass it),
    so the page fetches every server page (limit 1000) once, sorts by sequence then name, and pages 25 client-side.
  - **Escrow audit verify**: `describeVerificationFailure()` maps `reason` (hmac_key_unavailable -> "Audit key not
    configured...", truncated -> "Entries missing at the end...", head_missing/head_mismatch/head_mac_mismatch,
    link/hash_mismatch, unknown_algorithm, algorithm_downgrade) plus "(at sequence N)"; unknown reason -> generic.
  - **BrandingForm GIF**: kept; tests now assert both accept lists include image/gif and upload a GIF logo.

- **2026-09-14 — Round-4 review fixes, W1 (www inbox, Settings > Encryption/Privacy, contacts/tasks lists).** Not committed.
  - **Encryption: unlock methods.** The app can only unlock with a password: react-shared's `unlockWithPassword()`
    tries only the *first* password wrap. So `canRemoveWrap()` never offers Remove on the last password wrap
    ("Needed to unlock", or "Your only unlock method" when nothing else is on file). Recovery codes and passkeys
    don't count toward that. Other non-escrow wraps keep the old rule (removable while more than one exists).
    "Add a password" only renders while the vault has **no** password wrap. Otherwise a note points to Rotate
    keys. A change-password flow (add new, remove old) can't work yet: password wraps have no `methodId`, and
    restapi's remove without `methodId` is ambiguous (400) once two exist.
  - **Encryption: rotation** no longer uses react-shared's `rewrapPrivateKeysUnderNewMasterKey()`. It only
    re-wraps the session's imported active keys, so `rekey()` would silently drop inactive keys. Instead, the local
    `rewrapVaultPrivateKeys()` fetches a fresh `getKeyVault()` and opens EVERY `wrappedKeys` entry with the current
    MK (AAD purpose by `useType`). If any entry fails to open, rotation is refused (`UncoveredVaultKeysError`,
    message names the fingerprints) and nothing is written. Otherwise it re-seals each entry under
    `generateMasterKey()` and zeroes the plaintext. `keys` comes from a fresh `getMailbox()`, which also feeds
    `unlockWithPassword()` and `refreshedKeys`. Whether to re-wrap escrow is decided from the fresh vault.
  - **Encryption: escrow after rotation.** A failed re-wrap sets `escrowRewrapFailed`, which keeps "Add escrow
    protection" visible (with "no longer covers them" copy) even though the stale escrow wrap is still on file.
    restapi's `rekey()` preserves that wrap verbatim. A successful add clears the flag.
  - **Encryption: recovery regeneration** re-fetches the vault and checks capacity against `MAX_MASTER_KEY_WRAPS`
    (20, mirrored from restapi, escrow counts). If `new - (free + oldRecovery) > 0`, nothing is written and the
    error says how many other methods to remove. When the new set only fits after removing old codes, an old code
    is removed just before each add that has no free slot, so working codes never drop below the original count.
    The partial-failure copy says how many old codes were already removed.
  - **Encryption: keys at action time.** Every write handler calls `currentUnlockedKeys()`, which uses
    `getUnlockedKeys()` unless the object is missing or `destroyed`, and otherwise falls back to
    `useUnlockPrompt().requestUnlock()` (AppShell mounts the provider). `KeysLockedError` maps to "were locked before
    this could finish. Unlock them and try again." The page no longer reads keys at render time.
  - **Encryption: owner-only.** The page passes `userUid` and `impersonating` to `EncryptionGate`, and
    `isOwner = ownerUserUid === userUid && !impersonating` feeds `KeyEnrollmentGate canProvision` and
    `canManageKeys`. Non-owners get a notice and no Remove, add password, regenerate, rotate, enable signing ("Not
    enabled.") or add escrow. Session timeout, index size and "Destroy keys" stay.
  - **Privacy**: export, import and erasure all resolve "own mailbox" server-side (import ignores `mailboxUid`
    unless trusted). All three render only when the caller owns **exactly one** mailbox and it's the one selected.
    Otherwise the notice says to switch, or that more than one is owned, or that none is.
  - **Inbox load-more**: a failure sets `loadMoreError` and shows it in the sentinel with a Retry button, and it is
    never auto-retried (the observer ignores reports while an error is showing). The continuation effect keys on
    `appendedPageCount`, bumped only when a page added unseen rows. `loadingMore` isn't used as the key because a
    fast response can flip it true and back before React renders, so the effect never re-ran (seen in jsdom). The
    effect only continues if the sentinel's `getBoundingClientRect()` is within 200px of the scroll container. A
    synchronous `loadMoreInFlightRef` replaces the `loadingMore` guard, so two same-tick calls issue one request.
  - **Inbox lock race**: `lockGenerationRef` is bumped on a "locked" event, and both the auto-decrypt effect and
    `handleUnlockList()` drop results if it changed while decrypting.
  - **Search all mail** is stored as the `mailboxUid/folderUid/query` key it was requested for. It's derived in
    the same render, so a new query never runs once with the old unbounded window.
  - **`listAllPages()`** now returns `{items, truncated}` (truncated = stopped at `maxPages` with a full last page).
    Contacts (main and Deleted views separately) and tasks (not the Flagged view) show "only the first 20000 are
    listed". Their tests wrap the real module via `vi.mock(importOriginal)` with a `truncateNextLists` queue.
  - **Test gotchas**: the encryption test's `masterKey.js` mock must export `KeysLockedError`, `openWithKey` and
    `generateMasterKey`. `mockShell` now serves `/api/mail/mailboxes/mb1` as the object (rotation calls
    `getMailbox`), and `mailboxRoutes(mb)` covers both routes for per-test mailboxes. `expect.any(Uint8Array)` fails
    for `TextEncoder` output in jsdom (cross-realm), so use `expect.anything()`.
- **2026-09-14 — Round-4 review fixes, W2 (compose, message pane, calendar, AppShell/MailShell/KeyEnrollmentGate).** Not
  committed.
  - **All-day series west of UTC**: react-shared now expands all-day series in UTC and moves all-day drags by UTC
    date, so the month grid (`occursOnDay` on local grid days vs UTC date keys) needed no change. The one UI bug
    left was the recurrence "Ends on" date: stored as the end of the *local* day, which west of UTC is already the
    next UTC day and added one more occurrence. `allDay.ts` `recurrenceUntilInstant(key, allDay)` /
    `recurrenceUntilDateKey(until, allDay)`: all-day = `YYYY-MM-DDT23:59:59.999Z` (read back by rounding to the
    next UTC midnight, so old local-end-of-day values show the intended date); timed = end of local day as before.
    `RecurrenceEditor` takes `allDay`; toggling All day in `EventModal` re-stores the same chosen date in the new
    frame. Tests in `EventModal.round4`/`MonthView.round4` set `process.env.TZ = "America/New_York"` at runtime
    (works in Node, restore in `afterEach`).
  - **EventModal series edits**: `toSeriesFields` compares start/end rounded to the minute (stored `...:00Z` vs the
    form's `.000Z` never matched, so every series save refetched and rewrote dates). Time-of-day deltas are read on
    the event's own timezone wall clock (`toEventWallClock`/`fromEventWallClock` from react-shared `recurrence.js`),
    normalized to the smallest signed change modulo 24h (19:00 -> 21:00 NY is +2h even across UTC midnight), and the
    master's new start is converted back from its wall clock (DST-safe). Timed->all-day takes the master's date on
    the event's wall clock. `saveEventSeries()` now GETs the master, PUTs, lists the folder and re-points detached
    occurrences - **test mocks must answer `/api/mail/calendar-events?...` with an array**, else it reports
    `detachedOccurrenceSyncFailed`, which the modal now shows as a "Series saved" notice (OK -> `onSaved`).
  - **Organizer aliases**: new `organizerAliases` prop; defaults to the `mailboxOptions` entry for `mailboxUid`'s
    `aliasAddresses`. Organizer/isOrganizer-attendee/`canRespond` lookups match primary + aliases case-insensitively.
    **Follow-up for W1**: `apps/www/calendar/index.tsx` could pass `organizerAliases={modalMailbox.aliasAddresses}`
    so a view-only (not in `mailboxOptions`) mailbox's aliases count too.
  - **RecurrenceEditor**: the last ticked weekday of a weekly rule can't be unticked (rrule would go daily).
  - **KeyEnrollmentGate `canProvision` now defaults to `false`**; MailShell passes `!impersonating && owner`. Tests
    that expect setup must pass `canProvision`.
  - **ComposeWindow**:
    - Close / Discard (header, minimized bar, trash, discard-modal button) are disabled while `sending`.
    - Discovery: an effect looks up every current To/Cc/Bcc recipient once `mailbox` + `encryptionPolicy` load
      (reply prefills, and blurs that happened before they loaded); in-flight lookups are deduped
      (`lookupsInFlightRef`) and dropped after a From switch (`discoveryGenerationRef`).
    - `autosaveSuppressed` = `encryptRequested`, or - when encryption is possible at all (unlocked encryption key,
      enrolled encryption key, or offered earlier) - policy missing, any current recipient without a status yet
      (pending or never looked up), or `decideMessageEncryption(current).autoEncrypt`. Autosave also waits for
      `cryptoContextReady`.
    - `assembleForSend` enters the encryption decision when the mailbox has an enrolled encryption key even if this
      session never unlocked it (auto-encrypt then blocks with `KEYS_LOCKED_ENCRYPT_MESSAGE` + unlock prompt). Keys
      are re-read after the lookup await (`readKeys()`, `destroyed` counts as locked) and the Sign check repeats.
    - Superseded drafts (From switch) are deleted via `deleteSupersededDraft`: awaits the in-flight save, uses its
      version (the object is already spliced out of `supersededDraftsRef`, so the save can't update it), and on
      failure retries once with `getMessage()`'s version.
    - Leaving: `beforeunload` starts the pending save and asks to confirm while an edit is pending or a save is
      "saving" (not after finish/while sending). No `fetch keepalive` - react-shared's `assembleDraft` can't pass it.
    - Sign-out flush: `compose/composeFlushRegistry.ts` (module-level, since AppShell renders the ComposeProvider)
      - each window registers `flushPendingSave`; `AppShell.handleSignOut` does `destroyUnlockedKeys()`, then
      `await flushComposeDrafts(LOGOUT_TIMEOUT_MS)`, then indexes + logout.
    - Remaining uncovered branch besides the known `e.target.files ?? []`: `value={mailboxUid ?? ""}` on the From
      select (From only renders with >1 option, by which time `mailboxUid` is set) - ComposeWindow is 99.41% branches.
  - **MessageDetailPane**: passes the viewing mailbox's primary address as `readerAddress` and, while
    `notAddressedToReader` stays true, re-evaluates with each alias (the API takes one address); shows an
    informational `role=status` "don't include this mailbox" notice. `header_mismatch` text mentions repeated
    From/To/Cc/Sender headers. The raw byte string is only handed to `evaluateMessageSecurity()`.
- **2026-09-14 — Round-5 review fixes, W-A (encryption settings, KeyEnrollmentGate, lists, sign-out, status badges).**
  Not committed. All ten findings done, plus the follow-ups from the react-shared f6c8989/f853222 and restapi part B
  contract changes.
  - **Rotation vs a pending signing enrollment** (`settings/encryption`): the started enrollment id is kept in
    `localStorage` (`rapidmx.signEnrollment.<mailboxUid>`) only so a reload can ask the server
    (`checkSignEnrollmentStatus`) about it; `signingStatus` gains `"checking"`. Rotation (inputs, button, and the
    submit handler itself) and "Enable digital signatures" are disabled unless `signingStatus === "idle"`. Reload
    check: pending -> resume polling; issued/failed -> clear storage (issued refetches keys, a refetch failure is
    ignored); 404 -> clear; any other error -> assume pending and keep polling. A 409 from `rekey` shows
    `ROTATION_CONFLICT_MESSAGE` (mentions an enrollment possibly started on another device). There is no server
    endpoint listing pending enrollments, so a pending enrollment started on another device is only caught by
    restapi's 409.
  - **Escrow and rotation** (after restapi part B, react-shared f853222): `rekey()` drops old escrow wraps and 409s an
    escrowed mailbox's rekey without a replacement. `handleRotateKeys` builds `buildEscrowWrap(newMk, ...)` BEFORE
    `rekey` and sends it in `masterKeyWraps` whenever the freshly fetched mailbox has `escrowScopeId` (not "the vault
    had an escrow wrap": restapi checks the assignment, and a mailbox taken out of escrow has no scope to wrap for).
    Failing to build it aborts with "Your keys were not rotated: this mailbox is under escrow..." and no rekey. The
    post-rekey `addMasterKeyWrap` re-add, `escrowRewrapFailed` and the interim `createdAt` staleness heuristic are
    gone; coverage is simply "an escrow wrap exists" (pre-release, no legacy vaults).
  - **Cancel enrollment**: while `signingStatus === "pending"` with a known id, "Cancel enrollment" sits under the
    disabled rotation (`cancelSignEnrollment`). Result failed (= cancelled) or 404 -> clear storage, idle, no error;
    issued -> finishes like a poll; still pending -> "couldn't be cancelled yet"; other errors shown. A rekey 409 for
    an enrollment from another device keeps `ROTATION_CONFLICT_MESSAGE`.
  - **Recovery code regeneration**: if an old code was removed to make room and the new add then fails, the removed
    wrap (still in memory) is re-added; `removedEarly` is decremented only when that succeeds.
  - **KeyEnrollmentGate**: `handleSetPassword` re-fetches the vault right before provisioning; any wrapped keys or
    wraps -> new `"already_set_up"` screen ("set up in another tab or device", Reload button). `enrollKey`'s
    `VaultAlreadyInitializedError` goes to the same screen; any other 409 is an ordinary error. A failing re-fetch
    shows its error on the password step.
  - **Unlock errors** (`UnlockPromptProvider`, which also exports `unlockErrorMessage()`/`UnopenableKeysNotice` for
    `KeyEnrollmentGate`): `UnopenableEncryptionKeyError` -> "Your password is correct, but one of your keys couldn't be
    opened... contact support." instead of "Incorrect password."; a non-empty `UnlockResult.unopenableKeys` shows a
    fixed, dismissible `role=status` notice listing the fingerprints. **Tests that mock `unlockWithPassword` through
    the provider/gate must resolve `{ unopenableKeys: [] }`** (index.test was updated). The encryption page's
    post-rotation re-unlock ignores the result (rotation already refuses keys it can't open).
  - **Console sign-out**: `signOutOfConsole()` writes `["*"]` to `CONSOLE_PENDING_DELETIONS_KEY` (must equal
    `PENDING_DELETIONS_KEY`; test checks) before broadcasting. `AppShell`'s cross-tab listener now sets
    `signingOutRef` first (it hears `destroyAllLocalIndexes()`'s own re-broadcast), destroys keys, awaits
    `destroyAllLocalIndexes()`, then navigates. Both `handleSignOut` and that listener call `markSigningOut()`
    (composeFlushRegistry) first, so compose windows skip "Leave site?". `signOut.ts` doesn't: the admin/escrow
    consoles never render compose windows.
  - **Inbox load-more stall**: `notePageLanded(addedRows, moreRemain)` also bumps `appendedPageCount` for a full page
    that added nothing, up to `MAX_EMPTY_PAGE_CONTINUATIONS` (3) in a row; after that `loadMoreStalled` shows a
    "Load more" button in the sentinel. Both the plain listing and search paths use it; a new run resets it. The
    old "doesn't continue after a repeated page" tests were changed to the new behavior.
  - **Contacts Deleted view**: hidden unless the caller owns the mailbox or `getMyMailboxAccess()` says
    `canDelete && canUpdate` (a failed check hides it). `ContactsSidebar` has `showDeleted` (default `true`).
    Mailbox switching is a full page load, so no reset-on-switch logic.
  - **Outbox without a schedule** (`MessageDetailPane`): "Move to Drafts" (same `cancelScheduledSend` call) shows
    when `isOutbox && !scheduledSendTime && draftsFolderUid`; its non-API failure text is "Could not move this
    message to Drafts.".
  - **Status badges** (privacy, admin data-requests, escrow matter exports): `IN_PROGRESS_STATUSES` = pending,
    processing, in_progress -> neutral badge; labels render `_` as a space. Download links were already gated on
    `ready`.
    `scheduledSendError` shows as an Alert on an Outbox message.
  - **Message security (react-shared f6c8989+)**, `MessageDetailPane`:
    - Pins: new `mail/pinnedSigners.ts` `getPinnedSignerFingerprints(mailboxUid, address)` - the reading mailbox's
      contacts folders (`listFolders` type `contacts`, paged 500 x 20), `pinnedSigningFingerprintsFor()`, contacts
      cached per mailbox for 60s (failures not cached; `clearPinnedSignerCache()` in tests - a never-settling fetch in
      one test otherwise stalls the next). Plus the mailbox's own `signingKeyFingerprints(keys)` when the sender is one
      of its addresses. A failed lookup = no pins; `undefined` is passed when there are none.
    - `signed_unverified_signer`/`encrypted_unverified_signer`: amber "signer not verified" badge (never green) plus
      a `role=status` notice with the certificate's emails and fingerprint. No "trust this signer" (no client pin API).
    - Verified states show `protectedHeaders.subject` as the heading when present; `signed_verified` with a different
      outer Subject gets a notice (Subject is not compared in verification, list tags).
    - Attachments: verified states, `encrypted`, and `encrypted_unverified_signer` with `result.attachments` list
      only those (download via `decode()` into an `application/octet-stream` blob, never rendered in-origin);
      otherwise the server list. New tests are in `MessageDetailPane.round5.test.tsx`.
  - **Display names**: no form in W-A's files edits a mailbox display name; the only one is the admin
    `MailboxCreateForm` (not W-A's).
- **2026-09-14 — Round-5 review fixes, W-B (compose drafts, recurrence editor, all-day series end dates).** Not committed.
  - **ComposeWindow saves**: `saveDraftNow()` chains on `saveInFlightRef` and reads `latestRef` only when it runs
    (skips the request when the previous save already stored that exact content). `assembleDraft` carries no
    version - the 409 came from two server-side assemblies racing, so serializing is the fix. Resolves to the saved
    message or `undefined`; `saveErrorRef` holds the failure text.
  - **Close** closes only after its save succeeds (`closing` disables Close/Discard/Send meanwhile). A failed save,
    or no draft/body yet, opens the "Couldn't save this draft" modal (Discard / Keep editing). The modal state is
    `closePrompt: { title, message, retry? }` (was `discardPrompt: string`). Close prompt order: encryption decided
    (`ENCRYPTED_CLOSE_MESSAGE`), settings unavailable (`CRYPTO_UNAVAILABLE_MESSAGE` + Retry), still undetermined
    (`CHECKING_CLOSE_MESSAGE`; also starts lookups for never-blurred recipients).
  - **Discard**: `deleteDraft()` uses max(draft version, in-flight save's version), retries once via `getMessage()` on
    404/409, and treats a GET 404 as already deleted. Discarding content waits for the delete; a failure keeps the
    window open with "Couldn't discard this draft: ...". A blank window still closes at once and deletes in the
    background (otherwise a server outage leaves it impossible to close). Uploads (files and inline images) call
    `refreshDraftVersion()` because restapi bumps the version on upload.
  - **Crypto context**: mailbox + policy load retries with backoff (`cryptoRetryDelaysMs`, default 1/2/4/8s; each
    retry only fetches what's missing), then waits for manual Retry (`cryptoRetryToken`). `cryptoContextReady` still
    flips after the first attempt so Send works. `autosaveSuppressed = encryptionDecided || encryptionUndetermined`,
    where undetermined = not ready, **no mailbox** (its keys decide whether encryption is possible), or (encryption
    possible and (no policy or any recipient status missing)). `cryptoCheckUnavailable` shows an in-window alert
    with Retry. **Test mocks:** `mockCompose` now answers `/api/mail/mailboxes/mb1` with a keyless mailbox, and
    `mockTwoMailboxes` answers both mailboxes; without that, autosave never fires.
  - **Leaving**: beforeunload asks whenever anything is unsaved (pending, saving, or content != last saved,
    including encrypted content never saved as a draft), and never when `isSigningOut()`. `flushPendingSave()`
    resolves to a boolean and shows the save-failed modal when the last save failed. `flushComposeDrafts()` now
    resolves `true` only if every flush resolved non-`false` before the timeout. `ComposeFlush` stays
    `() => Promise<unknown>` so AppShell's test (a void flush) still type-checks.
  - **composeFlushRegistry**: `markSigningOut()` / `clearSigningOut()` / `isSigningOut()`. **Coordinator wiring:**
    AppShell's `handleSignOut` and its BroadcastChannel sign-out listener (and admin `signOut.ts` if it can run
    with compose open) should call `markSigningOut()` before flushing and navigating.
  - **RecurrenceEditor**: new `startWeekday` prop (EventModal passes `startWeekdayCode(start, allDay, timezone)` from
    `allDay.ts`: the UTC date for all-day events, the event's timezone wall clock otherwise). Enabling Repeats and
    switching to Weekly seed `[startWeekday]` (default MO). Switching to any other frequency sets `byDay: undefined`,
    because react-shared passes byweekday for every freq. Existing weekly rules load and edit untouched.
  - **All-day "Ends on"** (`recurrenceUntilDateKey`): explicit `T23:59:59.999Z` and bare UTC midnight
    (`T00:00:00(.000)Z`, the oldest form) return their date part. Anything else is a legacy creator-local end of
    day, read on the **local** calendar. The reviewer suggested "round to nearest UTC midnight, no -1", but that is
    wrong west of UTC (New York gives the next day). No UTC-only rule works: legacy values span 26 hours, and
    UTC+14 and UTC-10 values for the same date are exactly 24h apart. The local read is exact whenever the viewer
    is in the creator's zone. Tested in Tongatapu, Kiritimati, New York and Honolulu.
- **2026-09-14 — Round-6 review fixes, W-B (compose plaintext leaks, Discard of sent mail, encryption settings vs a
  rotation elsewhere).** Not committed. All seven findings fixed.
  - **Queued saves** (`saveDraftNow`): the re-check happens when the save actually runs (after the previous save
    settles). `latestRef` now also carries `autosaveSuppressed`/`encryptionDecided`; a save runs only if none of
    suppressed, `sendingRef`, `finishedRef` holds. Otherwise it resolves `{ skipped: true, message: <previous save's
    result> }` (the chain keeps the previous version for a later delete). `saveDraftNow()` now resolves
    `{ message?, skipped? }`; `saveInFlightRef` is still `Promise<Message | undefined>` (initialised to a resolved
    promise, not null). Close with a skipped save shows `ENCRYPTED_CLOSE_MESSAGE` or `CHECKING_CLOSE_MESSAGE`;
    Sign Out's flush returns `finishedRef.current` for a skip, with no save-failed prompt.
  - **No recipients yet**: `awaitingRecipients` = encryption possible + policy loaded + no recipients + some tier
    `"automatic"` (`policyCanAutoEncrypt`; the own `mutual` preference is deliberately not consulted). It counts as
    undetermined; Close says `NO_RECIPIENTS_CLOSE_MESSAGE`. A policy with no automatic tier, or a keyless mailbox,
    still autosaves with no recipients. **Test gotcha:** a mailbox with `keys: [encryptKey]` under `automaticPolicy`
    no longer autosaves a recipient-less window; give it `initialTo` (the round-5 retry tests now do).
  - **Failed lookups** store no status. `noteLookupFailed` retries after `cryptoRetryDelaysMs[n]` via
    `lookupRetryToken` (the discovery effect depends on it), then marks the address in `exhaustedLookups`, which feeds
    `cryptoCheckUnavailable` (in-window "couldn't be checked" + Retry; `retryCryptoContext` also clears lookup
    failures). Timers are cleared on unmount; a From switch resets both. At send, a failed lookup (no longer
    `.catch(() => undefined)`) blocks with `LOOKUP_UNAVAILABLE_MESSAGE` when Encrypt is on or policy can auto-encrypt;
    otherwise it's resolved as no key as before. The old "treats a failed key-lookup the same as no keys found" test
    was replaced.
  - **Mailbox not loaded at send**: `assembleForSend` blocks with `POLICY_UNAVAILABLE_MESSAGE` whenever `!mailbox` and
    not `forcePlaintext`, before the encryption branch (which now only checks the policy). "Send without encryption"
    still works.
  - **Discard / superseded delete**: the 404/409 retry only deletes the re-read copy if `isStillDraft(fresh, folderUid)`
    (same folder, no `scheduledSendTime`/`scheduledSendLeaseExpiresAt`/`scheduledSendRelayedAt`). Otherwise Discard
    fails with `NO_LONGER_A_DRAFT_MESSAGE` (window stays open) and the superseded delete gives up silently.
  - **Signed/encrypted From**: the display name is left out when it matches `/[@＠﹫\r\n]/` (mirrors restapi's
    `safeFromDisplayName` + look-alike rule).
  - ComposeWindow coverage: 100/99.57/100/100; only the two known branches (`e.target.files ?? []`,
    `value={mailboxUid ?? ""}`) remain.
  - **Settings > Encryption, stale session master key**: `masterKeyOpensVault(mailboxUid, mk, vault)` opens wrapped
    keys until one succeeds (bytes zeroed; `KeysLockedError` propagates; an empty `wrappedKeys` passes, since there's
    nothing to check). `verifiedUnlockedKeys()` = `currentUnlockedKeys()` + a fresh `getKeyVault()` + that check,
    used by add password, regenerate recovery codes (reuses its fresh vault), add escrow and enable signatures.
    Rotation runs the same check on its own fresh vault before `rewrapVaultPrivateKeys`, so a key that opens nothing
    is reported as stale, not as N unopenable keys. `StaleSessionKeysError` -> `errorMessage()` calls
    `relockStaleKeys()` (`destroyUnlockedKeys`, `destroyLocalIndex`, `requestUnlock` with a swallowed rejection) and
    shows `STALE_KEYS_MESSAGE`. There's no passkey-add flow on this page. Still a check-then-write race until restapi's
    `expectedMasterKeyGeneration` lands (not used yet). **Test gotcha:** the encryption test file's `beforeEach` now
    defaults `openWithKey` to resolve; a test that makes every open fail now gets the stale path.
  - **Rotation and escrow**: the escrow wrap is built only when the **fresh vault already has an escrow wrap** (not
    `mailbox.escrowScopeId`). `getEscrowInfo` 404 = scope gone -> rotate without one; any other error ->
    `EscrowWrapUnavailableError` (abort). `ROTATION_CONFLICT_MESSAGE` now also mentions escrow changing meanwhile.
- **2026-09-14 — Round-6 review fixes, W-A (message display, contacts, admin).** Not committed. All eight web-client
  findings fixed, none skipped. Nothing here depends on the round-6 react-shared changes (keySession WeakRef,
  `expectedMasterKeyGeneration`); everything used (`extractAddresses`, `getMessage`, `scheduledSendLeaseExpiresAt`,
  `Contact.deleted`) was already in the patched 0.4.0 dist.
  - **From next to a signature badge** (`MessageDetailPane`): for every state except `unprotected`/`encrypted`, the From
    line is `Name <address>`, where address = first `extractAddresses(protectedHeaders.from)` else `message.from.address`.
    New exported `checkSenderName(displayName, address)`: `looksLikeAddress` = name has `@`/`＠`/`﹫` (restapi's
    `AT_SIGN_LIKE`); `misleading` = the NFKC-folded name contains an `x@y` token that isn't the address. Any message
    whose name looks like an address shows the address too, and a misleading one gets a `role=status` warning
    ("looks like an email address, but this message was sent from ..."). The receipt banner uses the same label.
  - **Unsigned headers**: a verified state with no `protectedHeaders` shows "The signature covers this message's content
    and attachments only. Its Subject, To and Cc weren't signed...". **Test gotcha:** a `signed_verified` mock with no
    `protectedHeaders` now renders an extra `role=status`.
  - **Attachments**: `signature_failed` with `result.attachments` (only a decrypted message has them) lists those, with
    a warning when non-empty.
  - **Send lease**: `sendInProgress` = in Outbox and `Date.parse(scheduledSendLeaseExpiresAt) > nowMs` -> "Sending…"
    pill, no Cancel / Move to Drafts / schedule pill. A timer at lease expiry bumps `nowMs` and re-reads via
    `getMessage()`. A 409/403 from Cancel/Move to Drafts also re-reads. The re-read copy is local state (`reloaded`,
    used while its version >= the prop's); `inOutbox` = `isOutbox` and the folder unchanged, so a re-read that finds it
    sent drops the Outbox controls and shows Archive. The re-read is not reported to the caller (no suitable callback;
    `onScheduledSendCanceled` means "moved to Drafts").
  - **Pinned-signer cache**: `pinnedSigners.ts` subscribes to `subscribeKeySession` on first
    `getPinnedSignerFingerprints()` call (module-wide, never removed) and clears on any `locked` event. AppShell's
    `handleSignOut` and cross-tab sign-out listener call `clearPinnedSignerCache()`; so do `ContactForm` after a save,
    contacts `index.tsx` after delete / bulk delete / favorite / add category / import (even partial failures), and
    `contacts/[uid].tsx` after delete. Not done in AppShell via `subscribeKeySession` because MailShell/encryption tests
    mock keySession without it. **Test gotcha:** a real (unmocked) `pinnedSigners` adds one listener to a mocked
    `subscribeKeySession`, so listener-count tests compare against the count while mounted.
  - **Contacts Deleted view**: restapi checks delete+update on the contacts *folder's* ACL, and there is no client API
    for folder access. The mailbox check stays as the first gate; the Deleted load now treats any returned contact
    with `deleted !== true` as "server ignored the filter" -> empty list + "You don't have permission to view deleted
    contacts in this folder." A folder-only grant wider than the mailbox's still hides the view (safe direction).
  - **Distribution lists** (`admin/distribution-lists/[uid].tsx`): no API reports `mail:security:trusted_authserv_id`, so
    static text: a restricted list shows a `role=status` warning that members are recognized only by DKIM, which needs
    the trusted authserv id, else all mail to the list is dropped; an unrestricted one a muted hint. The setting itself
    isn't editable in the UI.
  - **MailboxCreateForm**: display name also rejects `＠`/`﹫`; message is now `A display name can't contain "@" (or a
    look-alike) or line breaks.`
  - New tests: `MessageDetailPane.round6.test.tsx`; additions in `pinnedSigners`, `AppShell`, `contacts/index`,
    `contacts/[uid]`, distribution-lists `[uid]`, `admin/mailboxes/new`. Per-file coverage 100% on MessageDetailPane,
    pinnedSigners, AppShell, contacts pages, ContactForm.
- **2026-09-14 — Recovery-code unlock and "Trust this signer".** Not committed. Uses react-shared aa68672's
  `unlockWithRecoveryCode`, `consumeRecoveryCode`, `replacePasswordWrap`/`PasswordWrapReplaceError`, `trustSigner`/
  `SignerKeyConflictError` and `MessageSecurityResult.signerCertificate` (in the refreshed yarn patch).
  - **Where**: only `UnlockPromptProvider` and `KeyEnrollmentGate` (blocking form) have unlock UIs. Settings > Encryption's
    one `unlockWithPassword()` is the post-rotation re-unlock with the just-set password, not a prompt; the page unlocks
    through the gate/provider, so it inherits the recovery mode. Its "last password wrap isn't removable" comment was
    updated (the rule stays).
  - **New `apps/shared/components/layout/RecoveryCodeUnlock.tsx`**: `startRecoveryUnlock()` reads
    `getKeyVault().masterKeyGeneration` *before* `unlockWithRecoveryCode()` (read failure = no generation), so any rotation
    after that read makes `replacePasswordWrap(..., expectedMasterKeyGeneration)` refuse rather than wrap a dead key.
    `UnlockModeToggle` ("Use a recovery code instead" / "Use your password instead", clears the error).
    `unlockErrorMessage(err, "recovery")` = "That recovery code didn't work." or a recovery-worded unopenable-key message.
  - **Continuation**: both callers settle the unlock first (provider resolves waiters and closes its dialog; gate goes
    `ready` and renders children), then show `RecoveryFollowUpModal`. The provider hides it (`open={!pending}`, state kept)
    while another unlock dialog is up; keyed per follow-up.
  - **Follow-up**: optional "Set a new encryption password" (8+ chars, confirm) with Skip; Skip / Escape / X = consume.
    `remainingRecoveryCodes === 0`: required, explanation, "Keep this code for now" (closes without consuming; Escape
    does the same). Set password: `getUnlockedKeys()` re-read at submit (missing/destroyed -> locked message, no request),
    `replacePasswordWrap`, then `consumeRecoveryCode` (404 = done; other failure or no `recoveryMethodId` -> non-blocking
    warning that the code may still work). Done screen: "N recovery code(s) left", <= 2 links `/settings/encryption`.
    Replace errors: `master_key_rotated` -> Reload page / Close, no consume; `multiple_password_wraps` -> form hidden,
    Skip/Keep still offered; `no_other_unlock_method` and `KeysLockedError` -> Close only; `add_failed` restored / not
    restored -> retryable with different copy; anything else retryable generic (ApiRequestError message appended).
    Modal's own X button is labelled "Close" too - tests use `getByText("Close")` for ours.
  - **Known gap**: Settings > Encryption's vault list is loaded when the gate renders children, so a consume/replace done
    in the follow-up isn't reflected there until reload.
  - **Coverage gotcha**: `const r = mode === "recovery" ? await a() : null; const x = r ?? (await b())` left an `if` right
    after it with a v8 `-1` branch count (reported uncovered though both sides ran). A single
    `await (cond ? a() : b())` fixed it; both callers use that shape.
  - **Trust this signer** (`MessageDetailPane`): the security effect now records `senderUnpinned` = contact pin lookup
    *succeeded* and the combined pins (contacts + own keys) are empty; a failed lookup never offers trust. Button shows for
    `*_unverified_signer` with `signerCertificate` and `senderUnpinned`. Dialog: signer emails ("No email address"),
    `formatFingerprint()` (separators dropped, uppercase, groups of 4; "Unknown" if absent), the address =
    first protected From address else `message.from.address` (same `senderAddress` as the From line), out-of-band advice,
    Trust / Cancel (both disabled and Escape ignored while running). Success: `trustSigner(message.mailboxUid, ...)`,
    `clearPinnedSignerCache()`, close, bump `unlockRefresh` to re-evaluate. `trustSignerErrorMessage()`: 409 conflict /
    400 / 403 copy, otherwise generic; the dialog stays open.
  - Tests: new `RecoveryCodeUnlock.test.tsx`, `MessageDetailPane.trustSigner.test.tsx`; recovery blocks added to
    `UnlockPromptProvider.test.tsx` and `KeyEnrollmentGate.test.tsx` (their keySession/keyvaultApi/masterKeyWraps mocks
    gained `unlockWithRecoveryCode`/`getKeyVault`/`consumeRecoveryCode`). Per-file 100% on all four sources. Full run:
    151 files / 2172 tests, 100 / 99.96 / 100 / 100 (only ComposeWindow's two known branches).
- **2026-09-15 — Key rotation continuity (key-change UI).** Not committed. Uses react-shared 24f3e21/b0f5106
  (`Contact.keyConflicts`/`previousKeys`, `resolveKeyConflict`/`PinnedKeyChangedError`, `signerKeyStateFor`,
  `signer_key_changed`) and restapi 8e6e72f's `POST /mail/mailboxes/:id/keys/resolve`.
  - **Shared pieces** (`apps/shared/components/contacts/`): `contactKeys.ts` (error copy for 409/400/403/404/other,
    `groupFingerprint`, `sameFingerprint`, `revocationLabel` superseded vs revoked, `keyPinnedSince`) and
    `KeyChangeReview.tsx` (current vs new key, advice, Accept new key behind a confirmation dialog, Keep current key
    without one). A 409 is handed to the caller (`onPinnedKeyChanged`), which shows `KEY_CHANGE_STALE_MESSAGE` itself,
    because the reload usually remounts the review. A 403 hides the actions for that review; `canResolve={false}` hides
    them up front.
  - **First seen** for a pinned key = newest `previousKeys` `replacedAt` of that use, else `keysFirstSeen` (restapi sends
    it; react-shared's `Contact` type lacks it, so it's read through a local type), else `notBefore`.
  - **pinnedSigners.ts**: `getSignerKeyState(mailboxUid, address)` reuses the cached contacts: `signerKeyStateFor()` +
    `contactUid` (holder of `pinned[0]`, found by object identity, else a contact with a sign conflict, else the first
    match) + `pinnedSince`. **Test gotcha:** every test that mocks `pinnedSigners.js` for a MessageDetailPane must now
    also provide `getSignerKeyState` (round5/round6/trustSigner mocks resolve `{ pinned: [], previous: [] }`).
  - **MessageDetailPane**: after evaluating, `signer_key_changed` loads the key state and `getMyMailboxAccess().canUpdate`
    (a failed check = unknown, actions shown); an unverified signer with no pins loads the key state only. The notice
    replaces the generic failure text; `expectedPinnedFingerprint` = `pinned[0]` (restapi compares the first sign key of
    the contact it finds); accept sends `signerCertificate`. Keep current key only when the recorded conflict's
    fingerprint equals `signerFingerprint`. Success or 409: `clearPinnedSignerCache()` + bump `unlockRefresh`; the
    reject and 409 notices live in pane state so they survive the re-evaluation. No pinned contact key (e.g. own
    mailbox's keys, or a failed lookup) = comparison without actions. An unpinned signer with a sign conflict gets a
    "Review it in Contacts" link to `/contacts/<uid>` instead of Trust this signer; a failed key-state load keeps Trust.
  - **ContactDetailPane**: one review per `keyConflicts` entry (accept without `certificate`; address = first email, so
    no email = no actions), key history list, `(superseded)` muted vs `(revoked)` danger. New props `onKeysChanged`
    (index: `reload()`; `[uid]`: `getContact()` again, keeping the old contact on failure) and `canResolveKeys` (index:
    owner, else the delegate's `canUpdate`, `undefined` while unknown). The old "no automatic way" copy is gone.
  - **Retained encryption keys**: nothing in web-client assumes one encryption key for decryption - every decrypt path
    (`MessageDetailPane`, `www/index.tsx`, `localIndexBuilder`) passes the whole `UnlockedKeys`; ComposeWindow only uses
    the active key to encrypt to itself, which is correct.
  - **Flake seen**: `contacts/index.test.tsx` "toolbar Import does nothing when the mailbox has no contacts folder yet"
    failed once in a 12-file coverage batch (fetch count 4 vs 2: the contact-list/folder fetches land after
    `findByText`); passes alone and in the full run. Not related to this change.
  - Tests: new `KeyChangeReview.test.tsx`, `contactKeys.test.ts`, `MessageDetailPane.keyChange.test.tsx`; additions in
    `pinnedSigners`, `ContactDetailPane`, contacts `index`/`[uid]`, settings encryption. Per-file 100% on all eight
    touched sources. Full run: 154 files / 2231 tests, 100 / 99.96 / 100 / 100.

### 2026-09-15 — Verification seals (react-shared 8863c72)

- **Pane** (`MessageDetailPane.tsx`): with unlocked keys *and* a readable vault generation, evaluates with
  `evaluateMessageSecurityWithSeal()` (seal/sealGeneration from `currentVerificationSeal()`, `signerKeys` =
  `getSignerKeyState()` pinned + previous + the mailbox's own `keys` for mail from its own address). Otherwise (no keys,
  vault read failed, or no non-negative integer `masterKeyGeneration`) plain `evaluateMessageSecurity()` exactly as
  before, so the older test files' `mockFetch` "{}" vault keeps them on the old path. A throw from the seal path (only a
  lock) falls back to evaluating with no keys. The alias `notAddressedToReader` re-checks stay plain. The key state
  loaded for `signerKeys` is reused for the key-change notice (one `getSignerKeyState()` call per evaluation).
- **`verified_at_first_open` UI**: muted pill with a check ("Verified when first opened"); amber pill with a warning icon
  and amber detail line when `laterCompromised`; detail text by `liveSignatureFailureReason` (`verifiedAtFirstOpenMessage()`).
  Treated like verified for the protected Subject, inner attachments and the "Subject/To/Cc weren't signed" note; never in
  `VERIFIED_STATES`. The key-change notice (`signerKeyChanged()` also reads `liveSignatureFailureReason`) still shows, minus
  "so it isn't verified".
- **`verificationSeals.ts`** (new, `apps/shared/components/mail/`): vault generation cache (60 s TTL, unavailable not
  cached, cleared on any lock); `sendVerificationSeal()` never rejects and sends once per `messageUid:generation` per page
  session — a seal embeds `verifiedAt`, so deduping by seal string would re-send on every open and draw 409s. 400/403/404/409
  are final, anything else lets a later evaluation retry (no loop). Successful seals are remembered and preferred over an
  older list copy's seal.
- **Index builder**: `createPassSealer()` per pass — vault generation read once, pins memoized per sender (lowercased),
  seal evaluation only for messages without a current-generation seal and not already attempted; writes queued with
  `SEAL_WRITE_CONCURRENCY` 2 and `MAX_SEAL_WRITES_PER_PASS` 200 (past the cap, plain evaluation), queue dropped when the
  pass is aborted or `unlocked.destroyed`; `drain()` runs in the pass's `finally` after `setLocalIndexBuilding(false)`.
  Signed-only mail isn't sealed by the builder (it never fetches unencrypted raw MIME; sealed when opened). A seal PUT
  likely bumps the message `version`, so the next pass re-indexes that message once (then it has a current seal).
  `localIndexBuilder.test.ts` now mocks `getKeyVault` to reject so it stays seal-free.
- Tests: `MessageDetailPane.verificationSeal.test.tsx`, `verificationSeals.test.ts`, `localIndexBuilder.seal.test.ts`.
  100/100/100/100 on the three sources. The known `contacts/index.test.tsx` "toolbar Import ... no contacts folder" flake
  failed in the first full run, and `index.test.tsx` "resets \"Search all mail\" when the query changes" (expected
  a fetch count > 0) in the second; each passes alone, neither touches these files. Full run: 157 files / 2266 tests,
  100 / 99.96 (the two known branch gaps) / 100 / 100.

### 2026-09-15 — Plugin navigation in the shells (booking-as-plugin plan, phase 4)

- **Contract** (`apps/shared/plugins/pluginNav.ts`, new): local structural `PluginUiNavItem {id,label,href}`,
  `PluginNav {settingsSections?, adminNav?, appRail?}` and `PluginNavProps {pluginNav?}` - deliberately *not* imported
  from restapi (web-client doesn't depend on it). `mergePluginNavItems(core, plugin, toItem, reservedIds)` appends after
  core, skipping malformed items, non-same-origin hrefs (`isSafePluginHref`: `/` but not `//` or `/\`), and ids taken by
  core, `reservedIds` or an earlier plugin item (first wins). Returns the core array itself when there are no plugin items.
- **Shells:** `AppShellProps` and `AdminShellProps` extend `PluginNavProps`; the core-plus-plugin lists come from
  `appRailItems()` (reserves `"settings"`), `settingsSections()` and `adminNavItems()` (reserves the off-rail
  `quarantine`/`ingestQueue`/`setup` ids so their header labels can't be hijacked). Plugin items get
  `HiOutlinePuzzlePiece`. Active state is id matching, same as core: a plugin page passes its manifest nav id as
  `active`, so `AppShellActive`/`AdminShellActive` are `core | (string & {})` and `SettingsSectionId` is `string`.
  `ACTIVE_LABELS` is gone - the header label is `"Settings"` or the merged rail item's label (empty for an unknown id).
- **SettingsShell mailbox switcher:** used `SETTINGS_SECTIONS.find(...)!`; a plugin page rendered without its nav item
  (server didn't send it) would have thrown, so it now falls back to `window.location.pathname`.
- **Threading:** every www/admin page already spreads its props onto its shell and types them as
  `Omit<XShellProps, "active">`, so no page changed. `MailShell`/`CalendarShell`/`ContactsShell`/`TasksShell`/`SettingsShell`
  destructure their props and now forward `pluginNav` to `AppShell`. Escrow pages are untouched.
- **Declarations:** `tsconfig.json` `declaration: true`. `dist/` had no `.d.ts`, so a TypeScript plugin page importing
  `@rapidmx/web-client/.../SettingsShell.js` would get TS7016. The `"./*.js"` export has no `types` condition, but TS
  finds the sibling `dist/apps/*.d.ts` - verified from a scratch consumer under both `Bundler` and `NodeNext` resolution
  (a wrong `active` type errors, so the types are real). Declaration emit was clean with no source changes.
- **Docs:** new `README.md` (the repo had none) with the package layout and the plugin UI surface.
- **Booking:** the core `booking-types` settings entry stays until phase 6; a booking plugin sending the same id is
  skipped as a collision meanwhile, which is harmless (same href).
- Tests: `test/apps/_plugins/pluginNav.test.ts`; plugin-nav blocks in `AppShell`/`SettingsShell`/`AdminShell` tests
  (ordering, collision, active state, header label, absence, switcher fallback); pass-through tests in the Mail/Calendar/
  Contacts/Tasks shell tests and the auto-reply, admin branding and tasks page tests. `tsconfig.test.json` still reports its
  43 pre-existing errors (same count before and after). Full run: 158 files / 2288 tests, 100 / 99.96 (the two known
  branch gaps) / 100 / 100; tsc and lint clean.

### 2026-09-15 — Removed the booking links UI (moved to `@rapidmx/booking-plugin`, plan phase 6)

Not committed. The Calendly-style booking feature leaves core as `@rapidmx/booking-plugin` (new `D:/github/rapidmx/booking`
repo, created from this repo at efe108c, which takes the pages, `AvailabilityEditor` and their tests).

- **Removed:** `apps/www/settings/booking-types/**` (`index`, `[uid]`, `new/index`), `apps/shared/components/booking/
  AvailabilityEditor.tsx`, `test/apps/settings/booking-types/**` (incl. `[uid].ssr`), `test/apps/_components/
  AvailabilityEditor.test.tsx`, and the `booking-types` entry in `SettingsShell`'s `SETTINGS_SECTIONS`.
- **Plugin nav:** the plugin contributes `{ id: "booking-types", label: "Booking Links", href: "/settings/booking-types" }`
  through `pluginNav.settingsSections`. Before this change it collided with the core id and was skipped; now it is
  appended after Privacy & Data. `settingsSections()` passes no `reservedIds` and `booking-types` was never reserved in
  `appRailItems()`/`adminNavItems()`, so nothing else needed changing - the collision rule (core and reserved ids win,
  first plugin item wins) still fits. New `SettingsShell` tests: the plugin's Booking Links is listed once, last, active
  and mailbox-scoped; absent without the plugin.
- **Kept:** resource mailbox booking settings (`ResourceSettingsCard`, `MailboxCreateForm`: `autoAcceptBookings`,
  `bookingWindowDays`, ...), `BrandingForm`'s "anonymous booking-page visitors" hint (still true with the plugin), and
  `pluginNav.test.ts`'s `/settings/booking-types` `isSafePluginHref` example. No calendar or other core UI linked to
  booking links, so nothing needed making conditional.
- **Dependencies untouched:** `.yarn/patches/@rapidmx-react-shared-npm-0.4.0-e713beecf2.patch` and `package.json` are
  unchanged (a separate dependency bump is pending); nothing in `apps/` or `test/` imports `booking/bookingApi.js` any more.
- **Verification:** full `yarn vitest run --coverage` 153 files / 2253 tests, 100 / 99.96 (the two known branch gaps) /
  100 / 100; `tsc --noEmit -p tsconfig.json`, `yarn lint`, `yarn build` clean. A first full run had
  `settings/filters/new` "shows a loading state..." fail (`resolveFolders is not a function`) while tsc and lint ran
  alongside it; it passed alone and in the clean rerun - a load-dependent flake, same family as the known ones.

### 2026-09-15 — Worker URL in `dist` named a `.ts` file

- **Cause:** `localIndexRpcClient.ts` spawned its Worker with `new URL("./localIndexWorker.ts", import.meta.url)`. tsc
  copies that literal into `dist/apps/shared/search/localIndexRpcClient.js` unchanged, but only `localIndexWorker.js`
  exists there, so any Vite build of the published `dist/apps` modules (the server building plugin pages, which import
  `@rapidmx/web-client/<path>.js` package exports) failed to resolve the worker. The server carries an alias to
  `apps` sources (`src/lib/serverViteConfig.ts`, `webClientSourceAlias()`) as a workaround; it can drop it once it
  consumes a web-client with this fix.
- **Fix:** name it `./localIndexWorker.js`, like every other relative import. Vite's worker plugin
  (`vite:worker-import-meta-url`) resolves relative worker URLs through `tryFsResolve`, whose `.js` -> `.ts`/`.tsx`
  fallback maps it back to the source, so dev, tests (which stub `Worker`) and source builds keep working. It was the
  only `.ts`/`.tsx` reference in code under `dist` (the other grep hits are comments).
- **Guard:** `scripts/checkDistReferences.mjs`, now the last step of `yarn build`, fails when a `.js` or `.d.ts` file
  under `dist` has a static/dynamic import, re-export or `new URL(..., import.meta.url)` whose relative target is
  missing or ends in `.ts`/`.tsx` (comments are stripped first; a `.d.ts` `./x.js` import may resolve to `x.d.ts`).
  Run against the old `dist` it reported exactly this one reference.
- **Verification:** `yarn build` clean with the check passing; scratch Vite 8 builds (in the session scratchpad) of an
  entry importing `dist/.../localIndexRpcClient.js` and one importing the `.ts` source both emit a
  `localIndexWorker-*.js` chunk and the wa-sqlite wasm, while the same dist build with the old `.ts` literal restored
  fails. Full `yarn vitest run --coverage` 153 files / 2253 tests, 100 / 99.96 / 100 / 100; `tsc --noEmit -p
  tsconfig.json`, `yarn lint` clean.

### 2026-09-15 — react-shared styles never generated; setup wizard and plugins UX

- **Root cause:** `app.css` had `@source "../../node_modules/@rapidmx/react-shared/src"`. `@source` resolves from
  `apps/shared/styles/`, so that's `apps/node_modules/...` (never exists), and published react-shared ships only `dist`.
  No Modal/Button/Alert/FormField classes were generated: Modal had no `fixed inset-0 bg-black/50`, so no backdrop, no
  position or width, and no backdrop to click. **Fix:** two `@source` lines, `../../../node_modules/@rapidmx/react-shared/dist`
  (this checkout / nested install) and `../../../../react-shared/dist` (hoisted beside web-client in a consumer's
  `node_modules/@rapidmx`, i.e. the server and its `plugin-ui.css`, which imports this file by path). Missing paths are
  skipped silently. electron-client links web-client to this checkout, so one of the two matches either way. From a
  checkout, the second can hit a sibling `react-shared` checkout's `dist` (harmless). Verified: the server's
  `dist/public/assets/client-*.css` contains `bg-black\/50`, `max-w-\[440px\]` after overlaying this web-client.
- **Modal limits (react-shared, not changed here):** fixed `max-w-[440px]`, no size prop, the title/× row scrolls with
  the content. The settings dialog works around the scrolling with a sticky footer: `sticky -bottom-7 -mx-7 -mb-7 px-7`
  cancels the dialog's `p-7`, since Chrome sticks at the scrollport edge. Button has no size variant, so `!w-auto` stays
  the house convention.
- **UX changes:** `embedded` prop on `PluginsManager` (no h1/intro, h3 section headings, Add by name beside
  "Installed plugins", a short trust note), `BrandingForm` (no title/intro, h3 sub-headings), and the three policy forms
  (h3 `text-base` title). The wizard wraps the settings forms and branding in `bg-surface border rounded-md p-6` cards
  (`max-w-3xl`). The step heading is an eyebrow "Step N of 6" + uppercase title; its accessible name stays
  "Step N of 6: Title" via an sr-only colon. Pills: `bg-surface`, a `HiCheck` on done steps, hover border. The domains
  Retry is `variant="text"`. `EscrowSetupStep` (wizard-only) lost its h2. The plugins table has one Status column
  (badge, plus "Loaded on…"/errors when enabled; "Server status unknown" with no status), secondary Settings/Upgrade,
  a primary Enable or secondary Disable, and text Change version/Uninstall below. Below `lg` rows stack
  (`flex flex-wrap` tr, `block` td, thead hidden) with explicit table roles. An overflow menu was rejected:
  PopoverPortal is `role="dialog"` with a fixed height, and an absolute menu is clipped by `overflow-x-auto`.
- **Browser screenshot workflow** (session scratchpad, not in the repo): `browsecheck.mjs` runs the server's compiled
  `dist/src/server.js` (production, in-memory Mongo+Redis, port 38540) with an admin `jwt` cookie in Playwright headless
  Chromium. `SHOTS=1 SHOTS_LABEL=x` runs `wizardshots.mjs`: full-page 1400px and 400px shots of every wizard step
  (adds example.com on the domain step), the plugin settings dialog (plus scrolled), checks it closes via ×, Cancel,
  Escape and backdrop, then finishes setup and shoots `/admin/plugins` (it redirects to setup until then). The default
  plugins install from npm on first start, so it waits for a Settings button. Run from Git Bash with
  `MSYS_NO_PATHCONV=1` (sandbox off for localhost). To test unpublished web-client: `yarn build`, copy `apps` + `dist`
  over the server's `node_modules/@rapidmx/web-client`, `npx vite build` in the server, then restore with a reinstall.
  Full-page shots at 400px show AdminShell's fixed bottom tab bar mid-page, which is a screenshot artifact.
- **Tests:** plugins page heading vs embedded, settings dialog close via ×/Escape/backdrop (and a press inside doesn't
  close), checkbox help, one Disabled badge. Setup: embedded headings on the plugins/settings/branding/escrow steps and
  done pills. Full run 153 files / 2257 tests, 100 / 99.96 / 100 / 100; tsc, lint, build clean.

### 2026-09-15 — Recipient autocomplete and chips in Compose (`RecipientInput`, `recipients.ts`)

- **Backend contract:** restapi `BaseDirectoryRoute` at `/api/mail/directory` (server list + `GET /contacts`), wrapped
  by react-shared `mail/directoryApi.ts` (`fetchRecipientSuggestions()` merges contacts first, dedupes by address,
  tolerates one source failing, rethrows `AbortError`). Neither is published yet: for local work the new
  `dist/mail/directoryApi.{js,d.ts}` from the react-shared checkout was copied into `node_modules/@rapidmx/react-shared`
  (removed again afterwards with a reinstall). The web-client commit needs react-shared released and the dependency
  bumped before it builds from a clean install.
- **State stays a string.** `ComposeWindow` keeps `to`/`cc`/`bcc` as comma-joined text (drafts, autosave `contentKey`,
  `initialTo`, discovery all unchanged). `RecipientInput` derives chips from the value and keeps only the text being
  typed (`pending`) in state: the pending text is "active" only while it equals the value's last token, so a value set
  from outside (reset, reply prefill) drops it. `emit()` writes `[...chips, pending.trim()].join(", ")`, so an
  uncommitted address is still sent, as before.
- **Parsing (`recipients.ts`):** split on `,`/`;` outside quotes (with `\` escapes) and `<...>`; `parseRecipient()`
  handles `Name <addr>`, `"Quoted, Name" <addr>`, `<addr>`, bare text (kept whole as the address). `parseAddresses()` now
  delegates to it, so discovery and send use bare addresses and `assembleDraft()` gets `displayName` when present (the
  old parser sent `Name <addr>` as the address). `formatRecipient()` quotes names with `",;<>@()\`.
  `isValidRecipientAddress()` only drives the red chip (+ sr-only "(not a valid email address)"); it doesn't block send.
- **Commit rules:** separator typed/pasted → finished parts become chips, rest stays (leading whitespace dropped);
  Enter (no open list) or blur commits; Backspace in an empty input removes the last chip; chip remove buttons are
  `tabIndex -1` (Backspace is the keyboard path) and `preventDefault` on mousedown so the input keeps focus.
  **Test impact:** typed text becomes a chip once focus leaves (e.g. picking From), and prefilled recipients are chips,
  so assertions moved from `toHaveValue()` on the input to a `recipientChips(label)` helper (list `"<Label> recipients"`,
  item `title` = raw token) in ComposeWindow/ComposeContext/MessageDetailPane/contacts tests. The input is now
  `role="combobox"` (a `getByRole("textbox", { name: "To" })` no longer matches).
- **Combobox:** `aria-expanded`, `aria-controls` (listbox `${id}-suggestions`, always set), `aria-activedescendant`
  (`${id}-suggestion-N`) only while open, `aria-autocomplete="list"`, polite live count. The first option is
  highlighted when results arrive; arrows wrap (and reopen a closed list), Enter/Tab pick (Tab keeps focus, Shift+Tab
  doesn't pick), Escape closes and `stopPropagation`s only when open. Options/listbox `preventDefault` mousedown so a
  click doesn't blur. Suggestions for addresses already chipped in the same field are hidden. Picking calls `onCommit`,
  which runs `checkRecipientDiscovery()` immediately (discovery otherwise runs on blur).
- **Fetching:** 150 ms debounce (`debounceMs` prop, 0 in tests), `< 2` chars clears suggestions and makes no request;
  each query gets an `AbortController`, aborted by the effect cleanup on the next query/unmount, and results/errors of an
  aborted request are ignored; errors show nothing. `fetchSuggestions` prop defaults to react-shared's function (tests
  of other components hit their `mockFetch`, whose unknown-URL throw just means "no suggestions").
- **Dropdown:** portal to `body`, `position: fixed` from the field wrapper's rect (width >= 260 px clamped to the
  viewport with 8 px margins, under the field or above when < 160 px below and more room above, max-height 320),
  recomputed on resize and capturing scroll; `z-[60]` above the compose container's `z-50`. A portal because the compose
  window is `overflow-hidden`.
- Tests: `RecipientInput.test.tsx`, `recipients.test.ts` (100% on both), ComposeWindow "recipient autocomplete"
  (contacts-first dedupe, `mailboxUid` passed, keyboard pick sent with `displayName`, Cc mouse pick triggers key lookup,
  Bcc Tab pick of a quoted name).
- Verification: full `yarn vitest run --coverage` 155 files / 2280 tests, 100 / 99.96 / 100 / 100 (no flakes this run);
  `tsc --noEmit -p tsconfig.json`, `yarn lint`, `yarn build` clean.
- Browser check (session scratchpad `ac/recipientcheck.mjs`, server production build with restapi/react-shared/web-client
  overlaid and the server `DirectoryRoute` files added, port 38580): seeds a domain, users, a shared mailbox, room,
  equipment, a list and contacts through the API, enrolls keys through the gate (password + "I have saved these recovery
  codes"), then at 1400px and 400px: "al" lists 4 contacts then Person/Group/Room entries with alice.johnson listed once,
  arrow+Enter pick, "phil" matches Jean-Philippe and a mouse pick works, comma and Tab commit, Escape closes only the
  list, Cc suggestions. 31/31 checks, no page errors. Seen while there, not caused by this change: at 400px a compose
  opened from the folders drawer leaves the drawer open over it and the compose window renders at desktop width, cut off
  on the left (the dropdown clamps to the viewport); an invalid-address chip makes key lookups fail, which shows the
  existing "encryption settings couldn't be checked" alert, as a typed invalid address did before.

### 2026-09-15 — Reply/forward: caret at the top, full-body quotes, Reply All recipients

JP: "when replying the cursor should be at the top and the original content below", then confirmed the Reply All bug
(his own address landed in Cc, so he got a copy of his own reply). The quote builders, the body layout and the reply
recipients live in react-shared (see its NOTES for that half); this is the UI wiring.

- **Body layout and caret.** `ComposeWindow` seeds the body through react-shared's `buildComposeBodyHtml()`
  (`<p></p>` + signature + `<p></p>` + quote) and passes `autoFocusStart` to `RichTextEditor`, which sets TipTap's
  `autofocus: "start"`. Two traps: (1) TipTap focuses in a `setTimeout(0)` **after** mount and reads
  `options.autofocus` then, so a re-render passing `false` in between would cancel it - `RichTextEditor` holds the
  value it mounted with in `useState`; (2) minimizing unmounts the editor, so the focus decision is per mount:
  `bodyFocusedRef`/`fieldsFocusedRef` make it happen once per session. A new message focuses To (`RecipientInput`'s new
  `autoFocus`), or Subject when To is prefilled (Contacts' Email action); the body is never focused for it.
- **The dirty-tracking trap that made this more than a one-liner.** StarterKit's TrailingNode appends an empty
  paragraph after a trailing non-paragraph node (our quote ends in `</blockquote>`) on the editor's **first
  transaction** - which is now the autofocus itself - and TipTap also drops what its schema doesn't hold (the
  blockquote's `style`). That fired `onUpdate`, so an untouched reply counted as edited: autosaved as a plaintext
  draft and confirmed on Close. Fix: `RichTextEditor` ignores `onUpdate` before `create`, dispatches one empty
  transaction in `onCreate` to run the normalization, and reports the result through the new `onInitialized`;
  `ComposeWindow` adopts it as both `html` and `seededHtml` while the body is still exactly what it seeded. There is no
  "reopen a saved draft" path in this app (a compose window always creates its own draft), so this was the only case.
- **Quoted body (`compose/quotedBody.ts`).** `loadQuotedBody(message, security)`: the pane's own recovered
  `security.text`/`security.html` (decrypted or verified) first; an encrypted message with nothing recovered quotes
  nothing (never the ciphertext, never a fetch); otherwise `GET /mail/messages/:uid/content`, and when that answers
  `text/plain` (restapi's route falls back to `bodyPreview` for a message with no HTML part) the raw MIME is parsed with
  react-shared's `parseMimeEntity`/`extractDisplayBody` for the real text. Never rejects - `{}` means "quote the
  preview". An encrypted original also sets the new `openCompose({ encrypt: true })`, which starts the window with
  `encryptRequested` true, so the decrypted quote is never autosaved as a plaintext draft.
- **Reply All had nobody to reply to.** restapi's `ScanQueueJob` stores a delivered message's `recipients` as the
  envelope recipients only - just this mailbox - which is both why Reply All Cc'd JP himself and why, once that was
  excluded, Reply All would have degraded to a plain reply. `loadOriginalMessage(message, security, { recipients })`
  therefore recovers the original To/Cc: from a verified message's protected headers when it has them, else from the
  raw message's own `To`/`Cc` headers (`parseMimeEntity` + this repo's `parseRecipientList()` + react-shared's
  `decodeHeaderText()` for RFC 2047 names). Unprotected headers are the sender's claim - same as every other client's
  Reply All. The record's own recipients are still merged in for anything the headers don't name. Only Reply All asks
  for this (one extra raw fetch); a plain Reply and Forward don't.
- **`MessageDetailPane`'s own sanitizer moved to react-shared** (`mail/messageBodySanitizer.js`); `buildSecureSrcDoc()`
  is now the CSP meta plus `sanitizeMessageBodyHtml()`, and the quote uses the stricter `sanitizeQuotedHtml()`. The
  three Reply/Reply All/Forward handlers became one `handleReplyOrForward(kind)`; the buttons are disabled while the
  body loads. Own addresses come from `useMailShell()`'s mailbox, falling back to `getMailbox(message.mailboxUid)`.
- **Editor CSS:** `app.css` had no `.tiptap` rules at all, and Tailwind's preflight resets the browser's blockquote
  indent, so the quote read as part of the new message (TipTap drops the seeded inline `style` too). Added
  `.tiptap blockquote`. The Placeholder extension is still unstyled (pre-existing - no `is-empty` rule), so the empty
  first line shows no placeholder text.
- **Test-mock gotcha:** a mocked `RichTextEditor` must hold `autoFocusStart` in `useState` like the real one, or an
  assertion on it fails depending on how many re-renders happened first (it passed alone and failed in the full run).
- Verification: full `yarn vitest run --coverage` 157 files / 2321 tests, 100 / 99.96 (the two known branch gaps) /
  100 / 100; `tsc --noEmit -p tsconfig.json`, `yarn lint`, `yarn build` clean (built against the react-shared checkout's
  `dist` copied into `node_modules`, removed again with a reinstall). Browser check (session scratchpad
  `reply/replycheck.mjs`, port 38600, 18/18): unlike the other harnesses this one runs the built server with
  **NODE_ENV=development** - the pages render exactly the same, and the dev scan bypass (no rspamd/clamd here) is what
  lets a message handed to `/internal/mta/deliver` actually be delivered, so the check drives a real ingested message
  rather than a hand-built row. Then Reply (caret in the empty first paragraph, typing lands above the quote, full body
  quoted, tracker pixel and script dropped), Reply All (To = sender + original To, Cc = original Cc, no own address or
  alias, no Bcc) and Forward.

### 2026-09-15 — Mail list UX: Sort/Filter/Select toolbar and nested conversations (phase 2 of the list overhaul)

Phase 1 was the server + `@rapidmx/react-shared` API (restapi `d0e97eb`, react-shared `fa9755b`, both unpublished);
this is the UI. The two tab rows above the message list ("By date / By conversation", "All / Focused / Other") became
one Outlook-style toolbar. New files, all under `apps/shared/components/mail/`: `MenuButton.tsx`,
`MailListToolbar.tsx`, `MailSelectionBar.tsx`, `listPreferences.ts`; `ConversationList.tsx` was rewritten and
`ConversationThreadPane.tsx` deleted.

- **Where things went, and why.** "Show as conversations" lives in the **Sort menu**, as in Outlook: it arranges the
  list rather than acting on a message, and keeping it there leaves the toolbar three controls wide, which is what fits
  a 400 px phone. The Focused/Other tab row **stayed** where it was (JP's own guidance) but is now the same state as
  the Filter menu, so the menu always shows which filter is really in force.
- **One filter at a time.** `listMessages()` takes a *single* `filter`, so Focused/Other and Unread/Flagged/... cannot
  both apply. Rather than fake it, `preferences.filter` is one `MessageListFilter`: the Filter menu lists All/Unread/
  Read/Flagged/Has attachments plus a "Focused Inbox" group (Inbox only), and the tab row is a shortcut into the same
  value. A note in the menu says picking Focused or Other replaces the filter above. A remembered `focused`/`other`
  degrades to `all` outside an Inbox (`effectiveFilter`) instead of silently narrowing Sent Items.
- **Sorting is server-side and folder-wide** (`listParams` is built once and shared by the first page and every
  `loadMore()` page, so they can't drift). Sort keys are greyed out - the menu still opens, because the conversation
  toggle is in it - while a search (ranked), an aggregate view (one page merged per mailbox) or the conversation list
  (grouped by latest activity) decides the order. **Trap:** the first version disabled the whole Sort *button* in
  aggregate mode, which also hid the only way to turn conversations on there.
- **Preferences are per mailbox in `localStorage`** (`rapidmx:mail-list-preferences:<mailboxUid>`), read *during
  render* so the first listing already uses them. Held as `Record<mailboxUid, prefs>` with a `?? getMailListPreferences()`
  fallback rather than one value plus a "did the mailbox change?" render-phase `setState` - same behaviour, no
  unreachable branch, and it still works when storage is blocked (the store refuses the write; the session keeps the
  value). **Test impact:** jsdom keeps one `localStorage` per file, so `test/apps/setup.ts` now clears it in `afterEach`
  - without that, a test that picked a filter silently became the next test's starting state (two unrelated search
  tests failed only in the full-file run).
- **Select mode replaces the toolbar** with `MailSelectionBar` (count, Select all, Clear, Cancel, then Mark read/unread,
  Flag/Unflag, Archive, Move to, Report junk, Delete). Delete/Report junk/Archive are `moveMessages()` to the folder of
  that type - **never** the collection DELETE, which truncates the folder, and there is no bulk permanent delete.
  An action whose target is the folder being viewed is disabled with a `title` saying why. Select is unavailable in the
  conversation list (a conversation row isn't a message) and in an aggregate view (rows from several mailboxes, whose
  folders one Move can't name).
- **A mailbox often has no folder to move into yet.** The browser check's own mailbox was provisioned with just Inbox
  and Drafts, so the first Delete/Report junk/Archive has nowhere to go. Archive has a server-side lazy-create route
  (`POST /mail/messages/:uid/archive`), so `bulkArchive()` archives the *first* message that way and moves the rest into
  the folder that call reports. Deleted Items and Junk have none, so `resolveFolderOfType()` creates them with
  `createFolder()`. The shell fetched `mailboxFolders` once and never sees the new folder, so the uid is remembered in a
  `Map` keyed `mailbox
type` for the session - without that, a second Delete creates a *second* Deleted Items.
- **Bulk failure = refetch.** `bulkUpdateMessages()` is not atomic and stops at the first rejection, so `runBulkAction()`
  catches, clears the selection, bumps `refreshKey` (a dependency of the list effect) and shows "... Some of them may
  already have changed, so the list has been reloaded." `bulkError` is deliberately **not** cleared by the list effect -
  the refetch it triggers would wipe the message it was set alongside.
- **Conversations are nested rows now.** `ConversationList` renders a parent row per `ConversationSummary`
  (participants, subject, count, unread badge, attachment/flag hints, `latestPreview`) with its own chevron button
  *beside* the row button (a button can't nest in a button), expanding into `listConversationMessages()` children,
  fetched once per conversation. Parent click opens `latestMessageUid`, child click opens that message and hands the
  record it already has, so no refetch (`onOpenMessage(uid, message?)`). `ConversationThreadPane` was deleted: with
  every message listed and openable here, a second stacked copy of the thread in the reading pane showed the same
  thing twice. The list is now scoped to `folderUid` and honours `filter`, and pages with the same sentinel the flat
  list uses (`hasUnseenRows`/`appendUnseenRows` went generic over a key extractor). `messageOverrides` feeds the
  reading pane's mark-as-read back into the child rows.
- **`PopoverPortal` gotcha:** it renders `null` until its own positioning effect runs, so a focus effect keyed only on
  `[open, activeIndex]` fires before the menu rows exist and focuses nothing. `MenuButton` keys the effect on the menu
  node itself (a `useState` callback ref). A menu with nothing enabled focuses its own `tabIndex={-1}` container, since
  a disabled row can't take focus. The portal has no auto-height, so `menuHeight()` adds up fixed per-row heights
  (`h-5` label + `py-2` = 36, group label 24, separator 9, note 36, list padding 8) capped at 420.
- **Deliberately not built** (nothing in the data model backs them): sort by Category/Flag due date/Size/Type, filter
  To me/Mentions me/Has calendar invites, Sweep.

### 2026-09-15 (same pass) — Labels: one multi-select menu for filtering, bulk apply and the reading pane

JP asked for a label filter in the Filter menu, and for Apply Label as both a bulk action and a message-view action -
all multi-select, with the menu staying open and one command committing.

- **One component, three places.** `labelMenu.tsx` has `useLabelDraft()` (the ticked/partially-applied state, reset
  every time the menu opens, so dismissing discards), `labelSections()` (the rows, as `MenuSectionSpec[]`, so the same
  list can be a menu *or* a submenu) and `LabelMenuButton` (the standalone button). Used by Filter > Labels, select
  mode's Apply label and `MessageDetailPane`'s Labels - so the keyboard handling and the checkmarks are literally the
  same code.
- **`MenuButton` grew three things for it:** `keepOpen` (a row that doesn't close the menu - the whole multi-select
  model), `checked: "mixed"` (ARIA's third state, a dash, for a label only some of a selection carries) and `submenu`
  (a one-level drill-down with a synthesized "Back to <menu>" row; Arrow Right/Left and Escape-to-parent as ARIA
  specifies). **Trap:** the roving-focus effect also needs `submenuKey` in its deps - drilling in or out can land on
  the *same* index in the other level's list, and the button that index means is a different DOM node.
- **Mixed semantics, and why.** Ticking applies to every selected message, unticking removes from all, and a row left
  as a dash leaves each message exactly as it is. That is the only rule that lets a mixed selection be edited without
  silently flattening it. Because each message then ends up with a *different* list, the bulk write is
  `bulkUpdateMessages()` with a per-message `labelUids` rather than `setMessagesLabels()` (which is its
  one-list-for-everyone special case). Labels this mailbox no longer defines are preserved too - a label the menu
  couldn't show isn't one the reader chose to drop.
- **The reading pane's Labels dialog became this menu.** It used to auto-save on every tick (a PUT and an
  optimistic-lock `version` per tick); it now drafts and saves once. `latestLabelsMessageRef` stays, so a second save
  still carries the `version` the first came back with.
- **The filter's own labels come from the open mailbox** (`mailboxLabels`, fetched for `activeMailboxUid`), not the
  existing `labels` state, which follows the *selected message's* mailbox and in search/aggregate views can be a
  different one whose labels must not be offered as a filter here.
- **Creating a label from a menu** goes through `NewLabelDialog` (also in `labelMenu.tsx`): the "New label" row closes
  the menu and opens it, because a `role="menu"` has nowhere to put a text field. It asks only for a name (colour is
  Settings > Labels' business) and hands the created `Label` back so the owner can extend its own list -
  `apps/www/index.tsx` for the toolbar/selection bar, `MessageDetailPane`'s caller for the reading pane. A "Manage
  labels..." row links to `/settings/labels` either way.
- **Server contract:** `?labelUids=a,b` (comma-separated, OR, capped at 20, combinable with `filter`/sort/paging).
  Built first against the documented contract, since `listMessages()` builds a fixed query and would have dropped the
  param; react-shared 1c2e38e then landed `labelUids` on `MessageListParams`/`ConversationListParams` and exported
  `MAX_MESSAGE_LABEL_FILTER`, so the two local `LabelFilter*Params` aliases are gone and `MAX_LABEL_FILTER_UIDS` in
  `listPreferences.ts` re-exports the package's cap rather than repeating the number. An empty selection is left out
  of the query entirely rather than sent as `labelUids=`.

### 2026-09-16 — The conversation reading pane became a thread pane again

JP asked for the reading pane to show the whole conversation rather than the single message a row stands for, opened at
the message that was clicked. `ConversationThreadPane` is back (it was deleted in e631f44 when the nested list landed),
rewritten around that rule.

- **The expansion rule is the whole design:** every message from the opened one through to the newest is expanded and
  everything older is a one-line summary. Opening the newest (what a parent row means) therefore shows exactly one
  message expanded; opening 5 of 10 shows 5 through 10. `expandedFrom()` is that rule, and a `selectedUid` this thread
  doesn't hold falls back to the newest, so a stale uid can never leave the pane blank.
- **Each expanded message is a real `MessageDetailPane`**, not a reimplementation - that is what keeps the signature and
  verification badges, the verification-seal/decryption behaviour, the labels chips and menu, the attachments and
  Reply/Reply All/Forward/Archive identical and per-message. Its one new prop is `inThread`, which drops the subject
  from `h1` to `h3` because the thread owns the document's `h1`. A *collapsed* message mounts none of it (a body iframe
  per message up front would be wasteful).
- **Scrolling is done on the element, never an offset:** `scrollIntoView({ block: "start" })` on the opened message's
  row in a layout effect, plus `focus({ preventScroll: true })` on its header button. Toggling a message records where
  its header sat first and puts it back afterwards, so expanding something *above* what is being read doesn't shove it
  off screen. jsdom has no layout, so the tests stand in for it by stubbing `getBoundingClientRect` on the row.
- **Three traps, all found by tests:**
  - a render with the *new* conversation and the *previous* one's messages still in state happens before the load
    effect clears them - `loadedIdRef` makes the expansion run sit that render out, or it anchors on a message from
    another thread and then scrolls to a row that is about to unmount;
  - the expansion run is keyed `conversationId:selectedUid` in a ref, because `messages` is a dependency (the thread
    arrives after the click) and a patched copy would otherwise re-expand what the reader just collapsed;
  - `pendingFocusUid` has to be cleared when the conversation changes, for the same reason.
- **Fetching:** `listConversationMessages()` in pages of 100 (`THREAD_PAGE_SIZE`, the server's own default) until a
  short page, capped at `THREAD_MESSAGE_LIMIT` = 500 - which is also `CONVERSATION_SCAN_LIMIT`, so the server never
  groups more than that into one conversation anyway. If the cap is ever hit the pane says which messages it is
  showing rather than pretending the thread ends there.
- **List sync** is two callbacks: `onMessagePatched` (mark-read, labels, classify, recall) feeds `patchListedMessage`,
  which already updates both the flat rows and `ConversationList`'s own child rows, and `onMessageRemoved` (archive, a
  scheduled send sent back to Drafts) removes the row. Mark-as-read and attachment loading are the thread pane's own,
  for expanded messages only - `mailDetailHooks`' single-message hooks can't be called in a loop.
- **Mobile is unchanged:** the reading pane is desktop-only, so tapping a conversation row still opens
  `/messages/<uid>`; there is no mobile thread route yet.

### 2026-09-16 — Mail UX round: defaults, select over conversations, the body's height, icon actions

JP reported seven things against `yarn dev` after the toolbar/thread work landed. Six were ours; the seventh
(conversation grouping for replies composed here) is not, and the evidence is below.

- **Focused + conversations are now the defaults** (`listPreferences.ts`). `DEFAULT_MAIL_LIST_PREFERENCES` is
  `filter: "focused"`, `showAsConversations: true` - this client's opinion, not `listMessages()`'s own defaults, which
  is why the doc comment says so. `getMailListPreferences()` reads `showAsConversations` as
  `typeof === "boolean" ? stored : default` rather than `=== true`: a stored `false` is a choice and is honoured, while
  a record written before the field existed falls back like every other field. `focused` outside an Inbox is already
  neutralized by `effectiveFilter` in `apps/www/index.tsx`, so no other folder is silently narrowed. **Trap:** every
  one of `index.test.tsx`'s ~160 tests was written against the flat, unfiltered list; its `beforeEach` now stores that
  arrangement for `mb1`/`mb2`/`mbA`/`mbB`, and the two tests that actually exercise the defaults clear `localStorage`
  first.
- **Select over the conversation list.** It was disabled whenever conversations were shown, which with the new default
  meant always - that is the whole of JP's "the Select button is always disabled". Select mode now ticks *conversations*
  (`ConversationList` gets `selectMode`/`selectedConversationIds`/`onToggleSelected`, and a row's own button ticks
  instead of opening, mirroring `handleSelect()`), and `apps/www/index.tsx` resolves each ticked conversation to real
  `Message`s with `listConversationMessages()` **on tick**, cached by `conversationId`. That is what lets
  `MailSelectionBar` and every bulk action keep taking the `Message[]` they always took. Two rules worth keeping:
  - the resolved messages are **filtered to `folderUid`** - a conversation spans folders, and the list only ever showed
    this folder's half of it, so a bulk Archive must not reach the Sent Items copy of a reply;
  - after a bulk action in conversation mode the list is **reloaded** (`refreshKey`), not patched: a conversation row is
    a summary (count, unread count, participants, preview), so there is no row to patch in place.
  `MailSelectionBar` grew one optional prop, `totals: {selected, listed, noun}`, so it can count the rows that were
  ticked ("1 conversation selected") while `selected` stays the messages; `none` is still measured on `selected`, which
  is what holds the actions while a tick's fetch is still in flight. The toggle's own disabled rule is now
  `aggregate || loading || no rows`, each with its own reason. **Seen in the browser check:** ticking a conversation
  seconds after its mail was delivered can still 409 - the delivery pipeline bumps `version` after the message is
  listable - which reloads the list and says so (the contract `bulkUpdateMessages()` already documents), and ticking it
  again on the reloaded copies goes through. The harness now proves that recovery rather than retrying blindly.
- **The body's height.** `MessageDetailPane`'s body is `flex-1` in a flex column - which works only when the pane *is*
  the column. Inside `ConversationThreadPane` an expanded message is an item of a scrolling list, so `flex-1` meant
  nothing and the `<iframe>` fell back to its own 150px default: the short box with its own scrollbar JP screenshotted.
  `bodyClassName` is now `flex-1 min-h-0 w-full` on its own and `w-full h-[65vh] min-h-[16rem]` `inThread`, and the
  pane root carries `min-h-0` (plus `h-full` outside a thread). **Why not size it to its content:** the frame is
  `sandbox=""` and stays that way (it renders mail from strangers, and the `src=` variant is a server-rendered document
  we don't control), and with no script inside the frame nothing can measure the document and report its height. A
  viewport-proportional height is the honest trade; a very long message keeps a scrollbar.
- **Icon actions.** `IconAction` (local to `MessageDetailPane`) is a plain `<button>` with the action's name as both
  `aria-label` and `title`, plus the name in a `hidden xl:inline` span. The `aria-label` is what every existing test and
  the browser harness match on, so nothing had to be renamed. Reply All is the reply arrow drawn twice (`-ml-2.5`) -
  `hi2` has no reply-all glyph and nothing else in it means "answer everyone". Verified at 1400px (icon + label) and at
  a 396px pane (icons only, no sideways scroll).
- **Move to Other prompts.** The permanent "Always for this sender" checkbox is gone; the button opens a `Modal` with
  "Always move mail from this sender to Other/Focused" and Move/Cancel, and `handleClassify()` closes it and resets the
  checkbox on success. The classify error moved into the dialog (next to the button that would retry it) rather than
  sitting behind it.
- **Conversation grouping: diagnosed here, fixed on both sides.** Verified against the real compiled server
  (`scratchpad/mailui/uxcheck.mjs`, which seeds a real three-message thread and then replies *through the UI*):
  - mail delivered with `References`/`In-Reply-To` groups correctly - `GET /mail/messages/conversations` returned
    `[{Newsletter,1},{Lunch,1},{"Re: Hello",3}]` for five messages, the list showed two rows for the Focused half with
    no duplicates, and the thread pane showed all three messages;
  - a reply composed **in this app** goes out as `From/To/Subject/Message-ID/Content-Transfer-Encoding/Date/
    MIME-Version/Content-Type` - **no `In-Reply-To`, no `References`** - so `deriveConversationId()` (restapi) falls
    back to the message's own `Message-ID` and files it as a new conversation. Nothing in web-client can fix that:
    `AssembleDraftInput` (react-shared `mailApi.ts`) had no threading fields and nothing in the send path named the
    message being replied to. Reported up rather than worked around - and restapi 1e9ee13 / react-shared 3ef98d3 then
    landed the other half: `createDraft(mailboxUid, folderUid, threading)` records `inReplyTo`/`references` on the
    draft, the send writes them into the relayed MIME, and `conversationId` is resolved against the ancestors the
    mailbox already holds.
- **What this package now sends.** `buildReplyThreading(message)` (react-shared) goes into `OpenComposeInput`/
  `ComposeSession` as `threading`, and `ComposeWindow` passes it to `createDraft()` - including the replacement draft a
  From switch creates, since changing the sending mailbox doesn't change the thread. A *forward* carries it too: it
  continues the thread it came from, which is where its recipient's reply will be filed. Verified end to end in the
  browser: a reply composed in the UI now relays with `In-Reply-To`/`References`, and the mailbox lists one "Lunch on
  Friday" conversation of two messages instead of two of one.
- **Fewer requests per view** (JP: "navigation feels sluggish"; the sibling agent's instrumentation counted ~9 API
  calls per folder click, two of them duplicates). Each click is a full document load - that part is the navigation
  design and was left alone - but two of those requests were this page asking the same question twice:
  - `listLabels()` ran in two effects, one for the open mailbox and one for the selected message's mailbox, which are
    the *same* mailbox in every ordinary view. `labels` is now derived from `mailboxLabels`, and the second fetch only
    happens for a selected message from another mailbox (a search hit, an aggregate row) - which is also the only case
    where the reading pane's "New label" has to extend that other list.
  - the list effect ran once before the shell had resolved `folderUid` and again after: in conversation mode the first
    run was a *mailbox-wide* grouping pass, the most expensive listing there is, thrown away milliseconds later. It now
    lists nothing until the folder is known - or, in an aggregate view (which has no folder of its own), until every
    mailbox's folders have arrived, since the effect re-runs when they do.
  `uxcheck.mjs` counts every `/api/` request per view and fails on any repeat: a folder click is now 8 requests with
  one mailbox (profile, branding, setup, mailboxes, keyvault, folders, labels, listing), none of them twice.
- **Trap, cost me a run:** the compiled server serves the *browser* bundle from its own `dist/public`, built by
  `yarn build` in `server` - copying web-client's `apps`/`dist` into `node_modules` updates SSR but not that bundle.
  A browser check after changing web-client needs `yarn build` in `server` too, or it silently exercises the previous
  build (which is how a reply with no `In-Reply-To` and a duplicate `listLabels()` both "survived" a fix that was
  already in the tree).

### 2026-09-16 (continued) — Mail UX round 2: icon-only actions, a real height chain, conversation sorting

JP's second pass over the same screens. Six items; the interesting ones are the height and the sort.

- **Icon-only actions, everywhere.** `IconAction`'s `hidden xl:inline` label span is gone - the reading pane's
  Reply/Reply All/Forward/Archive/Move to Other are the glyph alone at every width, with the name still in
  `aria-label` *and* `title`. The Select toggle went the same way: `HiOutlineStop` (hi2's only plain outlined
  rounded square, which is what Outlook's "select items" command looks like), `aria-label`/`title` "Select",
  and a `bg-primary/10` background rather than only a colour for the pressed state. Its `title` becomes the
  disabled reason while it is unavailable - with nothing written on the button, that is the more useful thing
  to read at that moment.
- **The height, and the trap that cost the first attempt.** The `h-[65vh]` from the previous round is gone;
  the body is `flex-1 min-h-0 w-full` in a full-height flex column in *both* places, and the height comes down
  the chain from the window:
  `main` > `div.flex h-full min-h-0` > the reading pane column > `ConversationThreadPane` > `ul.flex-1
  min-h-0 overflow-y-auto` > an expanded `li.flex flex-col min-h-full` > `div.flex-1 min-h-0 flex` >
  `MessageDetailPane` > the `sandbox=""` iframe. `min-h-full` on the row is what replaces the `vh` number: it
  is 100% of the *scrolling list's* own resolved height, so an expanded message is exactly one pane tall,
  follows a resize, and its body reaches the bottom of the pane with the message scrolled to.
  - **The trap:** `MessageDetailPane`'s root carried `h-full` unconditionally. An explicit height on a flex
    item opts it out of `align-items: stretch`, and Chrome will *not* resolve that percentage against a parent
    whose own height came out of the flex algorithm - so inside a thread the pane collapsed to its content
    height and the iframe fell back to its 150px default again. Measured, not guessed: `heightprobe.mjs`
    (scratchpad) walks `iframe` > `html` printing each ancestor's computed height, and showed 706px of parent
    with a 293px pane inside it. `h-full` now applies **only outside a thread**, where the pane is rendered
    straight into `MailShell`'s `<main>` - a *block* that stretches nothing, so there the percentage is the
    only thing that sizes it. Everywhere else the flex chain stretches it. Same reason `apps/www/index.tsx`'s
    reading-pane column has no `h-full` either.
  - Measured at two window sizes (`uxcheck2.mjs`): 1400x900 - thread body 563px, single-message body 689px,
    both 0-1px short of the pane's own bottom; 1000x1300 - 963px and 1089px, same 0-1px. A message longer than
    the pane still scrolls in its own frame, which is unavoidable: the frame runs no scripts, so nothing inside
    it can measure the document.
- **Conversation sorting is the client's, because the endpoint has none.** `GET /mail/messages/conversations`
  takes `filter`/`folderUid`/`labelUids`/`page`/`limit` and nothing else - no `sortBy`, no `sortOrder` - and
  answers newest activity first. So `sortConversations()` (listPreferences.ts) orders the rows *already
  fetched*, and the Sort menu says so in as many words. What a `ConversationSummary` can be ordered by:
  **date** (`latestDate`), **from** (`latestFrom`, the latest message's sender - the one the row shows),
  **subject** and **flagged**. What it can't: **sentDate** and **importance**, which belong to a message and
  are simply not on the summary - `CONVERSATION_SORT_UNAVAILABLE` greys those two rows out with their reason
  beside them (keep the reason under ~26 characters or `MenuButton`'s one-line description truncates it) and
  leaves the server's own order alone rather than shuffling the rows by something meaningless. Ties break
  newest-first whichever direction is in force.
  - A conversation's own child rows follow the same order sense: `ConversationList` takes `newestFirst` and
    reverses the (always oldest-first) `listConversationMessages()` copy for display. The *thread pane* is
    newest-first **always**, whatever the list is sorted by - see the entry below, which revised this.
  - **`serverSortKey`** is why changing the order doesn't refetch: the list effect used to depend on
    `preferences.sortBy`/`sortOrder` directly, so reordering conversations re-listed the identical page *and*
    unmounted `ConversationList` (the list renders "Loading…" instead), collapsing whatever the reader had
    expanded. The dependency is now empty while conversations are shown.
- **No "All" tab.** The tab row is `MAIL_LIST_CLASSIFICATION_FILTERS` - Focused and Other. Nothing is migrated:
  `all` is still a `MessageListFilter` and still the Filter menu's first item, so a mailbox that remembered it
  still lists the whole Inbox with neither tab pressed. Migrating a stored `all` into Focused would silently
  narrow someone's list; leaving it is both honest and a no-op.
- **The unread chip.** A conversation row's count comes from the summary, which no reading-pane patch touches -
  so a thread stayed at "2 unread" after both were read. `ConversationThreadPane`'s `onMessagePatched` now
  takes `(updated, previous?)`, passing the unread copy it replaced from its own mark-as-read path only, and
  `patchListedMessage()` decrements the containing conversation's `unreadCount` when `previous` was unread and
  `updated` is read. The transition has to be reported rather than inferred: `updated.flags.read === true` is
  also true for an already-read message being relabelled. The flat list needed nothing - its row *is* the
  message. **Test impact:** `toHaveBeenCalledWith` compares arity, so the two thread-pane tests asserting on
  `onMessagePatched` had to name the second argument (`undefined`, or the previous copy).
- Verified against the real compiled server with `scratchpad/mailui/uxcheck2.mjs` (ports 38660+): 31/31,
  including both window sizes, both sort directions with the child rows, the two-tab row at 1400px and 400px,
  the Select glyph, and the chip going 3 -> 2 -> gone as the thread is read. The NOTES rule from the previous
  round still bites: `yarn build` in `server` after refreshing the patch, or the browser check exercises the
  previous bundle.

### 2026-09-16 (continued) — Mail UX round 3: a newest-first thread pane, and Move to a real folder

Two follow-ups from JP on the round above.

- **The thread pane reads newest first, always.** Round 2 left it chronological on the reasoning that a thread is
  read oldest-to-newest; JP's rule is simpler and is now the one implemented: the pane's order is the pane's own,
  never the list's, and the message a conversation row stands for is the top entry every time. `loadThread()`
  collects its pages oldest-first (the endpoint has no order to ask for, and `THREAD_MESSAGE_LIMIT` has to apply in
  that direction - it is the oldest that get dropped) and reverses **once** at the end, so nothing downstream has
  to know about page order. Two knock-on changes, both in `expandedFrom()`'s neighbourhood:
  - the run is `messages.slice(0, anchor + 1)` rather than `slice(anchor)` - the opened message plus everything
    *above* it - and a `selectedUid` this thread doesn't hold anchors on index 0 rather than the last index;
  - `pendingFocusUid` is the run's **last** entry (`[...expanded][expanded.size - 1]`), because the message that
    was opened is now at the bottom of the expanded run. Getting that wrong scrolls to and focuses the newest
    message instead of the one clicked, which is invisible in a two-message thread - hence the tests below pinning
    the rendered order and the expanded pattern by position, not just which panes exist.
  - **Test shape that catches this:** `renderedOrder()`/`renderedPattern()` read each row's `aria-controls`
    (`thread-message-<uid>`), so they assert the DOM order rather than set membership. Every older test matched
    messages by sender name and passed unchanged under a reversed list - which is exactly why they missed it.
- **"Move to" is a folder picker now, and Focused/Other has no UI at all.** JP: the Focused/Other split "shouldn't
  be explicit but instead purely implicit". So `classifyMessage()`/`FocusedInboxOverride` have no caller in this
  package any more:
  - `MessageDetailPane` lost `isInbox`/`onClassified`, the two classify `IconAction`s and the "Always move mail from
    this sender" confirmation, and gained `folders`/`onMoved`/`onFolderCreated` plus one `Move to` icon;
  - `apps/www/settings/focused-inbox/` (the per-sender rules page) and its `SETTINGS_SECTIONS` entry are deleted -
    it was the remaining UI that wrote an override;
  - **dead client code this leaves:** react-shared still exports `mail/focusedInboxOverridesApi.js` (now unused by
    this package) and `classifyMessage()`/`MessageClassification` (still used by nothing here; `Message.
    inferenceClassification` is still *read*, by the Focused/Other filter). Left alone deliberately - react-shared
    is a shared library and restapi still serves both endpoints; reported up rather than pruned from here.
- **`MoveToFolderDialog` is one component for both places** (the reading pane and `MailSelectionBar`), which is what
  keeps the destination rules and the create-a-folder step from drifting. A `Modal`, not a `MenuButton`: creating a
  folder needs a text field and a `role="menu"` has nowhere to put one (the same reason `NewLabelDialog` exists).
  - `MOVE_TARGET_TYPES` moved here from `MailSelectionBar`. The folder being moved out of is **disabled, not
    hidden**, so the list doesn't change shape between folders; Outbox is never offered.
  - A new folder is created at the **top level of the mailbox**, typed `user`, never under the current folder:
    `Folder.parentFolderUid` exists, but `MailShell`'s sidebar lists folders flat (`FOLDER_ORDER` + user folders),
    so a subfolder would go into a hierarchy nothing renders.
  - **Validation, all client-side and next to the field** (`folderNameError()`): non-empty after trimming, at most
    255 characters, no `/` or `\` (folders are a tree, not paths - a separator would be a character in the name,
    reading as a hierarchy this app never made), and no case-insensitive duplicate of an existing folder, refused by
    naming the folder that already exists rather than creating a second one.
  - `onFolderCreated` is called **before** the move, so a folder that was created survives a move that then fails;
    it threads up to `MailShell`'s new `MailShellContext.onFolderCreated`, which files the folder under its own
    mailbox in `mailboxFolders` - that is what puts it in the sidebar and in every picker without a page load.
  - **Error split, deliberately:** the reading pane's `onMove` rejects and the prompt shows it; the bulk one always
    resolves, because a bulk update applies element by element and its partial-failure story (reload the list, say
    some may already have changed) belongs in `MailSelectionBar`, not in a prompt claiming nothing happened.
- **Real bug, found by a test that looked like a test bug.** `handleMove()` was first written as
  `onMoved?.(await moveMessage(message, folderUid))`. An optional call whose callee is nullish **does not evaluate
  its arguments at all** - so with no `onMoved` the message was never moved, and the prompt closed as if it had.
  Two tests failed with "no fetch calls at all and the dialog closed", which read like a click-target problem;
  the answer was the short-circuit. Always `const updated = await ...;` then `cb?.(updated)`.
- **Scrolling to a message now moves the thread's list, never the window.** `scrollIntoView({block:"nearest"})`
  scrolls *every* scrollable ancestor - and with a run of full-height messages expanded, `AppShell`'s root is
  content-based (`min-h-screen`, so its height is `auto` with a 100vh floor), the page really is taller than the
  window, and the browser duly scrolled the header and the app rail off the screen. Opening the *oldest* message
  of a thread is the case that shows it, which is exactly what the newest-first order made reachable. The
  layout effect now puts the adjustment on `scrollingAncestor(row)` - the same helper the collapse/expand
  anchor already used - and leaves the page alone when that resolves to `document.documentElement` (nothing
  inside the pane scrolls, so the row is already in view). Measured before and after in `uxcheck3.mjs`:
  `document.body.scrollTop` 149 -> 0.
  - **Tried and rejected:** `h-screen` on `AppShell`'s root, which is the real fix for the page still being
    1163px tall in that state - `CalendarShell`, `ContactsShell`, `TasksShell` and `SettingsShell` all render
    their content into a `flex-1 min-w-0 flex flex-col` with **no** `overflow-y-auto`, so pinning the shell to
    the viewport would clip those four apps instead of scrolling them. Doing it properly means giving each of
    those shells a scrolling content pane - worth doing, but its own change. Also tried `h-0` alongside
    `flex-1` on the thread list to stop it contributing to the shell's intrinsic height; it does not, because
    the contribution comes through the expanded rows' own `min-height: 100%`, which is treated as `auto` while
    the ancestor is being intrinsically sized.
- Also fixed while here: `ConversationThreadPane.test.tsx`'s attachments test asserted on `await findByTestId(...)`
  and then checked its text once - the row mounts before its attachments request lands, so it raced under
  full-suite load (it failed there while passing in isolation). The `waitFor` has to wrap the *assertion*.

### 2026-09-19 — Mailbox policy: "Reset to server default" per field

- `MailboxPolicyForm` offers a text button under each field whose value differs from `policy.defaults` (the server's
  config value): "Reset to server default (5 GB)" / "(on|off)". It **fills the field and leaves saving to the form's
  own Save**, like every other edit, so the dirty tracking, the leave-with-unsaved-changes prompt in the setup wizard and
  the send-only-what-changed patch all keep working with no special case. Quota fields compare as bytes
  (`Math.round(Number(text) * GB)`), so "5.0" against a default of 5 GB offers no reset. No `defaults` (older server) -> no
  buttons at all.
- **`tsc` fails here until `@rapidmx/react-shared` with `MailboxPolicy.defaults` is published and this repo's dependency
  is bumped** - `node_modules/@rapidmx/react-shared` is a registry copy, so it doesn't see the sibling repo's change. The
  only error is `Property 'defaults' does not exist on type 'MailboxPolicy'` in `MailboxPolicyForm.tsx`; vitest is
  unaffected (the field is only read at runtime). Not worked around with a cast.
- Tests: `test/apps/admin/mailbox-policy/index.test.tsx` (reset of each of the three fields, nothing sent before Save, no
  button at the config value, no button without `defaults`); the file is at full coverage.

### 2026-09-20 — Elevation redirect, DNS copy buttons, no admin header, provisioning reasons, user menu, live inbox, addresses, send failures

Not committed. Needs the sibling `react-shared` changes of the same date (see its NOTES), which are unpublished.

- **How this repo sees unpublished `react-shared` (no patch, no portal).** `@rapidmx/react-shared` is a plain registry
  dependency (`^0.8.0`, 0.8.0 installed, no `.yarn/patches`, no `resolutions`). To type-check and test against the sibling's
  source: `yarn build` in `react-shared`, then `cp -r dist/. ../web-client/node_modules/@rapidmx/react-shared/dist/`. A fresh
  build of the sibling's `HEAD` differs from the installed 0.8.0 `dist` only by the new work (checked with `diff -rq`), so the overlay
  is faithful. Nothing tracked changes (`node_modules` is ignored): `package.json`, `yarn.lock` and `.yarn` are untouched. Until
  JP publishes react-shared and this repo's dependency is bumped, a plain `yarn install` (or a fresh checkout) has the registry
  copy and `tsc`/vitest fail on the missing modules (`util/clipboard`... `mail/pushClient`, `mail/mailAddress`, `mail/sendFailure`,
  `components/buttons/CopyButton`, `getMyUsername`); re-run the copy above to get going again. (The 2026-09-19 entry's `tsc` failure is
  gone - 0.8.0 is published.)
- **Admin console elevation.** `AdminShell`'s canary (`GET /admin/release-notes`) is class-level `@RequiresElevation()`, checked before
  the trusted-role check: a non-elevated admin gets 403 `api-104`. `admin/elevation.ts` (`isElevationRequired`, `elevationUrl`,
  `elevationAttemptedRecently`, `recordElevationAttempt`, `clearElevationAttempt`) holds the logic; the shell sends the browser to
  `${authServerUrl}/auth/elevate?return_to=<href>`. Loop guard: the attempt time goes in `sessionStorage`
  (`rapidmx-admin-elevation-attempt`); within `ELEVATION_RETRY_WINDOW_MS` (2 min) a second `api-104` shows an Alert ("didn't take
  effect") with "Try again" (clears, records, redirects) instead of redirecting; a successful canary clears the marker so a later
  expiry can elevate again. Every storage access is in try/catch; **with storage unavailable the redirect still happens** (loop
  protection is lost, but each round trip needs the user to confirm on auth-server, so it is human-paced) - a deliberate choice,
  the alternative being a manual "confirm identity" button. `api-103`, other 403s and 401 keep "no administrator access"; no
  `authServerUrl` shows it too. **`EscrowShell` was not changed**: it gates on `listMatters()` (200 for any signed-in caller), not a
  canary that can 403, so it doesn't share the pattern.
- **DNS checklist copy buttons** (`DomainDnsSetup`, used by the domain page and the setup wizard). Every pasteable value has a
  `CopyButton` (react-shared): ownership TXT name and value, and per row the record name and value; an MX value
  `"10 mx.host"` is split into priority and mail server (two buttons, as providers' forms have two fields; a value that doesn't
  parse gets one). The table now shows each record's type and name (`recordName`, which it never did) and a note that some
  providers want relative names. Type isn't copyable (a dropdown in every DNS form); TTL isn't shown by the server.
- **Admin console has no custom header.** `AdminShell` no longer renders `BrandingHeader`; the **footer stays** (self-contained legal/
  contact markup; nothing in the branding files opens a container the footer closes) and `useBranding()` is still needed for it, the
  stylesheet injection and the rail icon. `AppShell` keeps both. The Branding page's intro text now says which is shown where.
- **Mailbox provisioning (task narrowed by the coordinator):** contract unchanged (`needs_username` and the username form were written
  and reverted). `MailboxProvisioning` shows the server's reason above "Ask an administrator..." only for a 4xx (first line, 200
  chars max) - never a 5xx message or a network error's; a 502 now offers Retry like a 503, with its own "couldn't reach the identity
  service" text.
- **User menu.** Name and initials fall back profile name -> username (`getMyUsername()`: first verified `name` alias from
  `GET {auth}/api/aliases?type=name`; asked for only when the profile gave no name) -> uid; some accounts have no profile document
  (404) and the deployed auth-server's CORS list once blocked `/profiles/me`. Added an "Account" item (first) linking to
  `${authServerUrl}/account` (trailing slashes stripped; `authServerUrl` is set by the chart with none, but a hand-written config
  could); it appears in every shell that uses `UserMenu`, escrow included.
- **Live inbox (`shared/mail/useMailLiveUpdates.ts`, wired in `MailShell`; `InboxContent` does the quiet refresh).** Verified against
  `@rapidrest/service-core`'s `BasePushRoute`/`RouteUtils`, which differs from what the docs say: **the WebSocket is `/push`, not
  `/push/connect`** (`@WebSocket()` has an empty sub-path); it authenticates from the `jwt` cookie on the upgrade; on connect the server
  sends `{id:0,type:"SUBSCRIBED",data:[...]}`; **events are the raw `NotificationUtils` JSON `{type,action,data}` with no channel** (the
  `{type:"MESSAGE",channel,data}` wrapper is only for `POST /push/:id`), so the folder comes from `data.folderUid`; `type` is the model
  class name (`MessageMongo`/`MessageSQL`, matched `/^Message/`) and `data` is the whole `Message`. Limits: 10 sockets and **50 channels per
  user across all tabs, duplicates counting** - a tab asks for at most 40 (inboxes first, then other folders, then mailbox uids).
  Ingest publishes only to the receiving folder's uid (`ScanQueueJob` ~991, ~1053), so there is no mailbox-level mail event.
  - What it does: one shared `getPushClient()` per tab; message events (create/update/delete) -> debounced (400 ms) bump of
    `useMailShell().live` plus a re-read of every mailbox's folder unread counts (kept in a separate `unreadCounts` overlay, **not** in
    `mailboxFolders`, because the list effect reloads - and forgets the selection - whenever `mailboxFolders` changes); a `Folder` create
    event calls `onFolderCreated` (now deduplicated by uid); a 45 s poll while `document.visibilityState === "visible"`, plus refocus,
    `visibilitychange` and `online`, plus every reconnect, use the same path with "folder unknown"; sign-out (heard on
    `SIGN_OUT_CHANNEL`, which `destroyAllLocalIndexes()` also announces to this tab's own other channel objects - so **`AppShell`'s
    sign-out is unchanged**) closes the client for good.
  - `InboxContent`'s effect on `live.tick` fetches page 0 and folds it in with `mergeFirstPage()`: a short page is the whole listing and
    replaces the list; a full page goes first and the older loaded rows follow (a delete elsewhere from a long, partly-paged list stays until
    the next real load); a row present in both keeps the higher `version` (so a just-read message isn't reverted by an older fetch);
    `listedOffsetRef` advances by the number of new rows so "load more" neither skips nor repeats. It skips while searching, loading, a
    load-more is in flight, or the event's folder isn't shown (a conversation list refreshes for any folder). Failures are silent.
  - **Not done, found:** the Tier 2 local index (`LocalIndexLifecycle`/`localIndexBuilder`) ingests by its own `listFolders/listMessages`
    walk, started once per unlock (a 5 s timer only watches for key destruction and (re)unlock) - so mail delivered later is not added to
    it until the next page load or re-unlock. Only encrypted messages are indexed, so this affects only Tier 2 search of new encrypted mail.
    A nudge (re-running `buildLocalIndex()`, which compares indexed versions, on a message-create event for the active mailbox while
    unlocked) would fit here; left alone rather than guessed at. Likewise an open conversation thread (`ConversationThreadPane`) doesn't
    refetch its own messages when mail joins it.
  - Test gotchas: `test/apps/setup.ts` now replaces `WebSocket` with a never-connecting stub (jsdom's really connects) and resets the push
    singleton after each test; **`mockLocation()` leaves `window.location` without an `origin`**, so `pushUrl()` is undefined and nothing
    connects - the live tests set a real `URL` in `beforeEach`.
- **Addresses (`MailAddress.tsx`, `formatMailAddress()` in react-shared).** Rows show `Name <address>` with the name shrinking a thousand
  times faster than the address's local part and the `@domain` never shrinking; the two visible halves are `aria-hidden` and one `sr-only`
  span carries the full text (tests use `getByText(..., { selector: ".sr-only" })`). The pane header always shows the address (it used to
  only when signed or the name had an `@`) with `checkSenderName()`'s warning kept; To/Cc/Bcc are separate `RecipientLine`s that fold after 3.
  A conversation row shows its first participant in full plus `+N` (tooltip and sr-only text list everyone). `composeQuoting`'s forward
  quote lists To recipients with addresses; `recipientDisplayName()` (which drops a name that is another address) is unchanged there.
- **Send failures.** `ApiRequestError.details` (whole parsed body) -> `describeSendFailure()` -> `SendFailureAlert` (message + collapsed "Technical
  details" list + `CopyButton`) in `ComposeWindow`, which already stayed open on failure. The restapi `details` shape wasn't final, so the parser
  is generic (`details` object/list/text, else the body's other keys; capped). Close after a failed send now asks ("Close, keep draft" /
  "Keep editing" / "Discard"); a minimized window shows "Not sent". Nothing else in the send/autosave path changed.
- Test-suite state: `tsconfig.test.json` has ~100 pre-existing type errors (`mockFetch` signature etc.) - the gates are `tsc` (app config),
  `yarn lint` and vitest.
- Verified (with the `react-shared` `dist` copy described above): `yarn tsc --noEmit` clean, `yarn lint` clean, `yarn vitest run --coverage` 167 files / 2628
  tests passing, coverage 100 / 99.92 / 100 / 100 (statements / branches / functions / lines). The 5 uncovered branches are old ones (`MoveToFolderDialog` 223,
  `ComposeWindow` two, `index.tsx` two); nothing new is uncovered.

### 2026-09-20 (afternoon) — Unread styling, folder counters that follow the user, new-mail pop-ups, "Admin Console" without elevation

Not committed. JP's screenshot of the live inbox: "Inbox 6" with everything read, two rows that looked identical. Uses the released `@rapidmx/react-shared` 0.9.0 as installed - **nothing in `react-shared` changed** (no overlay needed). Another agent (W1) was reworking navigation in the same tree (router, lazy panes, compose latency); this work touched `MailShell`, `AppShell`, `UserMenu`, `MessageDetailPane`, `ConversationThreadPane`, `ConversationList`, `index.tsx`, `[uid].tsx` with small targeted edits.

- **Why the badge was wrong.** The sidebar showed `Folder.unreadCount` as loaded, which the server never decremented (`@rapidmx/restapi` is fixing it: `GET /mail/folders` derives `unreadCount`/`totalCount`, and after any change it publishes `{ type: /^Folder/, action: "update", data: { uid, mailboxUid, unreadCount, totalCount } }` on the folder's push channel). **Confirmed by the restapi agent afterwards, and this code is written to it, while still tolerating its absence** (the read-back after each change and the 45 s poll do the same job later; with the old server a stored count that was never decremented returns after each read-back): derived `totalCount` (non-deleted messages) and `unreadCount` (`flags.read !== true`) on `GET /folders`, `GET /folders/:id` and the PUT/bulk responses; the event type is `FolderMongo`/`FolderSQL` (matched `/^Folder/`), `data` is exactly `{ uid, mailboxUid, unreadCount, totalCount }`, and it is published to **both the folder's channel and its mailbox's**, so the client hears each update twice - `applyFolderEvent()` is idempotent (absolute values, applying the same one again changes nothing) and never treats them as deltas. Writes by the ActiveSync/MAPI plugins and whole-mailbox erasures publish nothing, and overlapping writes to one folder are unordered, so the read-back after every change, on the poll, on refocus and on reconnect stays.
- **`shared/mail/folderCounts.ts` - the counters model.** An overlay (`counts`, by folder uid) in front of the loaded folders, *not* written into `mailboxFolders` (the list effect reloads and forgets its selection whenever that changes). `countDeltas(previous, next)` says what a message change does to the folders (read flip, move, delete, create); `useFolderCounts()` applies it at once (`track()` returns `{settle, revert}`), then **reconciles**: `refresh()` re-reads every mailbox's folders and replaces the overlay. Drift is prevented by three rules: a read that began before a change of this page's own began or ended is discarded and asked again (`changesRef`/`inFlightRef`); a server-published `Folder` event is applied only when nothing of this page's own is in flight and none finished in the last 1.5 s (`COUNT_QUIET_MS`), else it triggers a read instead; and the overlay restarts when the mailboxes load again (keyed on their uids, not the array). `noteCreated()` counts a pushed message once (500-uid memory) and returns whether it was new - that return is what stops a duplicate event being announced. Badges: `badgeFor(type, count)` - Inbox/Archive/user: unread when > 0 (name bold), Drafts/Outbox: total, Sent/Deleted/Junk: none (`badgeLabel()` is the sr-only text: "3 unread", "2 messages"); the All Mailboxes entries sum a type across mailboxes and apply the same rule. `inboxUnreadTotal()` + `useUnreadTitle()` prefix the tab title `(3) `.
- **One function changes read state (`shared/mail/messageReadState.ts`).** `setReadState()` (one message) and `setReadStateMany()` (a selection): optimistic `patch(optimistic, previous)` + `track(previous, next)`, then the server, then `patch(serverCopy)` + `settle()`, or `patch(original, optimistic)` + `revert()` on failure (`setReadState` never rejects; `setReadStateMany` reverts and rethrows because a bulk update isn't atomic and `runBulkAction` reloads the list). Three callers: `useMarkMessageRead` (new, `shared/mail/useMarkMessageRead.ts`, replaces react-shared's hook - that one drops the server's answer when the message changes, which the optimistic copy itself does, so the row would keep a stale `version`), `ConversationThreadPane`'s expand effect, and the bulk Mark read/unread. `InboxContent.patchListedMessage(updated, previous)` now moves a conversation row's `unreadCount` by `unread(updated) - unread(previous)` (it only decremented before), so a revert restores the count. Moves/deletes/archive: `MessageDetailPane` calls `useMailShell().trackMessageChange(message, updated).settle()` after each server success (move, archive, cancel-scheduled-send), `runBulkAction` does it for `removesRows`; `trackMessageChange` is on `MailShellContext` (a no-op tracker as the default value). `mergeFirstPage`'s `pick` for messages is now `current.version >= next.version ? current : next` so an equal-version optimistic row survives a refetch.
- **Retry rules (a real trap).** The optimistic revert changes the message, which re-runs every effect keyed on it, so "clear the requested marker on failure" would loop for ever. `useMarkMessageRead` asks once per *opening* (the marker set is cleared when the open message's uid changes); `ConversationThreadPane` clears a message's marker in `toggleExpanded()` (re-expanding retries), never on failure.
- **Not done / found.** The Tier 2 local index (`localIndexBuilder`) stores `flags` per encrypted message and only refreshes them when its next build sees a new server `version`; there is no per-message "flags changed" hook (only `moveLocalEntity`/`removeLocalEntity`), so a read flip reaches it on the next build - it affects only `is:read`/`is:unread` in Tier 2 search of encrypted mail. Drafts saved/discarded in compose reach the Drafts badge through the message events' read-back, not optimistically. The pop-ups and counters exist only where `MailShell` is mounted (Calendar/Contacts/Tasks/Settings don't open the push socket; with W1's persistent frame that could move up into it).
- **Unread styling (`shared/components/mail/unreadStyle.tsx`).** One set of helpers for every list: `rowClass({unread, selected})` owns the row's single background (selected `bg-primary/20` + `ring-1 ring-primary/50`; unread `bg-primary/[0.07]`, hover `bg-primary/10`; read hover `bg-surface-alt`), `UnreadBar` (3 px `bg-primary`, `aria-hidden`), `UnreadLabel` (sr-only "Unread. "), `senderClass`/`subjectClass`/`dateClass`, `ROW_FOCUS_CLASS` (inside outline). Rows carry `data-unread="true"` (tests key on it; the old tests asserted `font-semibold` on the button). Unread = `flags.read !== true` (`isUnread()`); the weight moved from the button to the sender/subject elements, so a button's accessible name now starts with "Unread." (`header()` in the thread pane tests matches `^(Unread[.])?Name`). Colours are theme tokens only, so dark mode and a branding palette follow. **Looked at in Edge** (light and dark, conversation and message lists, hover/selected, toast, menu) through a scratchpad harness: Vite (web-client's own) + `@tailwindcss/vite` rendering the real `apps/www/index.tsx` with `window.fetch` and `WebSocket` replaced by stubs (`playwright-core`, `channel: "msedge"`; the harness is not in the repo).
- **New-mail pop-ups (`shared/mail/newMailNotifications.ts`, `useNewMailNotifications.ts`, `components/mail/NewMailToasts.tsx`).** Fed only by `useMailLiveUpdates({ onMessageCreated })` (a push `create` event whose `data` has `uid`, `folderUid` and `flags`) - never by a list fetch, the first load or a reconnect (Redis pub/sub is not replayed). `shouldAnnounce()`: folder type `inbox`, unread, `inferenceClassification !== "other"`, `from` not one of the user's own addresses (`primarySmtpAddress` + aliases, case-insensitive), received < 6 h ago (bulk imports arrive as creates too). Text comes from the event (`bodyPreview`, cleaned of control/bidi/zero-width characters, cut to 140 chars, `…`) and is only ever rendered as text; an encrypted message shows "Encrypted message" (subject `[...]` becomes "(encrypted subject)"). Toast: `role="status"` polite region always mounted, max 3 (oldest dropped), 8 s, paused on hover/focus/hidden tab (remaining time kept), a plain `<a href="/messages/<uid>">` (W1's router intercepts same-origin links in its table; the desktop notification click uses `window.location.href` by default, `open` is injectable for `useNavigate()`), dismiss button, `.rr-toast-in` animation only inside `prefers-reduced-motion: no-preference`. Desktop: `Notification` only when permission is `granted` and (`visibilityState === "hidden"` or `!document.hasFocus()`), `tag = uid`, at most 5 per 30 s, constructor failures swallowed. Never prompts on load: the offer ("Turn on desktop notifications" / "Not now") sits in the first pop-up while permission is `default` and `rapidmx-desktop-notifications-offer` is unset; it and the account menu's item call `Notification.requestPermission()` from the click; any answer sets the marker. `rapidmx-new-mail-popups` = `off` turns everything off. All storage in try/catch.
- **Where the "pop-ups off" setting lives.** The account menu (`UserMenu` `showNotificationSettings`, passed by `AppShell`): a `menuitemcheckbox` "New mail pop-ups On/Off" and, while permission is `default`, "Turn on desktop notifications". **No Settings page**: there is no natural existing section (auto-reply, filters, signatures, labels, read receipts, encryption, sharing, privacy are all mailbox-scoped and this is per browser), and a new section needs a `SETTINGS_SECTIONS` entry, a `routedPage` and a `_routes.ts` row in W1's router while it was in flux. Easy to add later on top of `newMailNotifications.ts`.
- **Admin Console.** `shared/auth/adminAccess.ts` `lookUpAdminAccess(authServerUrl, userUid, trustedRoles)`: `GET {auth}/api/users/me` (credentialed; the caller may read their own `User`, whose `roles` is the source of truth - the same call auth-server's own UI makes "to check for admin access"; the JWT can't say, `TokenUtils.resolveTokenUser()` strips trusted roles from a non-elevated token). Requires `uid === userUid` and an array `roles`; remembers only a real answer (`sessionStorage` `rapidmx-admin-access:<uid>` `{admin, at}`, 30 min), shares one in-flight request per key, never rejects. `UserMenu` props: `detectAdmin` (AppShell passes `!trusted && !impersonating`), `trustedRoles`, `showAdminLink` (`trusted && !impersonating`). The item is `<a href="/admin">` with a `HiOutlineShieldCheck` icon and the text "Admin Console" (was "Admin"), above "Sign Out". **Server:** `wwwRoute.fetchProps` (mongo and sql) now also returns `trustedRoles: this.trustedRoles` (`trusted_roles`, default `["admin"]`), `AppShellProps.trustedRoles` carries it, and Mail/Calendar/Contacts/Tasks/Settings shells forward it (the client falls back to `["admin"]`). Cannot be spoofed into more than a link: `/admin` and the admin API still check the role and the elevation. Not checked: a real auth-server (CORS for the mail origin on `/api/users/me` is assumed the same as for `/api/profiles/me`, which works).
- **Tests.** New: `_auth/adminAccess`, `_mail/{folderCounts,messageReadState,useMarkMessageRead,useNewMailNotifications,newMailNotifications,useUnreadTitle}`, `_components/{unreadStyle,NewMailToasts}`; extended `UserMenu`, `AppShell`, `MailShell` (badges, counters through `trackMessageChange`, folder events, pop-ups, tab title), `index` (read state and badges, bulk unread, move), `ConversationList`, `ConversationThreadPane`, `MessageDetailPane` (tracking), `useMailLiveUpdates` (+ssr). `test/apps/setup.ts` also clears `sessionStorage`. The old "forgets a failed mark-as-read" thread test now asserts the revert and the no-loop rule. **Failures that belong to W1's unfinished work, left alone:** `MessageDetailPane.test` reply/forward quoting and decrypt tests, `contacts/index.test`, and `index.test` cases that expect the mocked `detail-pane` or `location.href` (lazy reading pane, `useNavigate`); `yarn lint` also reports `AppRouter.tsx` (indentation, duplicate import, two unnecessary assertions).

### 2026-09-20 — Speed: client-side router, per-folder snapshots, a 77% smaller first load, instant compose windows

Not committed. Needs the sibling `react-shared` change of the same date (see its NOTES; unpublished) for the full bundle saving - everything
else works with the released 0.9.0, but with it the inbox route's first JS is about 1.05 MB instead of 467,229 B (`smime` comes back through
`KeyEnrollmentGate -> masterKeyWraps`, x509 through `keySession -> keys`). Findings first: the server was never slow (SSR/API 5-100 ms). The cost was the browser: an inbox load fetched
17 chunks / 2,014,028 B of JS, of which a 1,022,512 B "shared" chunk (Rolldown named it `MailboxProvisioning-*.js`) was TipTap + ProseMirror + the
500 KB emoji JSON (the compose editor, reached statically through `ComposeContext -> ComposeWindow`), `smime-*.js` (553 KB) was PKI.js/ASN.1/X.509
(reached statically through `keySession -> keys -> @peculiar/x509`, `messageSecurity`, `masterKeyWraps`, `localIndexBuilder`), and every
folder link, app-rail link and `window.location.href` was a full document load + a new hydration entry.

- **Client-side router (`shared/navigation/`).** `@rapidrest/react` **hydrates only the page component - `_layout.tsx` is server-only** (the
  `hydrateRoute()` entry hydrates `#react-root`, which the layout wraps), so the router can't live in the layout. Each `apps/www` page's default
  export is `routedPage("/its/route", Page)` (`apps/www/_routedPage.tsx`): it renders `AppRouter` (the whole client tree) with `Page` first, and
  carries the plain `Page` as `.page` for the router to use when it loads that module (rendering the wrapped default would nest a second router).
  `apps/www/_routes.ts` is the route table (`{path, active, load: () => import(...), idlePrefetch?}`); `test/apps/routedPage.test.tsx` checks it
  against the files under `apps/www` so a new page can't be forgotten. **One `AppChrome` stays mounted** (rail, header, user menu, banner, compose
  windows, unlock prompt, idle-key timer, sign-out listener): `AppShell` is now a wrapper - inside `AppFrameContext` it renders only its children,
  outside it (admin, escrow, plugin pages, tests) it is the whole `AppChrome`, so no shell or plugin call site changed. The frame's props are the
  server's page props (identical for every www page: `WwwRoute.fetchProps()` + `userUid`, `user`; only `params` differs and the router recomputes
  it from the URL); no www page exports a `fetchProps`. `active` comes from the route table.
  - Links are plain `<a href>`: one `document` `click` listener takes plain left clicks on same-origin routes in the table (skips modifier keys,
    a non-zero button, a `target` other than `_self`, `download`, `data-full-reload`, hash-only links and `defaultPrevented`). Unmatched URLs, the
    admin/escrow consoles, plugin pages and other origins are left to the browser. `useNavigate()` does the same for code; outside a router it is
    exactly `window.location.href = ...` (existing tests assert on that).
  - `useLocation()`/`useLocationSearch()` are **empty until an effect reads `window.location`** (the server and the hydrating render must match, and
    the server can't know the query string) - so `MailShell`, `CalendarShell`, `ContactsShell`, `TasksShell` and `SettingsShell` derive
    `?mailboxUid=/?folderUid=/?aggregate=` from them in an effect (they used to read `window.location.search` once on mount). A folder switch is a
    `search` change on the same page: nothing remounts, `InboxContent`'s list effect (its deps include `folderUid`) does the rest, and the push
    subscriptions/poll in `useMailLiveUpdates` (every folder, not the selected one) are never touched. Back/forward is `popstate`.
  - A page change runs `route.load()` first, then `pushState` + the swap in one commit (the old page stays up meanwhile, the content is
    `aria-busy`); a failed load (offline, or a deploy replaced the chunk) falls back to a real navigation - which is also how a stale tab recovers.
    A newer navigation overtakes an older one (sequence counter). One in-flight promise per route, dropped on failure so a later touch retries.
  - Prefetch: `pointerover`/`pointerdown`/`focusin` on a link to a route, and the four app-rail routes through `whenIdle()` (after the window `load`
    event, then `requestIdleCallback`; skipped for `navigator.connection.saveData`/2g). After a change `AppChrome` (keyed on `routeKey`) focuses
    `#app-content` (`tabIndex=-1`), scrolls to the top, sets `document.title` (`<brand>: <label>`, also on first load - the layout's title is
    "<brand>: Mail" for every page) and announces the page in a polite `role=status`. Full-window screens (`MailboxProvisioning`,
    `KeyEnrollmentGate`'s blocking cards) wrap themselves in `FrameTakeover`, which hides the frame's rail/header/banner/footer (kept mounted, so
    page state survives).
  - `LocalIndexLifecycle` stays inside `MailShell` (it needs the mailboxes and folders): it unmounts when you leave Mail and restarts on return
    (`buildLocalIndex` compares indexed versions, so that is incremental). Nothing polls for key destruction while on Calendar - the same as
    before, when Calendar was a different page.
  - Still full page loads: `/admin`, escrow, plugin pages (booking...), sign-out, "Return to admin", the setup-wizard redirect, the
    `window.location.reload()` recoveries, "Manage labels..." in the label menu (`labelMenu.tsx` is a plain function; not converted) and
    external links.
- **Per-folder snapshots (`shared/mail/listSnapshots.ts`, used by `InboxContent`).** A folder's listing as it was on screen (rows incl. load-more
  pages, selection, scroll) is kept in memory for 5 minutes (16 folders, keyed by mailbox + folder + conversation mode + filter + labels + sort).
  Going to a folder shown a moment ago (or back to Mail from another app) paints it on the click's own frame and revalidates behind it, folding
  the fresh page in with `mergeFirstPage()` exactly as a live refresh does; an uncached folder shows a skeleton (was a "Loading..." line). Search
  and aggregate views are not snapshotted. `test/apps/setup.ts` clears it (and the reply-body cache) after every test - both are module-level.
- **Bundle diet.** `ComposeContext` loads `ComposeWindow` with a hand-rolled loader (`prefetchComposeWindow()`), `ComposeToolbar` lazy-loads
  `EmojiPicker` (the 430 KB JSON), `ComposeWindow` imports `smimeMessage` at send time only, `MessageDetailPane`/`ConversationThreadPane` are
  `LazyReadingPane` chunks (the empty state renders without loading them), `MessageDetailPane`/`index.tsx` import `messageSecurity`/`searchTier3`
  at use, `LocalIndexLifecycle` imports `localIndexBuilder` when a build is due. In `react-shared`, `keys.ts` (x509), `passwordUnlock.ts`
  (hash-wasm) and `masterKeyWraps.ts` (smime) load lazily. `serverViteConfig.ts` (server repo) adds `codeSplitting` groups `react`
  (react/react-dom/scheduler) and `icons` (`react-icons/hi2` + `lib`; **not `bs`**: an all-`react-icons` group put the compose toolbar's
  Bootstrap icons into the initial chunk).
  **`React.lazy` + `<Suspense>` is wrong for an on-click pane**: a boundary that has shown its fallback holds the content back for up to 300 ms
  after the code arrives (React's fallback throttle), and `lazy()` starts its own load at first render, so prefetching the module doesn't help.
  Selecting a message cost +300 ms until `LazyReadingPane` (and `ComposeContext`) switched to a loader that reads the loaded component
  synchronously.
  Numbers (the inbox route's static graph, production build, the same `createServerViteConfig()`): **before 17 chunks / 2,014,028 B (brotli
  438,294)**; **after 25 chunks / 467,229 B (brotli 135,140)**, of which `react` is 219,010 B (58 KB brotli, cached across deploys) and the app's
  own JS is 248 KB (77 KB brotli). Largest eager chunks after: react 219 KB, www (the inbox page) 41 KB, shared 31 / 29 (dompurify) / 28 / 23 KB,
  icons 29 KB. Lazy and explicit: RichTextEditor 467 KB, EmojiPicker 430 KB, smime 330 KB, x509 161 KB, calendar 156 KB, localIndexWorker 103 KB and
  its 2.2 MB wasm (worker, at unlock). Top modules before (rendered bytes): pkijs 583 KB, react-dom 538, @emoji-mart/data 500, web-client 368,
  @tiptap/core 187, prosemirror-view 176, react-shared 155, @peculiar/x509 96, asn1js 93, prosemirror-model 77; after: react-dom 538, web-client
  260, react-shared 92, dompurify 62, react-icons 39. `dompurify` stays (`BrandingChrome` sanitizes the custom header/footer at first paint). The
  350 KB / 110 KB brotli target is not reached in total (React alone is 219 KB); it is met for everything but React (248 KB / 77 KB).
  **`strictExecutionOrder` still holds and the lazy crypto is safe**: `keys.ts` awaits `import("reflect-metadata")` before
  `import("@peculiar/x509")`, and `smime.ts` keeps `import "reflect-metadata"` first. The encrypted paths are unit-tested with mocks only - **a
  browser-level encrypted send/receive round trip was not run**.
- **Compose open latency.** Reply used to `await Promise.all([loadOriginalMessage(), ownAddresses()])` - `/content` (no timeout) then, for a
  plain-text message, `/raw` - before `openCompose()`. Now `openCompose({... pending})` opens **on the click's own frame** (the frame from
  `ComposeWindowPlaceholder` if the chunk isn't in yet); the window fetches its signature, draft and keys in parallel and mounts the editor as
  soon as the signature is here; `pending` (`ComposeLateInput`: the quote and better To/Cc) is folded in when it resolves. The quote is *appended*
  to the editor's document (`RichTextEditor` `appendHtml`, so what was typed above stays and the quote lands under the signature as before), To/Cc
  are replaced only if the reader hasn't touched them, and an untouched reply still isn't autosaved (`seededHtml` and the baseline follow). The
  body fetch has a 10 s timeout (`/raw` is raced against it) and is cached for 30 s; `prefetchOriginalMessage()` runs on hover/focus of
  Reply/Reply All/Forward next to `prefetchComposeWindow()`; the sidebar Compose button passes the shell's own mailbox (no `listMailboxes()` round
  trip first) and prefetches. `composePerf.ts` puts `performance.mark/measure` around the phases (`compose:<id>:click|shell|chunk|body|editor|draft`,
  measures `compose:click->...`) in dev, or in production with `window.__RAPIDMX_PERF__ = true`.
- **Measured (Edge through Playwright against a local sandbox server with the current static-asset compression, warm HTTP cache, medians of 2-3):**

  | | before | after |
  | --- | --- | --- |
  | folder switch (Inbox -> Sent) | 140 ms, a full page load | 38 ms |
  | back to a folder shown a moment ago | 155 ms | 19 ms |
  | app switch Calendar / Contacts / Tasks / Mail | 141 / 136 / 132 / 144 ms | 28 / 27 / 26 / 35 ms |
  | Reply: dialog visible / editor usable | 20 / 36 ms | 9 / 39-78 ms |
  | full page loads during 8 in-app actions | 8 | 0 |

  With 4x CPU throttling, 40 ms RTT and 20 Mbit/s: first list 1795 -> 1398 ms, load event 1346 -> 646 ms, repeat load 1567 -> 1160 ms, folder
  switch 1518 -> 173 ms, back to a folder 1540 -> 92 ms, app switches ~1310-1610 -> 100-274 ms, Reply dialog 155 -> 57 ms. With `/content` and
  `/raw` each held for 3 s (what a hung body looks like): dialog 6453 ms -> 15 ms, editor usable 6456 ms -> 53 ms. The idle prefetch pulls about
  775 KB more (calendar, contacts, tasks, the reading pane, the compose window with its editor) after `load`: 1.25 MB in all once it settles.
- **State that used to go with the page.** The mobile drawers (`MailShell`'s folder list, and the mailbox pickers of `ContactsShell`, `TasksShell`,
  `SettingsShell`) stayed open after a choice once the choice stopped reloading the page; each shell now closes its drawer when `useLocationSearch()`
  changes. Checked at 390 px: folder from the drawer, tap a conversation (`/messages/:uid` through the router - the conversation path still assigned
  `window.location.href` until the browser check caught it), back, no document request after the first. Anything else that assumed "a new page
  means fresh state" now survives a folder change on the same page. The one that mattered - a search followed the reader into the next folder and
  kept showing its results - is cleared when the folder (or mailbox, or an all-mailboxes entry) changes; the sort/filter/conversation settings stay
  (they are per mailbox and remembered anyway). Open menus close by themselves; expanded conversations and select mode are reset by the list
  effect. Nothing else was found in the pages or shells, but this was not audited exhaustively.
- **Harness gotchas (for the next person profiling).** A local build isn't served from `dist/public`: the plugin host builds the UI at server
  start into `plugins/.ui-build/<hash>/` and switches `react:manifestPath` to it (and `rapidrest dev` builds with `NODE_ENV=development`, i.e.
  dev React). Copy a production `vite build` over that folder, restart, and flush Redis (`ReactRoute` caches rendered HTML). `yarn dev`'s dev user
  is an admin: on a server that hasn't finished setup `AppShell` redirects to `/admin/setup` (`POST /api/system/setup/complete`). Google Fonts
  requests hang the load event in a sandbox - abort non-localhost requests. Never kill `msedge.exe` by name (it is JP's browser too).
- Tests: new `navigation/{routes,idle,AppRouter,AppRouter.ssr,frameContext}`, `routedPage`, `_mail/listSnapshots`,
  `_components/{LazyReadingPane,ComposeWindowPlaceholder,composePerf,ComposeContext.loader,ComposeWindow.pending,AppShell.frame}`; changed
  `quotedBody`, `ComposeContext`, `RichTextEditor.tiptap` and the page and shell tests that assumed a full load, a synchronous compose window or
  a "Loading..." line.
- Verified (with the `react-shared` `dist` overlay described in the 2026-09-20 entry above): `yarn tsc --noEmit` clean, `yarn lint` clean, `yarn vitest run
  --coverage` 192 files / 2961 tests passing, coverage 100 / 99.91 / 100 / 100 (statements / branches / functions / lines; the uncovered branches are the old
  ones - `MoveToFolderDialog`, `ComposeWindow`'s `e.target.files ?? []` and `mailboxUid ?? ""`, `index.tsx`'s label-effect `cancelled` check and the label-created
  ternary - plus one `current.version >= next.version` side in the live-refresh merge). The suite is load-sensitive: a first compose window opened in a test loads its chunk
  (`MessageDetailPane.test.tsx` warms it in a `beforeAll`), and a run alongside another `vitest` produced spurious timeouts in `index.test.tsx` that did not repeat alone.
  jsdom's `Range` has no `getClientRects`: adding content to a real TipTap editor (`appendHtml`) raised an asynchronous error that failed whichever test was running, so
  `RichTextEditor.tiptap.test.tsx` stubs it. Browser checks (Edge/Playwright, sandbox server): hydration without console warnings on a first load of every kind of route
  (`/`, `/calendar`, `/contacts`, `/contacts/:uid`, `/tasks`, `/messages/:uid` and eleven `/settings/...` pages); folder and app switching, back/forward, keyboard activation of a rail link (focus lands on `#app-content`), a compose
  window and its typed text surviving Calendar -> Contacts -> Mail, and the 390 px folder drawer. **Not checked in a browser:** plugin pages, impersonation, sign-out,
  the encrypted paths, the tap-a-message flow for a message with attachments, Safari/Firefox.

### 2026-09-20 (evening) — Keyboard shortcuts (Outlook-style) in every view, and the push connection hoisted into the app frame

Not committed. Nothing in `react-shared` or `server` changed (the work runs against the same `react-shared` overlay as the entries above). `electron-client`
got its own entry (explicit application menu so Electron's default accelerators can't swallow Reply / Reply all).

- **The layer (`shared/keyboard/`).** `ShortcutProvider` is mounted once in `AppChrome` (so it survives page swaps and covers Settings, and a page rendered
  outside the router still gets one from its own `AppShell`); `GlobalShortcuts` (the "Go to ..." set and help) and `ShortcutsDialog` sit beside it. One
  `keydown` listener on `document` (bubbling - what a widget handles itself and `preventDefault()`s is skipped) calls `dispatchKeyEvent()`. Views claim keys
  with `useShortcut(SHORTCUTS.mail.reply, handler, { enabled, container })`; **`SHORTCUTS` in `keymap.ts` is the only place a key is written down**
  (`ShortcutDef`: id, `keys`, `electronKeys`, label, scope, `allowOnActivatable`, `repeat`) and feeds the help dialog (`useRegisteredShortcuts()`), the
  tooltips (`withHint()`, `ariaKeyShortcuts()`, `useShortcutProps()`) and a test that pins the whole map. Handlers are read through a ref at event time, so
  a page swap changes what a key does with nothing re-wired; a handler returning `false` declines the key and the next registration (or nothing) gets it.
  Outside a provider `useShortcut` does nothing, which is why no existing component test needed touching. SSR-safe: the platform (`mac`, `electron` =
  `window.rapidmx` exists) is read in an effect (`SERVER_ENVIRONMENT` until then), hints render as Ctrl and switch to Cmd after mount.
- **Matching (`parse.ts`, `match.ts`).** Specs like `ctrl+shift+a`, `alt+n`, `Delete`, `?`, `mod+enter` (`mod` = Ctrl, Cmd on a Mac). `event.key` (lower-cased)
  first, so AZERTY/Dvorak follow the letter on the key cap; **`event.code` only when `event.key` isn't a Latin character** (macOS Option+N types `Dead`/`~`,
  Cyrillic layouts) - never when it is (Dvorak's R key is not the QWERTY R). Modifiers must match exactly; Shift is ignored for a printable symbol (`?`).
- **When a key is taken (`dispatch.ts`, `targets.ts`).** Skipped outright: `defaultPrevented`, `isComposing`/`Process`, bare modifier keys, and Copy/Cut/Paste/
  Select all/Undo/Redo/Find (`a c v x z y f` with Ctrl/Cmd, no Shift) - never bound anywhere. In a text field (input except button/checkbox/submit/reset/image/
  file/color, textarea, select, contenteditable, `role=textbox|searchbox`): bare keys, caret/delete keys with any modifier, Ctrl/Cmd+Shift+V (paste as plain
  text) and +Z (redo) are the field's; a Ctrl/Alt/Cmd chord works, **except Option-only on a Mac and Ctrl+Alt (AltGr) elsewhere, which type characters**;
  Escape works unless a popup it owns is open (`aria-haspopup` + `aria-expanded`, an expanded combobox) or it is in a popover dialog (`role=dialog` without a
  `data-shortcut-scope`: the emoji/GIF/send-later pickers, which don't handle Escape themselves). Outside a field a bare key isn't taken from an open menu/
  listbox/tab list/grid/...; Enter and Space are left to a focused button or link unless the shortcut says `allowOnActivatable`. A held key: a one-shot
  action runs once and the repeats are **swallowed** (preventDefault, no handler) so a browser doesn't reload on a held Ctrl+R; `repeat: true` (arrows) keeps
  firing. Scopes: `dialog` alone while any `[aria-modal="true"]` is in the document (react-shared's `Modal`/`Drawer`: DOM check, so no dialog had to change);
  else inside `[data-shortcut-scope="compose"]` (the compose window's root) `compose` then `global`; else the mounted view's scope (`mail|calendar|contacts|
  tasks`) then `global`; within a scope the latest registration first.
- **The decided key map** (Cmd for `mod` on a Mac; the nav set and `Ctrl+Q` stay Ctrl; Cmd+Shift is **not** offered for the nav set: Cmd+Shift+A/B/C/L/M/S are
  browser keys on macOS):

  | Scope | Keys |
  | --- | --- |
  | Global | `Ctrl+Shift+A` Account (only with `authServerUrl`; full navigation to `${auth}/account`), `+S` Settings (`/settings/auto-reply`, the same target as the menu item), `+B` Contacts, `+M` Mail, `+C` Calendar, `+L` To-Do; `?` / `Ctrl+/` help. Already on the page: no navigation, key still consumed. Electron: `Ctrl+Shift+T` Tasks too |
  | Mail | `Alt+N` new; `mod+R` reply, `mod+Shift+R` reply all, `mod+Shift+F` forward; `mod+D`/`Delete` delete; `E`/`Backspace` archive; `mod+Shift+V` move; `Ctrl+Q`/`mod+U` read/unread; `Insert` flag toggle; `Down`/`J`, `Up`/`K`; `Ctrl+.` / `Ctrl+,` next/previous unread; `Enter` open (`/messages/:uid`); `Escape` clear selection / leave select mode / clear search; `/`, `mod+E` search |
  | Compose (focus inside a window) | `mod+Enter` send, `mod+S` save draft, `Escape` close (existing keep/discard flow), `Alt+N` another message (same From) |
  | Calendar | `Alt+N` new event, `T` today, `Left`/`Right` and `mod+Left`/`mod+Right` previous/next period, `Ctrl+Alt+1..4` day/work week/week/month (no key for Split) |
  | Contacts | `Alt+N` new contact, `/`, `mod+E` search |
  | Tasks | `Alt+N` new task = focus the "Add a task" field (not in the Flagged email view, which has none) |
  | Electron only | `mod+N` (Ctrl+N; Cmd+N on a Mac) = the view's create key; `Ctrl+Shift+T` Tasks |

- **Who registers what.** `MessageDetailPane` (`shortcuts` prop) owns Reply/Reply all/Forward (`handleReplyOrForward`), Archive (`handleArchive`), Move to (opens
  the dialog) - registered only while the button exists (Archive not for Drafts/Outbox, Move only with folders); a key pressed while the action is running is
  consumed and does nothing (as the disabled button), so a browser never reloads on Ctrl+R meanwhile. `shortcuts` is passed by the one flat pane, the mobile
  `/messages/:uid` page, and - through `ConversationThreadPane`'s `shortcuts` - **only the opened (else newest) message of a thread**, never all expanded ones.
  `InboxContent` owns list-level keys and reuses `runBulkAction()` **exactly** (now `runBulkAction(action, removesRows, chosen = selectedMessages)`, resolving
  to success): Delete = `moveMessages` to `resolveFolderOfType("deleted_items")` (created on demand), Mark read/unread = `setReadStateMany` with the same
  `patchListedMessage`/`trackMessageChange`, Flag = `setMessagesFlagged` (flags all unless all already are). Targets: the ticked rows in select mode, else the
  open message, else - in the conversation list - every message of the open conversation in this folder (fetched with `listConversationMessages()`, cached like a
  ticked conversation's). The messages a key has nothing to do for are filtered out (already in Deleted Items, already read) and the key is still consumed. Not
  registered without a target, in an aggregate view (the bar isn't offered there), and the pane's keys are off in select mode. Moving the selection focuses the row
  (`data-message-uid` on rows, `data-row-open` on the row's button) and scrolls it into view; **after a delete/archive the next Down/J carries on from the removed
  row's index** (`removedAnchorRef`), so clearing an inbox from the keyboard walks down it. `Enter` on the selected row (or with focus on the body) opens
  `/messages/:uid`; on an unselected row it stays the button's click. A keyboard action's failure shows as an Alert above the list (`bulkError` was only shown by
  the selection bar). `MailShell` renders `MailShortcuts` (alt+n -> `openCompose({ mailboxUid })`, a component of its own for the reason `ComposeButton` is:
  `useCompose()` only resolves below `ComposeProvider`), `ComposeWindow` its four (container = its root, which carries `data-shortcut-scope="compose"`; Send/save/
  close guarded by the same conditions as the buttons/autosave - Ctrl+S never saves a message headed for encryption), Calendar/Contacts/Tasks their own.
- **Bug found and fixed on the way: Mark unread was undone at once for a message that was already read when opened.** `useMarkMessageRead` (and the thread pane's expand
  effect) only recorded "asked" for a message it actually sent a request for, so making an already-read open message unread re-ran the effect and read it straight
  back. Every opening is now recorded, read or not.
- **Skipped, because the feature doesn't exist:** **Shift+Delete / permanent delete** (there is no permanent delete or "already in Deleted Items" confirm in the
  UI - Delete is a move to Deleted Items, the bar disables it there, and `deleteMessage()` is only used for drafts; adding a purge is a product decision), and on
  the mobile `/messages/:uid` page everything list-level (Delete, mark, flag, next/previous: it has no list) - Reply/Reply all/Forward/Archive/Move work there.
- **Collisions found.** *Mine vs the editor:* the compose body is TipTap, whose bindings (defaultPrevented, so they win): `Ctrl+Shift+S` strike-through,
  `Ctrl+Shift+B` blockquote, `Ctrl+Shift+L` align left (TextAlign), `Ctrl+E` code, `Ctrl+U` underline - so Settings, Contacts and To-Do do not fire while the caret
  is in the compose body (Mail `Ctrl+Shift+M`, Calendar `Ctrl+Shift+C`, Account `Ctrl+Shift+A` do); a message body is a sandboxed iframe (`sandbox=""`, no scripts), which
  **forwards no key events**, so after clicking into a message body Ctrl+R etc. reach the browser (Tab/click the list first; not fixable without `allow-same-origin`).
  *Vs browsers (not verified in a browser, from documentation/knowledge):* Chrome/Edge - `Ctrl+Shift+A` tab search, `Ctrl+Shift+B` bookmarks bar, `Ctrl+Shift+C`
  Inspect, `Ctrl+Shift+M` profile menu, `Ctrl+Shift+S` (Edge web capture), `Ctrl+D` bookmark, `Ctrl+R`/`Ctrl+Shift+R` reload, `Ctrl+E` search box, `Ctrl+U` view source,
  `Ctrl+S` save page; Firefox - `Ctrl+Shift+A` Add-ons, `Ctrl+Shift+B/C/M/S`, `Ctrl+Q` quits on Linux; most of these normally reach the page first and can be
  prevented, unlike `Ctrl+N`, `Ctrl+T`, `Ctrl+W` (and the shifted forms), which are never delivered - hence `Alt+N`/`Ctrl+Shift+L`. Not "fixed" beyond that.
- **Task B - the mail connection moved into the frame (`shared/mail/useMailConnection.ts`).** The mailboxes + folder tree + `onFolderCreated` (moved out of
  `MailShell`), `useMailLiveUpdates` (socket, poll, counters overlay) and `useNewMailNotifications` are one hook, `useMailConnection({ userUid, enabled, open })`.
  `AppChrome` calls it with `enabled = useInAppFrame()`, provides the result as `MailConnectionContext`, renders `NewMailToasts` and keeps the tab title
  (`useUnreadTitle(count, { enabled: inFrame, resetKey })`, declared **after** the effect that sets `document.title` so a page change strips the count from the old
  title, writes the new one and puts the count back). `MailShell` reads the context (`hosted ?? own`, where `own` is the same hook with `enabled: !hosted`) and draws
  its own toasts/title only when not hosted - so a Mail page outside the router (tests, plugin pages) behaves as before and **no existing MailShell test changed**.
  Result: one socket for the tab across every app switch, pop-ups and the `(3)` prefix in Calendar/Contacts/Tasks/Settings, and going back to Mail shows the
  folder tree in the same render (no reload of mailboxes/folders). **Chose to hoist the counters overlay too** (it is fed by the same events, inside
  `useMailLiveUpdates`, so splitting it out would have needed the overlay re-fed through a second channel). Behaviour unchanged: same eligibility, dedupe,
  6 h cutoff, permission UX. Costs: the frame lists mailboxes and folders once per document even on a page that doesn't need them (Calendar/Contacts/Tasks shells still
  list their own too - not merged); a folder created/renamed elsewhere shows up in the sidebar via the push events (create) or on the next document load
  (rename/delete), where before each visit to Mail was a document load. `AppChrome` now imports `useNavigate` from the new **`navigation/routerContext.tsx`**
  (the router context and its hooks moved out of `AppRouter.tsx`, which re-exports them - no import changed) to avoid a cycle `AppRouter -> AppShell -> AppRouter`.
- **Test-suite lessons.** (1) `useSyncExternalStore` on the registry in an always-mounted dialog re-rendered the whole frame on every shortcut registration and
  shifted the microtask timing of two existing tests (calendar "clicking a day", tasks "blank title") - so `ShortcutsDialog` mounts its subscribing body only while
  open. (2) A `vi.spyOn(navigator, "platform")` outlives `vi.unstubAllGlobals()`; restore it explicitly (a test left it on `MacIntel` and every later `mod` was Cmd).
  (3) `fireEvent.keyDown` returns `false` when the layer took the key - that is the assertion for "prevented only when a handler ran".
- Tests: new `test/apps/keyboard/{parse,match,targets,dispatch,format,keymap,platform,appLinks,GlobalShortcuts,ShortcutsDialog,ShortcutProvider.ssr}`,
  `_components/MessageDetailPane.shortcuts`, `navigation/AppRouter.mailConnection`; extended `index` (list keys, conversation keys, aggregate), `ComposeWindow`,
  `calendar/contacts/tasks index`, `AppShell`, `MailShell`, `UserMenu`, `MailSelectionBar`, `ContactsToolbar`, `ConversationList`, `ConversationThreadPane`,
  `useMarkMessageRead`, `useUnreadTitle`.
- Verified (with the `react-shared` `dist` overlay described above): `yarn tsc --noEmit` clean, `yarn lint` clean, `yarn build` clean (incl. `checkDistReferences`), `yarn vitest run
  --coverage` 205 files / 3200 tests passing, coverage 100 / 99.91 / 100 / 100 (statements / branches / functions / lines; the uncovered branches are the old ones - `MoveToFolderDialog`,
  `ComposeWindow`'s two, `index.tsx`'s label-effect `cancelled` check, the merge `version` side and the label-created ternary - nothing in `shared/keyboard` or the new handlers). `tsconfig.test.json`
  still has its pre-existing type errors (`mockFetch` signature etc.); the new `test/apps/keyboard` files add none. **Not verified:** any of it in a real browser (which keys a browser
  actually delivers or reserves, macOS Option/Cmd behaviour, AZERTY/Cyrillic/Dvorak key events - only synthetic `KeyboardEvent`s with the `key`/`code` such layouts produce), the
  Electron menu against a real window (see `electron-client`'s NOTES), focus behaviour with a screen reader, and the compose editor's own bindings winning over the global chords.

### 2026-09-20 (QA) — acceptance test in a real browser against the committed code: five client defects fixed

Not committed. Playwright (Chromium) against a local sandbox copy of the server (production build, `node dist/src/worker.js`, mongo:7 + redis:7 in docker, stub auth-server, stub rspamd/clamd,
a fake `sendmail.exe`) whose `node_modules/@rapidmx/{restapi,react-shared,web-client}` were overlaid with the working trees (hash-compared file by file). Every requirement A-M was exercised; what
follows is only what was wrong. Numbers, the server-side finding (missing `notifications` datastore) and the list of what was proven against stubs are in the server's NOTES of the same date.

- **Takeover screens were left-aligned, not centred** (`FrameTakeover`, `navigation/frameContext.tsx`): inside the persistent frame `#app-content` is a flex row and a full-window screen ("Choose your
  mailbox address", "No mailbox available", "Protect your mailbox", the unlock cards) shrank to its content at the left edge. Now wrapped in `<div className="flex-1 min-w-0">` inside the frame (a
  block, so the screen's own `min-h-screen flex items-center justify-center` root fills it). Measured: card 32-480 px in a 1440 px window before, 496-944 after.
- **Ctrl/Cmd+Enter did not send from the compose body** (`RichTextEditor.tsx`): TipTap binds it to a hard break, and a key the editor handles is skipped by the shortcut layer, so it inserted a line break
  and sent nothing (it did send from To/Subject). `editorProps.handleDOMEvents.keydown` returns true for Ctrl/Cmd+Enter (ProseMirror stops handling it without preventing the event, which then reaches the
  window's shortcut); Shift+Enter is still a hard break. Test with a real TipTap editor in `RichTextEditor.tiptap.test.tsx`.
- **Enter on a list row never opened the message page after a click or j/k in conversation mode** (`ConversationThreadPane.tsx`): the thread's own "hand focus to the message the thread was opened at"
  effect ran after the list's `focusRow()` and took the focus, so Enter toggled a message header instead of opening `/messages/:uid`. The effect now leaves the focus alone when it is on a list row's
  `[data-row-open]` button *with a focus ring* (`:focus-visible`: a key press put it there); a click still hands the focus to the thread. Test in `ConversationThreadPane.test.tsx`.
- **The send-failure banner pushed Send out of the compose window** (`ComposeWindow.tsx`): the window is a fixed 520 px and clips, so with "Technical details" expanded the Send button ended 26 px below its
  bottom edge and could not be reached (or scrolled to). The alerts wrapper is now `shrink-0 max-h-[45%] overflow-y-auto`. Measured Send bottom 926 -> 892 in a window ending at 900.
- **DNS checklist: record names wrapped one letter to a line** (`DomainDnsSetup.tsx`): beside the DKIM key (which breaks anywhere) the auto-width table gave the name column a few characters
  (`mai / l._d / omai / nke...`). The name cell has `min-w-[10rem]` (167 px measured).
- **Not fixed, observed:** (1) the new-mail toast sits over the account menu button (top right) for its 8 s; (2) with nothing selected the `?` dialog lists only the keys registered at that moment (New
  message, next/previous), not Reply/Delete/Mark read... which appear once a message is open - it does list them all then, with the right glyphs; (3) after Ctrl+U the reading pane closes in conversation
  mode (the bulk action reloads the list); (4) in conversation mode there is no search box, so `/` has nothing to focus (it works in the message list); (5) the first paragraph of a conversation row's
  address shrinks the display name to nothing before the local part at 390 px (the domain stays whole, as specified); (6) `ReactRoute` caches the rendered page per path and uid only, so props that come
  from cookies (`impersonating`) can be stale for a moment for the same uid (a real impersonation changes the uid); (7) Ctrl+Shift+S/B/L inside the compose body still belong to TipTap (documented above).
- Verified: `yarn tsc --noEmit` and `yarn lint` clean, `yarn vitest run --coverage` 205 files / 3203 tests, coverage 100 / 99.91 / 100 / 100 (the same figures as before; the threshold caught an uncovered `catch` in the focus-ring helper, now tested); every fix re-checked in the browser after a rebuild of the sandbox. react-shared 92 files / 1174 tests and restapi 262 / 5371 pass on the same trees; electron-client tsc, lint and 54 tests pass.

### 2026-09-21 - One notification system, sending that doesn't wait, and encryption that fails open (W-C)

Not committed. Needs the sibling `react-shared` change of the same date (see its NOTES; unpublished: `queueMessageSend`, `sendEvents`, `setApiUnauthorizedObserver`) - same overlay recipe as the 2026-09-20 entry (`yarn build` there, `cp -r dist/. ../web-client/node_modules/@rapidmx/react-shared/dist/`) - and, for the background send, the `@rapidmx/restapi` work R1 finished in parallel (its final contract is what this is written to; **not integrated against a real server** - only unit tests, mocks and the browser harness's stub).

**1. The notification system (`apps/shared/notifications/`).** One store, one view, one API - `NewMailToasts` and `useNewMailNotifications`'s own stack are gone (the hook now only decides *what* is worth announcing and calls `notify()`; the desktop notification, permission UX, the "New mail pop-ups" switch, 140-char preview and eligibility rules are unchanged).
- API (framework-free; a hook, a plain function or an `apiFetch` error path all call it): `notify({ id?, kind: "mail"|"info"|"success"|"warning"|"error", title, subtitle?, message?, preview?, hint?, details?: string[]|string, actions?: {label, onClick?|href?, keepOpen?}[], href?, sticky?, timeoutMs?, dedupeKey?, history? }): id`, `update(id, patch)`, `dismiss(id)`, `dismissAll()`, `useNotifications()` (`visible`, `queued`, `history`, `unseenErrors` + the functions), `notifyApiError(err, context, options?)`, `notifySessionExpired()`, `notifySystemError()`. `store.ts` holds every rule so they hold whoever renders; `NotificationCenter.tsx` only draws.
- Rules: **max 3 visible** (`MAX_VISIBLE`), the rest queued (max 20; a queued non-sticky one older than 30 s is dropped - news from the past - but is still in the history); a **sticky** one (errors, anything with `actions`, or `sticky: true`) that finds the stack full evicts the oldest one that would have gone by itself, else waits; default times mail 8 s / info 6 s / success 5 s / warning 10 s; `sticky:false` overrides (the new-mail pop-up with the desktop offer has actions and still goes by itself); **clocks stop** on hover/focus (`setPaused`) and while the tab is hidden (`setAllPaused`) and resume with what was left; **dedupe** by `dedupeKey` (same key on screen or queued = one pop-up, content replaced, clock restarted, `count` up - shown "x3"; an explicit `id` is a replacement, not a count); `update()` restarts the clock and recomputes stickiness when the kind or actions change (`update(id, {kind: "success", actions: []})` resolves an error), and still updates the history entry of one that already went; **history**: last 30 (not `mail` - the inbox holds those) in memory + `sessionStorage` (`rapidmx-notification-history`), `unseen` per entry, `unseenErrors` count; details capped at 50 lines x 500 chars. **SSR**: `notify()` does nothing without a `window` (module state is shared between requests on the server) and `useSyncExternalStore` has an empty server snapshot; the history is read from storage on first client use *without* notifying (it runs during a render).
- **Position (decided, verified in Edge at 1440 and 390 px - see below): top right, directly under the header row.** `NotificationCenter` is rendered by `AppChrome` right after the `<header>` as a zero-height `sticky top-[max(var(--rr-header-h,0px),2.5rem)] z-[60]` line whose child is absolutely positioned at `-top-1 right-0` with `p-4` (room for the shadow: a scroll box cuts it off in a visible grey edge otherwise; flush with the window's edge - a negative offset made the page scroll sideways); so it starts below the header and, as the page scrolls, sticks just below the sticky header - **`--rr-header-h`**, published on `<html>` by `useHeaderHeightRef()` (`notifications/headerOffset.ts`: a ref callback on the header, ResizeObserver + window `resize`, "0px" when the header goes) from both the plain title bar (`AppChrome`) and `FrameBrandingHeader` (a branded header is any height and wraps on a phone) - never less than 2.5 rem, which clears a full-screen compose sheet's own title bar. Verified in Edge with a 96 px custom header and the default 64 px title bar, scrolled 600 px, at 1440 and 390: the stack sits flush under the header, nothing over the account button. The account menu is `z-[70]` (UserMenu, was `z-50`) so it stays above the stack (60) when open. Pop-ups take the opaque colours back for themselves (`.rr-toast-in` in app.css's opaque list, `rr-solid` on the "N more waiting" pill) so they stay solid over a background photo. Compose windows are bottom-right, the far end of the screen; z-index 60 keeps a pop-up above the compose sheet (50). Its height is capped to the room above the open compose windows - `max-h-[max(8rem,calc(var(--rr-compose-top,100vh) - max(var(--rr-header-h,0px),2.5rem) - 2rem))]`, `--rr-compose-top` being the top edge of the compose windows, published on `<html>` by `ComposeProvider` (removed when the last window closes) - and scrolls inside itself, so it never covers a compose window's title bar and Send. It does cover the top right of the content for its few seconds - the list toolbar / reading pane's top - and a stack of three tall error pop-ups can reach a very tall (expanded) compose window; both accepted.
- **Live regions.** Two always-mounted containers with `aria-live` (`assertive` for errors, `polite` for the rest) and **no role of their own**, and each pop-up carries `role="alert"` (error) or `role="status"` - so a screen reader announces by kind, and the empty containers add no `alert`/`status` to the page (an always-mounted `role=alert` region made every existing test that does `getByRole("alert")` ambiguous - that is why). `prefers-reduced-motion`: the entrance animation is `.rr-toast-in` (already inside `no-preference`), the Outbox pill's dot is `.rr-sending-dot`, also inside it. Escape on a focused pop-up dismisses it (`preventDefault`, so the shortcut layer skips it). No global shortcut to focus the stack (optional in the brief; not done).
- **Where it is fed.** `AppChrome` mounts `NotificationCenter` and `NotificationHistoryDialog` ("Recent notifications" in the account menu, with a red count and a dot on the menu button while errors are unseen; opening it marks everything seen but the errors that were unseen stay highlighted until it closes), registers `setApiUnauthorizedObserver()` (react-shared: any `apiFetch` 401 -> **one** "Your session expired" with a **Sign in** action, `${authServerUrl}/auth/signin?return_to=...`, else a reload) and `setSignInUrl()`; `NotificationCenter` itself installs the top-level `error`/`unhandledrejection` handlers -> **one** deduped "Something went wrong" (message, `Where:` and the top of the stack as details; a cancelled request, an already-handled 401 and `ResizeObserver loop` are ignored); `useMailConnection` -> `usePushConnectionNotice()`: a sticky info "Live updates are paused" after **>10 s** in `reconnecting`, dismissed the moment the socket is `open`, shown once per outage (dismissing it does not bring it back), not in the history.
- **`notifyApiError(err, context)`**: `ApiRequestError` -> a sticky error titled `context` with the server's message and expandable details (`Status: 502 (api-9)` + `describeSendFailure()`'s lines), deduped per context+status; 401 -> the session pop-up; a `TypeError`/network failure -> "The server couldn't be reached"; anything else -> "Something unexpected went wrong" with what it was; `AbortError` (by `name`, since jsdom's `DOMException` is not an `Error`) -> nothing (returns `""`).
- **Converted** (by a helper agent, see its list in the release notes' "Fixes"): the keyboard-action and bulk-action failures above the message list (`bulkError`), `MailSelectionBar`'s error, contact/event/task/list saves and deletes, settings saves (auto-reply, read receipts, filters, signatures, privacy export/upload, sharing, unlock-method removal), calendar/contact/task list creation. **Kept inline**: field validation, load errors that replace a pane (with Retry), errors attached to an open form/dialog (`EventModal`, `ContactForm`, `MoveToFolderDialog`, `NewLabelDialog`, the tasks quick-add, the account-erasure confirm, most of the encryption settings), `KeyChangeReview`. Not converted: the admin/escrow consoles (no `AppChrome`, so no host), `MessageDetailPane`/`ConversationThreadPane` (W-B's; their `<Alert>`s are still there - convert with `notifyApiError` when that work lands).

**2. Sending that doesn't wait (`apps/shared/mail/outbox/`).** `ComposeWindow.submit()` is now: (1) validate synchronously from what the window knows - a recipient is required; `decideSend(..., lookupsComplete: false)` refuses (inline banner, window stays open, unlock prompt when the cause is locked keys, override buttons) a message that must be signed/encrypted and can't be (keys locked, Bcc on an encrypted message, a recipient known to have no key, an attachment/inline image that can't be signed); an attachment still uploading is **waited for inline** ("Waiting for attachments to finish uploading..." in the status line, Send disabled; `uploadsInFlightRef` + a macrotask so the editor has put an uploaded image into the body); (2) `startSend(snapshot)` and `onClose()` **in the same tick** - `submittingRef` is set before any `await`, so a double click, the held shortcut and `startSend()`'s own one-send-per-draft check (`beginPendingSend()`) mean one send; (3) everything else runs in `sendJob.ts`, which the closed window can't disturb: wait for the window's in-flight saves, give a mailbox/policy the window never loaded up to 4 s (`CONTEXT_GRACE_MS`, invisible), look up recipients' keys **only when it can matter** (a key exists and encryption was asked for or the loaded policy auto-applies), `decideSend()` again with the lookups in, assemble (plain `assembleDraft`, or sign/encrypt in the browser and `assembleDraftRaw`), set the read receipt, then `queueMessageSend()` (`POST .../send {background:true}`) - or `sendMessage(uid,{scheduledSendTime})` for Send later, which goes through the same pipeline now (the window closes at once for it too; a "Message scheduled" pop-up says when).
- **Failure at any stage** = sticky error "This message wasn't sent" (id `send-failed:<draftUid>`), message `To a@b.c and 2 others - "Subject": <plain reason>`, expandable details (`describeSendFailure()`), actions **Retry** (`retrySend()`; first asks the server whether the earlier request actually landed - out of Drafts or leased - and if so says "already on its way" instead of sending twice; a POST that timed out gets the same check before it is called a failure), **Open draft** (`openComposeFromOutside({resume})`: a window on the *same server draft* with every field, the html, attachments, receipt/sign/encrypt choices exactly as typed - kept in `sendState.retained` (25, this tab) even for a message that was encrypted before it was stored), and for a refusal the override button by name ("Send without encryption") and **Unlock** (opens the app's one unlock prompt through `UnlockBridge`) - retrying after an unlock. The draft is never deleted or emptied by a failure.
- **After the 202** the message is the server's. `send-succeeded` -> dismiss that message's failure/retry pop-ups + one short "Message sent" (id `message-sent`, several within 6 s = "3 messages sent", never a stack) **only for a message this tab queued** (`sendState.retained`): the server reports every message its job relays, scheduled ones from long ago and other tabs' included, and those are quiet; `send-retrying` -> one subtle info "Retrying to send" (id per message, replaced by later attempts, `attempt+1`, next time, the server's reason); `send-failed` -> the same sticky error with **Retry** (R1's final contract: a failed message *stays in Outbox*, so Retry is just `queueMessageSend()` on it again - the server queues it afresh with a new retry budget; counted in the pending set meanwhile) and **Open draft** (moves it back to Drafts with `cancelScheduledSend()` - allowed for a failed message, the server only refuses a move while a lease is running (`assertNotInFlight()`) - then resumes from the retained request, else from the server's own copy via `loadOriginalMessage()`; an encrypted message with no retained request only says it can be opened from Drafts).
- **`beforeunload`**: `pendingSends.ts` holds the sends whose *client-side* work is unfinished (assembling/encrypting, the request); while any exists the tab asks "Leave site?" and Sign Out's `flushComposeDrafts()` waits (up to its 3 s) for them; once the server has answered 202 the entry is gone and leaving is safe. `pendingSends`, `sendState` (retained requests, the Outbox tracker, the "sent" burst) and the notification store are reset after each test in `test/apps/setup.ts` - **`sendState.ts` has no imports on purpose**: the first version of the reset lived in `sendJob.ts`, whose imports (`keySession`, ...) got loaded by the setup file *before* a test file's `vi.mock` ran, so `ComposeWindow.test`'s mocked `getUnlockedKeys` never reached the job. Keep setup-file imports dependency-free.
- **Outbox item states (`outboxItemStatus()`), per R1's contract:** sending = a lease running, or a *due* `scheduledSendTime` with no `scheduledSendAttempts` (a background send is queued as an ordinary due message, `scheduledSendTime` = when it was queued - judged due by the clock **or** by being within 2 s of the message's own `dateModified`, so a browser clock running behind doesn't read it as "scheduled"); retrying = `scheduledSendAttempts > 0` with a later `scheduledSendTime`; failed = `scheduledSendError` set and no `scheduledSendTime` (and no lease); scheduled = a future time, no attempts. A permanent failure (spam/malware 422, every recipient refused 5xx) is final on the first attempt (no `send-retrying` first). `queueMessageSend()` falls back to the ordinary synchronous send on a 501 (a route class with no send job).
- **Outbox indicator.** `OutboxBadge` (in `MailShell`, replacing the plain count for `outbox`): a pill with the folder's total; an animated dot + accent while anything is in flight, red (`bg-danger`) while a message failed and is waiting, plain otherwise; `aria-live="polite"` and sr-only text "2 messages sending" / "3 messages, 1 failed" / "2 messages scheduled". The number: `startSend()` puts an **optimistic +1** on the Outbox folder's count through `folderCounts.track()` (registered by `useMailConnection` as `sendState.countTracker`), `settle()`d at the 202 (which re-reads the folders - the Outbox is created lazily by the server, so a folder that appeared is added with `onFolderCreated`) or `revert()`ed on failure; the folder events / poll then carry absolute values as before. Before the Outbox folder exists a synthetic, non-link "Outbox" row shows the pending count. `useOutboxStatus()` reads an *occupied* Outbox's messages (50 max) and derives sending / retrying / failed / scheduled from `scheduledSendError`, `scheduledSendLeaseExpiresAt`, `scheduledSendAttempts`, `scheduledSendTime` (`outboxItemStatus()`), re-reading on count/`live.tick` changes; an empty Outbox costs nothing. The flat message list's rows in the Outbox (`apps/www/index.tsx`) carry a state line (`OutboxRowStatus`: "Sending...", "Retrying (attempt 2, 10:15)", "Not sent: <reason>" in red, "Scheduled for ..."). **Not done:** the same line in conversation mode (`ConversationList`), and Retry / Open draft *buttons* on a failed row (they are on the failure pop-up; `MessageDetailPane` - W-B's - already shows "This message wasn't sent: <error>" and Move to Drafts for a failed Outbox message).

**3. Encryption fails open (`compose/encryptionRequirement.ts`, `outbox/sendDecision.ts`).** JP's rule, implemented as one pure function: a message is **plain** (its draft saves, Close and Send work, nothing about encryption is shown) unless encryption is *actually in play*: (a) the user asked (the "Encrypt this message" box, or a reply to encrypted mail - local knowledge, no request needed), or (b) the encryption policy **loaded successfully**, the sender has a key (enrolled on the mailbox, unlocked in this tab, or offered earlier), there are recipients, **every** recipient's lookup succeeded and `decideMessageEncryption().autoEncrypt` (policy `automatic` for the tier, both sides "mutual", a key found). A failed, slow or pending policy/mailbox/lookup is *unknown* and unknown = unencrypted; a user with no key, or a policy of optional/prohibited, never sees any encryption-check message. Removed: `cryptoContextReady` gating of Send/autosave, `cryptoLoadFailed`, `exhaustedLookups`, the "encryption settings couldn't be checked" banner and its Retry, `CHECKING_CLOSE_MESSAGE`, `NO_RECIPIENTS_CLOSE_MESSAGE`, the Retry in the close prompt. Loads retry silently with a longer backoff (1, 2, 4, 8, 15, 30, 60 s).
- **Transition rules** (a later load turns a plain message into an encrypted one - policy arrives, a slow lookup answers, a recipient is added): autosave stops at once; **a plaintext copy this window already saved is replaced by an empty draft** (`scrubSavedDraft()`: `assembleDraft(uid, {to: [], subject: "", html: ""})` chained after any save on the wire - same uid, so attachments and folder are undisturbed; a failure raises one warning "An earlier draft copy is still saved"); Close asks the existing "Encrypted messages aren't saved as drafts" question; Send encrypts, or is refused with the override - never silently plaintext once the requirement is known. And back (a recipient removed): autosave simply resumes.
- **At send time** the job waits (in the background, up to 4 s) for a mailbox/policy the window didn't have, then applies the same function to what it has: still unknown = plain and it goes. **The one place unknown blocks** is a message the user *explicitly* asked to encrypt whose recipients' keys can't be looked up (or whose mailbox can't be loaded): they asked for encryption and it can't be delivered, so it is refused with "Send without encryption" - a pop-up, since by then the window has closed.
- Reasoning: the requirement never was the enforcement point (keys are the user's, the server never sees them; the server does not check that a message was encrypted) - it only stops *this client* storing a plaintext draft or sending plaintext where the server's policy says otherwise. A flapping gateway made it fail closed and lose drafts for every user, including the many with no encryption at all, to protect the few with a policy that auto-encrypts; the cost of failing open is a plaintext draft/send in the window where the policy hasn't been learnt yet (a slow first second of a compose window, or an outage), bounded by the scrub, and by encryption asked for by the user never failing open. Consistent with the old rule where the policy *is* known.

**Tests.** New: `test/apps/notifications/{store,NotificationCenter,apiErrors,pushStatus}`, `_components/{encryptionRequirement,ComposeWindow.background}`, `_mail/{sendDecision,sendJob,sendOutcomes,pendingSends,outboxBridges,useMailConnection.outbox}`; changed `ComposeWindow` (the failed-send group and every fail-closed test rewritten to the fail-open contract, plus close-at-once, double-send and pending-send `beforeunload`), `useNewMailNotifications`, `useMailLiveUpdates` (+ssr), `MailShell` (Outbox pill and synthetic row), `UserMenu`, `AppShell`, `setup.ts`, and the helper agent's list (index, MailSelectionBar, the three sidebars, contacts, calendar drag, tasks, settings pages).

### 2026-09-21 - admin console: administrative metadata only, "Impersonate this user", Sharing through the audited endpoints (privacy: no role reads another user's mail)

Server side and policy: `@rapidmx/restapi` NOTES (2026-09-21 PRIVACY). Client: `apps/admin/index.tsx` (`listMailboxes({ scope: "admin" })`), `apps/admin/mailboxes/[uid].tsx` (`getMailbox(uid, { scope: "admin" })`, a note that
the console shows administrative details only, **Access this mailbox -> Impersonate this user** and the modal text, an ownerless mailbox hints at "add yourself under Shared access"), `apps/admin/quarantine` and
`ingest-queue` (`scope: "admin"`), `SetupWizard`'s mailbox step (`scope: "admin"`, so it lists every mailbox that exists), and `ShareAccessCard` rewritten on `mailboxAccessApi` (`listMailboxAccess` /
`setMailboxAccess` viewer|manager / `removeMailboxAccess`): members with a Read only / Full access label, revoke on any mailbox, and on an OWNERLESS mailbox a grant form with an access-level select plus
**Add me** (`currentUserUid`, from `AdminShell`'s `userUid`); a mailbox with an owner has no grant form (the server answers 403 to an administrator's grant). It used the generic `/acls` endpoints, which the
server now refuses for a mailbox's ACL. **No webmail change:** every other `listMailboxes`/`getMailbox`/`listResourceMailboxes` caller (mailbox switcher, folder tree, all Settings pages' Mailbox dropdown, calendar /
contacts / tasks shells, compose, reading pane, outbox job, encryption page) keeps the plain call and, with the server fix, lists own + shared mailboxes only. Tests: `test/apps/admin/**` (index, mailboxes/[uid],
_components/ShareAccessCard rewritten, quarantine, ingest-queue, setup) - admin subset 50 files / 465 tests, `ShareAccessCard` + `[uid].tsx` 100% statements/branches/functions/lines. Not run: the full suite (other agents
are editing the frame, reading pane and compose right now).

### 2026-09-21 - A custom header replaces the title bar, the flush rail icon, and Appearance (theme colours, background, colour scheme) (W-A)

Not committed. Needs `@rapidmx/react-shared`'s next release (`appearance/preferencesApi.js`) and the server/restapi appearance work (the `appearance` page prop, `/mail/preferences/appearance...`); without them the page still works (the provider's lookups fail quietly and the browser's cache is used).

- **Custom header (`BrandingChrome.tsx`, `AppShell.tsx`).** `Branding.headerHtml` set = the app has no title bar and the rail has no icon; `{USER_MENU}` / `{APP_TITLE}` are written in the header's or footer's *text*. `parseBrandingHtml()` sanitizes with DOMPurify (`RETURN_DOM_FRAGMENT`, `FORBID_ATTR` gains `data-rr-slot` so an author can't forge a slot), walks the text nodes and swaps a variable for `<span data-rr-slot="user-menu|app-title">`; React portals the menu / the title text into those spans (`BrandingHtml` finds them in a layout effect). Decisions: `{USER_MENU}` **once** (first hostable occurrence in the header, else the footer, else a right-hand cell in the header - never lost), later copies and ones inside `<a>` or raw-text parents are removed; `{APP_TITLE}` **every** occurrence; only exact upper-case `{NAME}` in text, never attributes. **The parse runs in a layout effect (`useBrandingHtml()`), never while rendering**: the server has no DOM to sanitize with, and rendering different HTML on the server and in the hydrating client leaves the header out (React doesn't patch `dangerouslySetInnerHTML`). It returns `undefined` while unparsed and the frame treats that as "custom header" already (`customHeader = header !== null`), so no title bar flashes. The frame takes the server's `branding` page prop (`AppShellProps.branding`, picked by `AppRouter.pickChromeProps`) until `useBranding()`'s own fetch answers, for the same reason. `BrandingHeader`/`BrandingFooter` keep their old `{ branding }` API for shell-less pages (the booking plugin imports them); the frame uses `FrameBrandingHeader`/`FrameBrandingFooter`.
- **Sanitizer check (restapi is read-only).** A one-off script with restapi's exact `sanitize-html` config: plain-text `{USER_MENU}`/`{APP_TITLE}` survive untouched (also `href="{USER_MENU}"`), inline `style` survives (normalised), `title` attributes are dropped, comments are dropped. DOMPurify keeps them as well (unit tests).
- **The menu can't be clipped.** `UserMenu` draws its drop-down through a portal into `<body>` with `position: fixed` (`z-50`), measured from the button on open and on resize/scroll (`placement="up"` in a footer). The outside-click check looks at the portalled menu too.
- **Header is sticky, in every app.** `FrameBrandingHeader` is a `<header class="sticky top-0 z-30">` (the frame scrolls as a document - `min-h-screen`, not `h-screen`, see the 2026-09-16 entry); the plain title bar is sticky too.
- **Flush rail icon (`RailIcon.tsx`).** The rail's first child is a `h-16 w-full` block (no padding above; the rail is `pb-3` without a custom header, `py-3` with one) with the title bar's border continued under it. Measured in Edge (Playwright): the first visible pixel row is 0 at 1280 wide, in a fixed-height frame (`height:100vh; overflow:hidden`) and with a footer; before, 12 px of rail padding plus the default logo's own 6 px. The default `logo.svg` has ~4% empty margin inside its viewBox, so the block **measures the file** (canvas, 63 px square, `object-fit: contain`) and raises the image by the empty rows above its first visible pixel (`transform: translateY`; hidden until measured; 0 for a tainted canvas or a load failure). Mobile is unchanged (the rail is `hidden md:flex`, the bottom tab bar is react-shared's).
- **Appearance = one `<style id="rr-appearance">` + `<html data-theme>` (`shared/appearance/`).** `theme.ts` (pure) turns `AppearancePreferences` into CSS: the user's colours as `--rr-color-*` custom properties declared `!important` for the light set (`html:root:not([data-theme="dark"])`), the dark-by-media set (`html:root:not([data-theme])`) and the explicit dark set (`html:root[data-theme="dark"]`); a `!important` custom property beats any rule, however specific, so **defaults < branding stylesheet < user** holds for tokens, while the branding sheet's own *rules* (unlayered) still win their elements. `color.ts` is the dependency-free colour maths (sRGB mix, WCAG contrast, `ensureContrast`, `deriveScale`: dark/darker/darkest = mix with black 20/40/55%, light/lighter/lightest = mix with white 20/40/60%). Text on `primary` is white while that reaches AA (a `.bg-primary.text-white` rule makes components that hard-code `text-white` follow); on `accent` the app's dark text.
- **Background layer = `html::before` (picture/colour, `position: fixed; z-index: -1`, box grown by 2x blur so blurred edges fall outside the window) + `html::after` (dim = the scheme's surface colour at `dim`)**, rewritten with the rest of the stylesheet - no markup, no component, no layout shift, works from the first byte of a server-rendered page. Panels: with a background `--color-surface`/`--color-surface-alt` are the surface colour at an alpha (`--rr-panel`), `#app-content` is itself one such panel and sets `--color-surface: transparent` for its children (so panels never stack into an opaque slab; inputs keep a solid surface), `.rr-frame-bg` (the frame root) is transparent, and `[role=menu|dialog|listbox]`, `.rr-toast-in`, `.rr-solid` (the sticky title bar), `[data-branding-header]` (the sticky branding header) and the phone's bottom tab bar reset both tokens to the opaque colours (app.css) - anything that stays put while a page scrolls under it must not be see-through. `@media (prefers-reduced-transparency: reduce)` makes every panel solid. **The alpha is computed** (`panelAlpha()`): the lowest 0.5-0.96 for which text and (a stronger, background-mode) muted text keep 4.6:1 against the worst place behind a panel, `mix(surface, photo, (1-alpha)(1-dim))` for the photo's darkest and lightest twentieth (`photo.ts` draws it at 32 x 32 on a canvas; not measurable, e.g. cross-origin without CORS = black and white). Looked at in Edge on a bright, a dark (darkened), a busy and a foggy photo in both schemes: text is legible everywhere, panels are ~0.5-0.7 opaque for photos, up to ~0.9 on a busy one.
- **No flash.** The server's `_layout.tsx` (www, admin, escrow) renders `<AppearanceHead>`: the same stylesheet from the `appearance` page prop (`data-key` = the normalised prefs JSON, `data-t` = its `updatedAt` in ms) and `APPEARANCE_BOOT_SCRIPT`, a plain ES5 inline script that applies the `localStorage` copy (`rapidmx-appearance`: prefs, finished CSS, mode, `t`, account, measured lightness) before the first paint. **Which copy wins:** the server caches a rendered page for up to 60 s (R1), so the page's prop can be stale; the copy with the newer time wins (`t` vs `data-t`; after a reset the cache keeps an *empty* stylesheet as a tombstone rather than being removed, or the stale page would bring the background back). The cache is per account (`<html data-uid>`), cleared on sign-out. Every storage access is in try/catch. `AppearanceProvider` also asks the server (`GET`) once mounted in the persistent frame (not in a plugin page that renders its own chrome, not in admin/escrow) and applies the answer unless the user changed something meanwhile.
- **Saving (`AppearanceProvider.tsx`).** Optimistic: `setPrefs(patch)` merges, applies at once and queues a save (400 ms of quiet, coalesced, one request in flight); the request is `diffAppearance(serverCopy, next)` - **only what differs, in the merge form R1's `PUT` takes** (`colors: { primary: null }`, `colors: null`, `background: { kind: "none" }` - never `background: null` - and never `imageVersion`, `kind: "image"` only for the image the server holds, so a slider moved during an upload can't 400). A failure rolls back to the last acknowledged copy and sets `error` (shown on the page). Upload: a `blob:` URL preview (measured at once) until the stored image has loaded, then the swap; `remove` = DELETE; `reset` = DELETE if there is an image + a diff to the defaults. Another tab/device: `AppearancePreferences...` push events (`getPushClient().onEvent`), ignored while this tab has a change in flight and when they say what is on screen.
- **APIs.** `useResolvedTheme(): "light" | "dark"` (`resolvedTheme.ts`; `useSyncExternalStore` over `matchMedia` and an observer of `<html data-theme>`; needs no provider; `"light"` on the server) and `useAppearance()` (`{ prefs, resolved, backgroundUrl, measured, isDefault, saving, error, clearError, setPrefs, uploadBackground, removeBackground, reset }`; inert outside a provider). `useSystemPrefersDark()` is the media query alone (the provider sets `data-theme` from it).
- **Settings > Appearance** (`www/settings/appearance`, first in `SETTINGS_SECTIONS`, `_routes.ts`): `AppearanceForm` + `ColorField` (picker + hex field: a full `#rrggbb` applies while typed, a short one on blur, junk on blur is dropped; "Reset" per colour), dim/blur sliders, fit, drag-and-drop or Choose image with validation *before* upload (`validateBackgroundFile`: PNG/JPEG/WebP/AVIF, <= 8 MB, non-empty), contrast warnings (`contrastWarnings()`: text/surface and on-accent text, < 4.5:1, never blocking; drawn in the warning colours so they stay readable when the user's theme isn't), "Reset all". `invertDarkMessages` was in the first contract and is gone (HTML mail is rendered faithfully; only plain text follows the theme).
- **Admin Branding page** documents the variables (help text and a copy-able snippet under both fields). README has the variables table and an Appearance section.
- **Not done / found.** (1) `NotificationCenter`'s connection pill (`bg-surface`) is translucent over a background; it sits outside `#app-content`. (2) Components that hard-code `text-white` on `bg-primary` follow a chosen primary through one CSS rule, not individually. (3) The mail `Composer` windows are `role="dialog"` so they stay opaque; the message body iframes are W-B's. (4) In Electron the CSS `url()` of the stored background is a cross-origin request without cookies when the API is on another origin - the server requires the owner's session for the image, so the picture only shows where the renderer shares the API's cookies. (5) A user's `text` colour applies in both schemes (an explicit choice; a warning says when it can't be read).
- **The default logo asset** (`server/public/images/logo.svg`) has margin inside its viewBox; the runtime trim handles it, but trimming the asset would make the first paint exact without the measure (server repo, not touched).
- **Public API kept.** `BrandingHeader`/`BrandingFooter` still take `{ branding }` (the booking plugin imports them; they render a plain block, no menu, `appTitle` optional); the frame's own are `FrameBrandingHeader`/`FrameBrandingFooter`. `RailIcon` measures only where an image can be decoded (`canMeasureImages()`: not jsdom, not the server) and otherwise shows the icon at once - so no shell test sees a late state update.
- **Test notes.** New: `test/apps/appearance/*` (color, theme, photo(+ssr), appearanceCache, bootScript, resolvedTheme(+ssr), AppearanceProvider, AppearanceHead, ColorField), `_components/{RailIcon,UserMenu.placement,AppShell.branding}`, `settings/appearance/index(+ssr)`, `_layout.appearance`, `admin/branding/index.variables`; rewritten: `_components/BrandingChrome(+ssr)`; changed: `AppShell.test` (a custom header has no rail icon), `AppRouter.ssr` (the chrome now takes `branding` and `appearance`). Harness for the browser checks (not in the repo): Vite + `@tailwindcss/vite` rendering the real `apps/www` pages with `window.fetch` replaced by a fake that implements R1's contract (merge `PUT`, upload, delete), Playwright with Edge; photos from picsum (a bright fjord, a foggy hillside darkened to a night shot, a forest waterfall, a misty waterfall with a rainbow) in both schemes at 1280 and 390 px.
- **Not mine, failing in the last full run** (in-flight work of the reading pane, compose and notifications agents): `test/apps/index.test.tsx` (conversations and an infinite-scroll case: the mocked `detail-pane`), `contacts/index.test.tsx` (the compose window's first load), `_components/ComposeContext.test` (`--rr-compose-top`), `_mail/useNewMailNotifications.test` (the desktop offer). The frame's `NotificationCenter` is `sticky top-10` under the title bar: with a custom header (its height varies, and it is sticky at the very top) the stack would sit under it once the page scrolls - worth a look by whoever owns it (a `--rr-header-h` variable set by `FrameBrandingHeader` would do).
- Verified: `yarn tsc --noEmit` clean in web-client and react-shared; `yarn lint` clean for every file of this entry (the errors it still reports are in the reading pane's and the outbox's files); react-shared `yarn vitest run --coverage` 94 files / 1226 tests passing, coverage 100 / 99.46 / 100 / 100; web-client full run 248 files / 3842 tests, 3821 passing, coverage 99.63 / 99.51 / 99.48 / 99.7 - every file of this entry at 100% (the one branch of `AppearanceProvider` that run still showed, removing a background nobody had set, is covered by a test added after it), the gaps are in `mail/compose/ComposeContext`, `www/index.tsx` and the other in-flight files. The 21 failures of that run are in files I don't own (see above).

### 2026-09-21 (later) - sharing shows who it is granting to and flags entries that never matched anyone

New `apps/shared/components/sharing/PrincipalPicker.tsx` (type an address, username or user id -> **Find** -> the resolved person's name and address -> **Grant**; `initialPrincipal` looks a stored string up at once for a replacement), used by the admin console's `ShareAccessCard` (shared mailboxes only; **Add me** stays; an entry the server marks `noEffect` shows "Not a user - this entry has no effect" and, on a shared
mailbox, **Replace with a user**: the stored string is looked up, the person shown, the uid granted with the same level, the string removed; on a personal mailbox it can only be revoked - the owner fixes it) and `apps/www/settings/sharing/index.tsx` (the user-facing Sharing page: the email box became "Email address or username" with the same preview, and the same flag/replace). Replaces the free-text uid box and the immediate address grant.
Tests: `test/apps/_components/PrincipalPicker.test.tsx`, `test/apps/admin/_components/ShareAccessCard.test.tsx`, `test/apps/settings/sharing/index.test.tsx` (the three files 100%). Not done here (other agents' files): the "(shared)" labels should use `isSharedWithMe()`/`Mailbox.accessRole` - a personal mailbox shared with the caller is not labelled today.

### 2026-09-21 — The reading pane: one card per message, bodies sized to their content, isolated and sanitized twice, and mail that takes the theme

Not committed. Nothing in `react-shared`, `server` or `restapi` changed (uses W-A's `useResolvedTheme()` and its Appearance tokens as they are). Files: new `shared/components/mail/reading/`
(`color.ts`, `bodyHtml.ts`, `frameDocument.ts`, `themeAdaptation.ts`, `themeSurface.ts`, `frameControl.ts`, `safeDocument.ts`, `bodyContent.ts`, `viewOriginal.ts`, `MessageBody.tsx`,
`MessageCard.tsx`, `EncryptedBody.tsx`, `EncryptedPreview.tsx`); reworked `MessageDetailPane.tsx`, `ConversationThreadPane.tsx`, `LazyReadingPane.tsx`, `ConversationList.tsx`, `apps/www/messages/[uid].tsx`, and a few lines of `apps/www/index.tsx` (the encrypted preview). The brief changed twice while this was being built
(first "invert dark messages with a filter", then "faithful HTML in both themes", then the rule below): what is here is the last one, and **there is no inversion filter and no
`invertDarkMessages` preference anywhere**.

- **The rule (JP's): mail takes the theme; explicit HTML colours win where they define their own background; text is adapted for contrast where they don't.** Plain text and
  HTML with no colours at all are simply themed. Details and the algorithm below; "View original" (per message, session) shows a message exactly as authored.
- **Cards.** `SubjectCard` (h1 + "N messages", `shrink-0` above the scroller, so it stays put) and one `CardShell` per message (`rounded-lg border bg-surface backdrop-blur-sm shadow-sm`,
  tokens only). `MessageDetailPane` draws the whole card (header: `ContactAvatar` initials - there are no photos in the data -, `From <span>Name <address></span>` or, in a thread, the
  sender button, `RecipientLine`s, `<time>`, action cluster incl. the "View original" toggle; the security badge and every existing notice/banner in the card's body region; the
  "You replied/forwarded" bar from `flags.answered/forwarded` - there is no reply *date* in the data, so no date; a footer with Reply/Forward, accessible names "Reply to this message"
  / "Forward this message" so the header's "Reply"/"Forward" stay unique; `print:hidden`). No Outlook reactions/emoji or "apps" buttons: the app has no such features.
  `inThread` draws only the card; `threadHeader` (bodyId, unread, onToggle, buttonRef) makes the sender line the h2>button that collapses it; `footer` puts Reply/Forward on the newest
  open message. `ConversationThreadPane` keeps `expandedFrom()`, scroll anchoring, mark-read, keyboard target (`shortcuts` only on the opened/newest message) unchanged; **moved:** the
  header button of an *expanded* message is now rendered by the pane, so collapsing swaps one button for the other - `refocusRef` puts the focus back on the new one (test), and the thread
  tests' `MessageDetailPane` mock draws that button. A message's own subject shows as an `h3` only when it differs from the thread's after stripping Re:/Fwd:/AW:/SV: or is the signed
  subject (`subjectDiffers`). Collapsed cards: `CollapsedCard` (one h2>button, `aria-expanded`/`aria-controls`, the empty `#thread-message-<uid>` kept). `data-row-open` focus rule untouched.
- **Loading.** `ReadingPaneSkeleton` (one live region, "Loading the message") = subject card + up to 3 `CardSkeleton`s: used by `LazyReadingPane` while the chunk loads (subject from the props),
  by the thread while its messages load (subject and count from the list row), and by the mobile page. The single message shows its card header at once and `BodySkeleton` in the body's place until
  the frame has loaded, been adapted and is visible; no layout jump (the header never moves; only the body area changes height). An encrypted message shows the skeleton (and never fetches the
  server's ciphertext preview) until `security` is known.
- **Sizing.** `controlFrame()` measures `#rr-body`'s bottom + the body's trailing margin/padding/border (not `scrollHeight`, which never shrinks), on load and from a `ResizeObserver` (the
  frame's own, else the window's, else `resize`) on wrapper/body/html; capped at `MAX_FRAME_HEIGHT` 200,000 px; stops listening after 200 reports (a stylesheet resizing itself). `html` is
  `overflow:hidden; height:auto !important`; `#rr-body` is `overflow-x:auto; overflow-y:hidden` so a wide table/image scrolls **inside the card** (scale-to-fit was not built) and can't widen the
  pane; `img{max-width:100%;height:auto}`. Viewport-height units in a message's CSS (`100vh`, `dvh`...) are rewritten to px (`sanitizeCss`): otherwise `min-height:100vh` makes the frame grow
  by its own content on every measurement (found by the hostile suite: an "overlay" payload inflated its frame to 5,198 px before the guard). The frame's viewport is the card's width, so a
  message's own `@media (max-width: ...)` rules respond to the real width (390 px on a phone).
- **Print.** The frame is content-height, so Ctrl+P prints the whole message (it used to print one pane-high slice). While printing (`beforeprint`) the adapted colours are taken back and
  put again on `afterprint` (`AdaptationResult.revert/reapply`): paper is not a dark surface. Actions and the footer are `print:hidden`; the app chrome's own print rules are W-A's.
- **Keyboard.** The old note said a sandboxed body forwards no key events. It does now: `forwardKeyDown()` re-dispatches a keydown from the frame to the app's `document` (same layer, same
  rules) and prevents the frame's default if the app took it. Every registration (`useShortcut` in `MessageDetailPane`) is unchanged.

**Isolation design decision.** The body is untrusted HTML and must never be inserted into the app's DOM (a sanitizer bug there is script in the app's origin, next to the unlocked mail keys). Options
weighed: (a) `sandbox=""` + `src=/content` (what it was): safest, but an opaque origin cannot be measured, hence the full-height scrolling box; (b) shadow-DOM render of DOMPurify output: measurable
and themable, but DOMPurify is then the only barrier - one mXSS bypass (they recur) is script in the app; (c) **`<iframe srcdoc sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox">`,
never `allow-scripts`**, with a CSP meta - chosen. `allow-same-origin` lets the *parent* read the frame's height and colours; it is safe only because nothing can run in the frame, and that claim
has four independent layers, each enough alone: (1) restapi's `ScanPipeline` sanitize-html allow-list (server); (2) `bodyHtml.ts`: react-shared's DOMPurify pass (scripts, `on*`, `javascript:`,
every remote URL/`url()`/`@import`) then our own DOM pass (removes script/iframe/object/embed/audio/video/canvas/dialog/template/meta/link/base/form controls/`math`/SVG `use`,`set`,`animate*`,
`foreignObject`; unwraps `form`, `button`...; drops `on*`, `name`, `srcdoc`, `formaction`, `srcset`, `tabindex`...; only `http(s)`/`mailto`/`tel` hrefs survive, each `target=_blank
rel="noopener noreferrer nofollow"`; images only `data:` or a resolved `cid:`; `position:fixed/sticky`, `expression()`, `behavior`, `-moz-binding` neutralised) - all on `DOMParser` documents,
which have no browsing context; (3) the frame's CSP: `default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline';
img-src data: [+ this server's /api/mail/attachments/ only when an inline image resolved to it]; font-src data:`; (4) the sandbox itself (no `allow-scripts`, `allow-forms`,
`allow-top-navigation*`, `allow-modals`, `allow-downloads`). Parent-side reads of the hostile document go through `Document.prototype` getters (`safeDocument.ts`) and `name` is stripped from every
element (DOM clobbering: `<img name=body>` overrides `document.body` on a Document). A body over 1.5 MB or 20,000 elements is not shown inline (offered on its own page via the server's
`/content`, which carries its own `sandbox` CSP). **Proof (real Edge through Playwright, `window.__pwned` canary in the frame and the parent, a canary origin, dialogs/popups/navigations watched):**
58 probes, 0 failures: 50 hostile payloads (script tags and `src`, `img onerror`, `svg onload`, `body onload`, `javascript:` links with tab/entity/case tricks, `data:` link, `iframe` `javascript:`/`srcdoc`/remote,
`object`, `embed`, forms with `javascript:` and remote actions, `button formaction`, `meta refresh` (remote and `javascript:`), `base href`, CSS `@import`/`url()`/escaped `url()`/`expression()`/`-moz-binding`/
`@font-face`, `link rel=stylesheet`, remote images/`srcset`/`background`, `video source onerror`, mXSS (`mglyph`, `svg style`, `noscript`), SVG `xlink:href`/`animate`/`script`/`foreignObject`,
`details ontoggle`, `marquee onstart`, autofocus, DOM clobbering, `position:fixed` overlay, 100,000,000 px height, `vh` growth, `cid onerror`, 15,000-deep nesting, 30,000 elements, a 400 KB attribute,
unclosed markup) through the real component with client-supplied HTML, plus 8 of them through the server path (`fetch /content`); and **layer independence** with NO sanitizing at all - the same
5 script payloads in a frame with `none` (control: all EXECUTED, so the test can see), `sandbox` only, `csp` only and `both`: blocked in every case but `none`. A benign https link opens a new tab with
`window.opener === null`. The corpus is in the session's scratchpad harness (not in the repo); the repo's tests pin the same rules structurally (`bodyHtml`, `frameDocument`, `MessageBody`,
`MessageDetailPane` suites).

**Server-side reality (for R1 / JP).** restapi's `ScanPipeline.sanitize()` uses sanitize-html's *defaults* minus `script`: **no `img`, no `style` attribute, no `<style>`, no `bgcolor`/`color`/`face`, no `font`,
no `center`** (checked against `sanitize-html` in `restapi/node_modules`), and `allowedAttributes` is not configurable (only `mail:scan:sanitize:allowed_tags`). So everything the server stores for
`/content` is unstyled, image-less semantic markup - which is why it follows the theme completely - and **JP's "render faithfully, including styling" cannot happen for server-sanitized mail until the
sanitizer keeps styles and inline `cid:` images** (and existing messages keep the HTML they were stored with). The client is ready for it: styled HTML, `<style>` blocks, `bgcolor`, body attributes, inline
images (`cid:` -> the attachment's `contentId`, which the model has but react-shared's `Attachment` type doesn't list - read as an optional field) all work; decrypted/verified messages already keep their
styles and images (DOMPurify path). **Remote content today (unchanged):** the server's `/content` header and the old frame's CSP were `img-src data: cid:`, the sanitizer strips remote resources and the
server drops `img` altogether; nothing remote ever loads and there is no user control. Unchanged - JP hasn't asked.

**How a message takes the theme (`themeAdaptation.ts`).** The frame's base stylesheet gives the root a *sentinel* text colour (`rgb(1,2,3)`) and links another (`rgb(1,2,4)`) at zero specificity; after load the
parent reads `getComputedStyle` for every element (all reads before any write) and classifies: text whose computed colour still equals the sentinel was never coloured by the message (*unauthored*); anything
else, black included, is *authored*; a background is authored when not transparent or an image is present. Effective background = nearest authored background up the tree (semi-transparent ones composited over
what is beneath), else the theme's opaque surface (`themeSurface.ts` reads `--rr-color-surface/bg/text/primary-dark` through a probe element - so W-A's custom colours are followed, and a translucent surface is
composited to an opaque one; the body area is painted with it, so a translucent card over a photo stays legible). Then: unauthored text on the theme -> theme text (link -> theme link colour); authored text on the
theme -> kept if 4.5:1, else `adaptForeground()` (neutral: placed between the theme's text and background colours by how far it is from the readable end, so black -> the theme's text colour, white -> dark text in a
light theme; coloured: keep hue/saturation, move HSL lightness just far enough); anything on an authored *opaque* background (colour, image, gradient - first stop, else black) is left as authored, except unauthored
text, which gets black/white by contrast (links: classic blue, lightened if it must). Only `color` is ever written, as `style.setProperty('color', rgb(...), 'important')` from numbers (never message text); an element is
written only when inheritance would not already give it its target. Time-sliced (12 ms slices, yields to the event loop); the frame is `visibility`-hidden (skeleton shown) until done, so nothing unreadable is ever
shown. **Measured** (Edge, headless, fetch + sanitize + load + adapt): 2,500 elements 92 ms, 10,000 169 ms, 19,500 301 ms; over 20,000 elements the message isn't shown inline at all. Memoised per (message, version) for
the body, per (theme, colours) for the frame (`key` on the mode + `surfaceKey`, since the pass edits the document it ran on, a changed surface loads a fresh one). **Verified in a real browser** on 14 fixtures (plain/bare
reply with a Gmail quote, authored black, authored white, `<body bgcolor text link>`, newsletter with a white 600 px table + coloured buttons + photo, receipt with a dark SVG logo, authored blue quote, inline photo,
already-dark-capable, semi-transparent panel, gradient banner, low-contrast navy, 900 px wide table, long message) in both schemes: an automated check over the rendered DOM found **every text in a theme region
>= 4.5:1 (lowest 4.50 - navy on the dark theme - and 4.57 - a translucent panel in light)** and every authored text colour identical to its colour in the "View original" rendering (the only differences are text nobody
coloured, by design); a second pass over an adapted document changes nothing (16/16). Dark-capable mail (`<meta name="color-scheme">`, a `color-scheme` property, a `prefers-color-scheme: dark` block) is not adapted:
its `prefers-color-scheme` queries are rewritten to always-true/false for the *app's* scheme (a browser answers with the OS's) and `color-scheme` is set to it. **Known limits (documented, not hacked around):** a dark
logo/PNG with a transparent background on a dark theme, text baked into images, `mix-blend-mode`, SVG paint (the subtree is skipped), gradients judged by their first stop only, text over a background *image* (black),
mail that sets colours through `!important` inline `color` we then overwrite is still overwritten (inline important beats a stylesheet), hidden "preheader" text coloured to match its background is adapted like any text.
- **Body content (`bodyContent.ts`).** `GET /mail/messages/:id/content` with `Accept: text/html, text/plain;q=0.8` and credentials; HTML -> the frame, anything else (the server's plain-text fallback, or a message with
  no HTML part) -> a `<pre>` in the theme's colours; a small in-memory cache (40 bodies, per uid+version); errors show the server's message with a "Try again". Decrypted/verified content (`security.html`/`text`) is passed as
  `content` and never fetched; its inline images come from the decrypted parts as `data:` URIs (raster/SVG, <= 5 MB).
- **Thread loading keeps its header.** The thread pane renders one tree for loading, error and loaded: the `SubjectCard` is the same element throughout (subject and count from the list row) and only what is under it
  changes (`SkeletonCards`, an alert, or the list), so nothing is drawn twice. Each frame is keyed on mode + surface + a fingerprint of its document, so a different body (the decrypted one replacing the
  server's) is a different frame that has to load and adapt before it is shown.
- **Encrypted messages (added late, JP's screenshot: a locked message showed the bare word "Encrypted" on a white slab).** The body region has four states, each themed card content, never a frame:
  *waiting* (`BodySkeleton` until `security` is known - the ciphertext preview is never fetched), *locked* (`EncryptedBody`: lock in a `primary/10` disc, "This message is encrypted", "Unlock your keys to read
  it", one primary button - aria-label "Unlock to view this message", text "Unlock" - that calls the existing `requestUnlock(mailboxUid, [])`; `unlocking` disables it), *decrypted* (the normal pipeline: the
  decrypted `html`/`text` in the same frame, adapted like any message) and *cannot decrypt* (warning icon, "This message can't be decrypted", the reason in an `Alert`, **no** button - unlocking would not help).
  "Locked" is `security.decryptError !== undefined && !getUnlockedKeys(mailbox)` (`lockedRef`), so a decryption failure with keys in hand is the cannot-decrypt state. **Behaviour that moved:** the key-session
  subscription used to react only to `locked`; it now also reacts to `unlocked` *when the pane is showing the locked state*, so unlocking from anywhere (compose, another message, the unlock prompt) opens the
  message in place - and after the button, the focus moves to the body region (`tabIndex=-1`, `outline-none`), since the button that had it is gone. The old Alert + "Unlock to view this message" link is gone.
  The security badge gets a lock icon for every `encrypted*` state. Subject: the placeholder `[...]` reads "Encrypted message" (`displaySubject()`) on the subject card, the thread's h1 and (so it does not repeat as
  an h3) the messages of the thread; a signed/decrypted protected subject still wins. **Lists:** an encrypted message the server gave no preview for shows a 12 px lock and "Encrypted message" on the preview
  line (`EncryptedPreview`): message rows and child rows (`message.encrypted`), a collapsed card in a thread, and a conversation row that only looks encrypted (`conversationLooksEncrypted()`: preview `""` +
  subject `[...]` - a conversation summary has no flag) - `apps/www/index.tsx` and `ConversationList.tsx`; decrypted rows keep their decrypted snippet. **Verified in real Edge** (harness stubs `keySession`'s
  `getUnlockedKeys`/`subscribeKeySession` and `messageSecurity`, PKI.js being unbundleable in the dev server): locked / decrypted / cannot-decrypt, light and dark - card, hairline, lock disc and button all
  theme tokens, the decrypted body a normal adapted frame, nothing wider than the pane.
- **Test contracts that moved.** Anything that stands in for `MessageDetailPane` inside a thread must draw `threadHeader`'s button (the thread only ever focuses/toggles through it, and tolerates its absence): done in
  `ConversationThreadPane.test.tsx` and in `index.test.tsx`'s stand-in; `index.test.tsx`'s `openConversation()` now also waits for an expanded message, because the subject card is there before the messages. **Tests
  that were not this work** (full-suite runs while the other agents were editing): `AppRouter.mailConnection.test` and `useMailLiveUpdates.test` (live-update work in progress), `contacts/index.test` (Email opens Compose), and
  `index.test.tsx`'s "stops after a few full pages in a row" timing out at 5 s under load (3 s alone) - given a 30 s timeout, the only line of that file changed by me apart from the stand-in and the encrypted tests; the bulk-action/Select-toggle tests
  of `index.test.tsx` failed in one run while another agent was changing `index.tsx` under them.
- **Tests.** New `test/apps/_reading/*` (color, bodyHtml, frameDocument, themeAdaptation - a model of the browser's cascade, frameControl, MessageBody, MessageCard, bodyContent, themeSurface, viewOriginal, safeDocument,
  SSR), `_components/MessageDetailPane.card.test.tsx`, `_components/paneFetch.ts` (`mockFetch` for the pane's tests: answers only the body's own `/content` request - recognised by its `Accept` - so a test's handler and
  `mock.calls` are unchanged). Updated, not weakened: `MessageDetailPane*.test.tsx` (frame instead of `src`, the CSP/sanitizing tests now against the new document, `/^From$/`), `ConversationThreadPane.test.tsx`
  (the mock draws the sender button; the full-height row test became a natural-height/scroll/gap test; the loading test asserts the skeleton and the subject card; a new focus-retention test), `messages/[uid].test.tsx`.
  jsdom loads no `srcdoc`, so component tests write the document into the frame and let it fire `load`; the frame is another realm, so its elements are spied on one by one. Coverage: every file of `reading/`, plus `MessageDetailPane`, `ConversationThreadPane`, `ConversationList`, `LazyReadingPane` and `messages/[uid]`, is at 100% statements/branches/functions/lines (measured with a private `--coverage.reportsDirectory`: parallel vitest runs share `coverage/` and wipe each other's data). The 27 test files that touch the pane hold 828 tests (827 green in the run before the other agents' `index.tsx` edits). Last full run: 259 files / 3,987 tests, 3,976 passed; the 11 failures are the ones listed above, and the overall `apps/**` gate is not green only because of other agents' unfinished files (`MailShell`, `folderTree`, `folderCounts`, `useMailConnection`, `useMailLiveUpdates`). `tsc --noEmit` clean; eslint clean on everything touched (`ThemeSwitch.test.tsx` has 2 unnecessary-assertion errors that are not mine).

### 2026-09-21 (P1) - Plugins page: uninstall with the plugin's data, and where each deletion stands

JP: "when uninstalling a plugin, there should be a checkbox option to delete all plugin data". Server semantics are in the server's NOTES of the same date (nothing is deleted while any server runs the plugin; per-step results; retry; reinstall cancels). Not committed.

- **`RemoveModal` (`apps/shared/components/admin/settings/PluginsManager.tsx`).** Now a `<form>` inside the shared `Modal` (focus trap, Escape, `aria-modal` are the Modal's; nothing added). The unchecked checkbox "Also delete all data this plugin stored" is `aria-describedby` a list of exactly what is deleted (collections and tables with everything in them, saved settings, cached package and pages, whatever the plugin cleans up itself) ending in a red "This can't be undone." (always visible, so it is read before ticking). Ticking swaps the wording, shows the timing paragraph ("Nothing is deleted while a server is still running the plugin ... Adding the plugin again before then cancels the deletion") and a "Type <display name> to confirm" input (trimmed, case-insensitive; `autoComplete=off`); the submit button becomes "Uninstall and delete data" in the app's destructive-button classes (`!bg-danger !border-danger`, as Delete domain/mailbox/escrow scope) and stays disabled until the name matches. Enter in the name field submits (only when enabled). Checkbox, input and buttons are disabled while the request runs. `api-104` (not elevated) is shown as "needs you to have recently confirmed your identity. Reload this page, or sign in again ..." - `PluginsManager` has no `authServerUrl`, so it can't bounce to `/auth/elevate` itself; `AdminShell` already elevates every admin session. Layout is the modal's (`max-w-[440px]`, 20 px outer gutter): at 390 px the content is ~294 px wide and everything wraps (no fixed widths were added); **not checked in a browser** (no harness in this repo - the jsdom tests assert structure and semantics only).
- **The list.** `GET /system/plugins/status` gained `purges` (react-shared `PluginStatus.purges`). Uninstalled plugins that have one and are not in the installed list get a row in the same table (name + package, an "Uninstalled" badge, and): pending "Uninstalled - data will be deleted after servers restart" (+ "N of M servers still running it" when N > 0), running "Uninstalled - deleting its data now", done "Data deleted <medium date>" (`toLocaleDateString(undefined, { dateStyle: "medium" })`), failed "Data deletion failed: <reason>" + the failed steps + Retry (`aria-label` "Retry deleting the data of <name>"; secondary button). A plugin that is installed is never shown as uninstalled, whatever `purges` still says (the server hides it too). With nothing installed but deletions listed, the table shows instead of "No plugins installed." Retry re-reads the status and keeps polling (no optimistic update: it would need a status to patch, and the branch couldn't be reached).
- **Polling / notifications.** The status poll now also runs while a deletion is `pending`/`running` (5 s, like a rollout). A `seenPurges` ref remembers each deletion's last state; only one seen pending/running that then becomes done/failed raises a `notify` (success "<name>'s data was deleted"; error "Deleting <name>'s data failed" with the reason, `dedupeKey` per uid+state) - so opening the page on an old finished deletion is silent. Scheduling one raises an info notice; adding a plugin whose response carries `warnings` (the server cancelled its pending deletion) raises a warning each. Uses W-C's `apps/shared/notifications/store.ts` `notify` (untracked in the tree when this was written).
- **Tests.** New `test/apps/admin/plugins/purge.test.tsx` (32: dialog default/checked/typed name/danger classes/description/keyboard/busy/errors, every list state and fallback, retry, polling + notifications with fake timers, reinstall warning); the old uninstall tests pass unchanged (an older server's empty 204 still reads as "no deletion scheduled"). `PluginsManager.tsx` 100% statements/branches/functions/lines (measured by running `test/apps/admin/plugins` with `--coverage.include` on the file). Full `yarn test` was run once: 8 failures, all in others' in-flight areas (`AppRouter.mailConnection.test.tsx` document-title expectations, one `contacts/index.test.tsx` toolbar test) and not touched; a failing run prints no coverage table, so the 100% gate wasn't re-measured for the whole tree.
- **Overlay.** react-shared was built (`yarn build`) and its `dist` copied over `node_modules/@rapidmx/react-shared/dist` (needed for `removePlugin(uid, options)` / `retryPluginPurge`); package.json, yarn.lock and `.yarn` untouched.

### 2026-09-21 - Contacts layout, new folders without a refresh, a theme switch and signing-certificate progress (W-D)

Not committed. Needs the `react-shared` change of the same date (see its NOTES; unpublished: `getCurrentSignEnrollment`, `checkSignEnrollmentNow`, the extended `EnrollmentResult`) - same
overlay recipe as before (`yarn build` there, `cp -r dist/. ../web-client/node_modules/@rapidmx/react-shared/dist/`). The signing endpoints are R3's contract, **not integrated against a real server** -
unit tests, mocks and the browser harness's stub only.

**1. Contacts (and the same class of bug in Calendar and Tasks).** Reproduced first in a real browser: the toolbar's 8 captioned buttons need ~470 px, the list column was a fixed `w-96` (384 px) with no
`min-w-0`/overflow guard, so Export/Import painted over the detail pane (and over the New contact heading); `ContactsShell` also rendered an empty `w-56` aside for a single mailbox; on a phone the page
scrolled sideways (511 px in 390). What changed:
- `components/layout/ResponsiveToolbar.tsx` (new, generic): `layoutToolbar(actions, width)` is pure (all captioned: 16 + n x 64 + 9 per divider; all icons: n x 36; else drop by `rank` until the rest and a
  36 px More button fit; `essential` never drops; `width === undefined` - SSR, no ResizeObserver, every test - shows everything). It is *computed*, not measured per button, so the first client paint is right
  and nothing jumps; the root is `overflow-x-clip` as a guarantee. A caption is never half-shown (captions go for all buttons at once). `MoreMenu` is a portalled fixed `role="menu"` (like `UserMenu`),
  focus to the first enabled item, arrows/Home/End/Escape/Tab, outside `mousedown` closes, the hidden import `<input>` stays in the bar so Import from the menu still opens the file chooser. Tooltips: an
  action's own `hint` (the shortcut's `title` + `aria-keyshortcuts`) always wins; otherwise `title` = the label once the caption is hidden (the label stays in the DOM as `sr-only`, so accessible names and
  every existing test are unchanged). `ContactsToolbar` is now just its action table (overflow order: Import, Export, Add category, Favorite, Email, Delete, Edit; New contact essential). At the real list widths (416 / 409 /
  327 / 255 px) that is: all icons at 1280+, 6 + More at 1024, 5 + More at 768.
- Layout: the page root is `flex-col lg:flex-row md:flex-none md:h-[calc(100dvh_-_var(--rr-header-h,4rem))] md:overflow-hidden` - **`flex-none` matters**: the page is a `flex-1` child of a column, and
  `flex-basis: 0%` overrides `height`, so without it the bound silently does nothing (found in the browser: 1045 px instead of 736). The frame's own height is open-ended (`min-h-screen`), so no column's
  `overflow` ever applied before; from `md` up the page is now window-height and the list, the detail pane and the form scroll independently, on a phone the document scrolls as before. List column
  `md:w-[clamp(16rem,32vw,26rem)]`; the table is `table-fixed` with `max-w-0 truncate` cells (no sideways scroll); the empty state is centred; `ContactForm` is a flex column with a scroll area and an
  `rr-solid` sticky footer (`sticky bottom-14 md:bottom-0`: above the phone's tab bar on the mobile edit page, where the whole page scrolls; a plain footer in the desktop pane) and `@container` /
  `@md:grid-cols-2` so its two-column rows follow the pane's width (Tailwind 4 container queries; the pane is ~409 px at 1024). Below `lg` the contacts menu (and the shell's mailbox switcher) is a drawer
  and the hamburger sits on a row above the columns; `ContactsShell`/`TasksShell` render their aside only when there is a switcher or an error.
- Calendar: the column got `min-w-0`, the toolbar row `flex-wrap`, the view buttons `flex-wrap` (they were an `overflow-x-auto` strip nobody could tell was scrollable), the calendars menu is a drawer below `lg`.
  Tasks: the add-a-task row wraps (`min-w-40 basis-40` title), the menu is a drawer below `lg`. The Tasks toolbar (5 buttons) already fits every real width; left as is.
- Looked at (Edge/Playwright, harness below): Contacts at 1920/1440/1280/1024/768/390 in dark and light (list, New contact, More menu) - toolbar inside its column, document width = window width, no page
  scroll on desktop, Save/Cancel in view - plus 1440/390 over a background picture (translucent panels legible, the footer opaque); Calendar and Tasks at 1440/1024/768/390.
- The harness is not in the repo: Vite (web-client's own) + `@tailwindcss/vite` rendering the real routed page (`apps/www/**/index.tsx`'s default export, i.e. the frame) with `fetch`/`WebSocket` stubbed;
  a background picture is a CSS `url()`, which bypasses the fetch stub - serve it with the browser context's own `route()`.

**2. Folders without a refresh.** Findings: `useMailLiveUpdates` already handled a `Folder` create event (dedup by uid) and `flush()` already re-read every mailbox's folders for the counts on any refresh -
but that read-back only updated the counts overlay, never the tree, so a folder the server made lazily (Outbox, Sent Items) stayed invisible until reload. Now:
- `mail/folderTree.ts` (new, pure): `FOLDER_ORDER` (**changed** to Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk, Archive, custom - it was ... Junk, Archive, Deleted), `sortFolders`, `upsertFolder`
  (add only a whole, mail-type folder of a known mailbox; update name/type/parent/colour; a type that is no longer a mail type leaves; **returns the same array when nothing changed**), `removeFolder`,
  `reconcileFolders` (adds and renames, **never removes** - a listing that began before a folder was made here would take it out again; deletions come as events), `folderRows`.
- `useFolderCounts(mailboxes, folders, onFoldersListed)` calls `onFoldersListed(list)` for every successful mailbox listing in the read-back (before deciding whether the *counts* are trustworthy), and
  `useMailConnection` files it. So the trigger set is everything that already refreshed counts: a message event (unknown-folder or not), a send event, the 45 s poll, focus, visibility, `online`, a reconnect and
  the server accepting a queued message (`registerOutboxCounter`'s second callback, which now files `listFolders(mailbox)` through the same function). One mechanism; a burst is one debounced refresh (400 ms).
  Create events call `onFolderCreated` then `folderCounts.refresh(0)`; `update` events that name `name`/`type` call `onFolderChanged` (a counts-only update - the shape restapi publishes after every message
  change - still only goes to `applyFolderEvent`); `delete` events call `onFolderDeleted(uid)`.
- **A folder met in a list.** `noteFolderUids(uids)` (on `MailConnection` and `MailShellContext`; a no-op default) is called by `InboxContent`'s one effect over `messages` and
  `conversations[].folderUids`: an unknown uid triggers one debounced `folderCounts.refresh()`, and each uid is asked about at most once per page load (another app's folder must not make the
  page ask for ever).
- The channel list follows the tree automatically (`channelKey` effect), so a new folder is subscribed at once. `pushChannelsFor` order is now inboxes, **mailbox uids**, then the other folders in sidebar
  order (it was inboxes, other folders in fetch order, mailbox uids last): with the 40-channel cap the announcements of new folders must outrank any folder's own mail.
- **One placeholder mechanism.** `MailShell`'s inline synthetic Outbox row is gone; `folderRows(folders, sending)` adds a muted non-link row (`data-folder-placeholder`) for the Outbox (with its sending
  badge) and Sent Items while `pendingCountFor(mailbox) > 0` and the folder is missing, sorted into place, and builds none for a folder that exists - no duplicate is possible. Junk and Archive get no
  placeholder (nothing about a send says they are coming; R3's "all folders at once" + the refetch bring them).
- `apps/www/index.tsx` (small edit, not in my area): the list effect's deps had `mailboxFolders`, so *any* new folder reloaded the list on screen and forgot the selection; it is only read by the merged
  ("All Mailboxes") view, so the dep is now `aggregateFolderType ? mailboxFolders : null`.
- Looked at: a fresh account (Inbox, Drafts, Deleted Items), `beginPendingSend` (placeholders in place), then create events for Outbox/Sent/Junk/Archive each delivered twice + `finishPendingSend`: 7 rows in
  order, no placeholder left, the socket subscribed to all four new uids; at 1280 and 390 (drawer).
- **Well-known folders are singletons (R3 now makes all 11 per mailbox, heals on `GET /folders`, and publishes every creation).** `upsertFolder` keeps one folder per non-`user` mail type per
  mailbox - the older by `dateCreated` (the server answers with the oldest): a newer duplicate is ignored (the same array), an older one replaces it, unknown dates keep what is there, so the result
  does not depend on the order a listing or the events arrive in. **`resolveFolderOfType()`** (bulk Delete / Report junk, `apps/www/index.tsx`) no longer creates Deleted Items or Junk because the page's tree
  lacks it: it lists the mailbox's folders first, files the one it finds (`onFolderCreated`) and only POSTs when the server truly has none (an older server). Rename/move publishes the whole folder on the
  mailbox channel: `onFolderChanged` takes the name/type and `applyFolderEvent` takes its counts; a delete's `{ uid, mailboxUid, version }` is handled by `uid`.
- Assumptions R3 must satisfy: events are `{ type: /^Folder/, action: "create"|"update"|"delete", data }` with `data` a whole Folder (create) and at least `{ uid }` (delete), an update naming `name`/`type` carries
  `uid` and `mailboxUid`; `GET /folders` lists everything (limit 200; the client never removes on a listing). Nothing else is required: an old server just gets the refetch path.

**3. Theme switch.** `components/layout/ThemeSwitch.tsx` - a `radiogroup` (`aria-labelledby` the "Theme" text) of three `role="radio"` buttons, roving tabindex, arrows/Home/End move *and choose*, `aria-label` + `title`
each. It reads `AppearanceContext` directly and renders **nothing when the value is `INERT_APPEARANCE`** (no provider: a plugin page's own chrome, most component tests) rather than a control that lies; `AdminShell`
and `EscrowShell` do mount a provider, so it shows there. `setPrefs({ mode })` only when the mode differs. The menu stays open on a choice so the effect is seen. Checked in the browser: dark applied in one
frame (`data-theme`, frame background), `localStorage` cache written, arrows move focus and mode, survives a reload; the open menu at 1280 and 390 in both schemes (the row is 240 px wide, three 32 px buttons).

**4. Signing certificate.** `signing/enrollmentTracker.ts` is a module-level store (`useSyncExternalStore` hook `useEnrollmentSnapshot`), one entry per mailbox, **ref-counted, and a pending entry outlives its last
watcher** (that is what makes the frame's pop-up work after the page that started it is left; an ended or 404'd entry is dropped on release). Reads: immediately (unless `initial` says what it is), then 15/30/60 s
(`ENROLLMENT_POLL_DELAYS_MS`), a timer that fires while `document.visibilityState !== "visible"` schedules nothing and marks the entry paused; `visibilitychange`/`focus`/`online` resume it at once with the
backoff restarted. Terminal answers clear the stored id (`enrollmentStorage.ts`, moved out of the page - same key `rapidmx.signEnrollment.<mailbox>`) and, if the entry was watched as pending
(`expectPending`), tell `onEnrollmentEnded` listeners once. `checkEnrollmentNow` = `POST .../check`; 10 s cooldown after each check; a 429 sets `retryAt` from the body's `retryAfter` (`apiFetch` does not
surface `Retry-After`, so the default is 10 s); 404/405/501 (older server) falls back to a plain status read, whose own 404 means the enrollment is gone.
- The page (`apps/www/settings/encryption/index.tsx`) kept its state names (`signingStatus`, `signingEnrollmentId`) and now derives them from the snapshot in one effect; the poll effect, the reload-check effect
  and `applyEnrollmentResult` are gone. New: on mount it watches the stored id or - for the owner - asks `getCurrentSignEnrollment` (an enrollment started elsewhere is adopted and its id stored, so rotation is
  blocked here too); a certificate that outlives the known active key triggers the `getMailbox` refresh of `mailbox.keys`. Card selection: pending > active certificate (`issued`) > failed > expired > the
  original "Enable digital signatures" button; a non-owner sees the card without Check status/Renew. "Renew" is the same enrollment flow as "Enable" (**assumption**: the server accepts a new signing enrollment
  while an older certificate is still valid - not verified against restapi).
- Behaviour changes to existing tests (updated): a pending enrollment is read at 15 s then 30 s (was every 15 s); a failure is now the card's "Failed: <reason>" with **Try again** (was an Alert and the Enable
  button); an answer that arrives after the page is gone now still ends the enrollment and forgets the stored id (the tracker is app-wide).
- `test/apps/setup.ts` resets the tracker after each test **through a dynamic import inside `afterEach`** - a static import in the setup file loads the module before a test file's `vi.mock()` of `keyvaultApi`
  and it would keep the real functions (found the hard way: `checkSignEnrollmentStatus` was the real one in the tracker).
- The frame watcher (`useSigningEnrollmentWatcher`, one line in `AppChrome`, `enabled: inFrame`; the lookup is an async IIFE with a try/catch so it can neither throw nor reject - a test
  that mocks `keyvaultApi` with a partial factory (`AppRouter.mailConnection.test`) made the *synchronous* "no export defined on the mock" throw take the whole frame down): owned mailboxes only; stored id -> `watchEnrollment`; none -> `getCurrentSignEnrollment` (errors ignored, an older
  server's 404 is "nothing") and only a *pending* answer is adopted (so a certificate issued last month never pops up). Pop-ups: success "Digital signature certificate issued" (View -> /settings/encryption),
  error "... could not be issued" (Try again / Details), `dedupeKey` per enrollment.
- Looked at (harness with the key session stubbed unlocked and the endpoints stubbed): none, pending at two stages (35 % and 62 %), issued, expiring (12 days, warning + Renew), failed, checking (busy), each at
  1280 and 390; and the pop-up on Contacts when an enrollment found through the server ends (issued, and failed at 390).
- Contract coded against (R3): `GET .../keyvault/keys/sign-enrollment/:id` = `EnrollmentResult` + optional `stage`, `stages[{id,label,state,at?}]`, `progress`, `requestedAt`, `updatedAt`, `lastCheckedAt`, `nextCheckAt`,
  `errorCode`, `retryable`, `issuedAt`, `notAfter`, `serialNumber`, `issuer`, `subject` (ISO dates as strings); `POST .../:id/check` (same shape; 429 within ~10 s); `GET .../sign-enrollment` (current, plus
  `enrollmentId`; 404 when none). `nextCheckAt` is parsed but not used yet (the client polls on its own backoff; R3 says it may be in the past, meaning due).
- R3's implementation details, taken into account: 6 steps and progress 15/40/60/85/100 arrive in `stages`/`progress` and are drawn as sent; **`installedAt` comes after `issuedAt`** (a job installs the certificate
  within ~5 minutes): `isInstalling()` = issued, has `issuedAt`, no `installedAt` (an older server sends neither, so its certificates are never "installing"). The card then says "Issued - installing it on your
  mailbox (this takes a few minutes)", the page counts it as issued (no "Enable digital signatures" button in that gap) and asks `getMailbox` every 15 s (at most 40 times) until the active signing key is listed,
  and the pop-up says the certificate is issued and being installed rather than that mail is signed. `note?` is shown under the status; `errorCode: "ca-unreachable"` on a pending answer (not an HTTP error) shows
  "The certificate authority could not be reached just now - it will be asked again.".

**Verified** (with the `react-shared` `dist` overlay): `yarn tsc --noEmit` clean, `yarn lint` clean, `yarn vitest run --coverage` 264 files / 4081 tests passing, coverage 100 / 99.93 / 100 / 100 (the uncovered
branches are old ones: `MoveToFolderDialog` 223, `ComposeWindow` 730 and 1409, `index.tsx` 783, 1189 and 2282). **The suite is load-sensitive on this machine**: in two earlier full runs
`contacts/index.test` "toolbar Email opens the floating Compose window" (a cold compose-window chunk; its waits are now 20 s), `tasks/index.test` "shows a validation error ... title is blank" (an exact fetch-count
assertion that a late background request breaks) and `settings/appearance/index.test` "puts the previous state back and says so when the upload fails" (W-A's) failed and each passes alone. Not verified: the signing card and
watcher against a real restapi; Firefox/Safari (`@container` queries and `dvh` are supported by current versions of all three); a real device's virtual keyboard against the sticky footer on a phone.

### 2026-09-21 (later) - The signing-certificate card follows how the deployment issues certificates (W-D)

Not committed. JP's live finding: the deployment ran the manual provider, so a request stayed pending for an hour while the page said a public CA issues it automatically. JP has decided on automatic RFC 8823
issuance (R6 builds the server side). New contract coded against, **not integrated against a real server** (R6's typed client `react-shared/src/crypto/signingProviderApi.ts` did not exist when I finished, so the
thin client below is web-client's own - reconcile with R6's when it lands and delete mine):
- `provider: "manual" | "rfc8823"` on every enrollment status (`EnrollmentResult.provider`, optional, validated by `normalizeEnrollmentResult`).
- `GET /api/system/signing-enrollment` -> `{ backend, automatic, ca?: { host }, contactEmail?, typicalDurationMinutes?, adminUpload, health?: { ok, checkedAt?, lastSuccessAt?, lastError? } }`:
  `signing/signingInfo.ts` (`SigningEnrollmentInfo`, `normalizeSigningInfo`, `fetchSigningEnrollmentInfo()` - never rejects, a failure is `null` and not remembered, an answer is reused 5 minutes -, `useSigningEnrollmentInfo(enabled)`;
  `resetEnrollmentTracker()` also resets its cache, so the existing per-test reset covers it). Only the mailbox owner asks (the page's `canManageKeys`).
- A stale id: 404 with `code: "signing-enrollment-unknown"` on `GET .../:id` and `POST .../:id/check`. The tracker already treated any 404 on a read as "gone" (stop, clear the stored id); a coded 404 on **check** now
  ends at once instead of falling back to a plain read (`UNKNOWN_ENROLLMENT_CODE`). The page shows "This request is no longer active - request a new certificate" (an `Alert` above the request UI, from the tracker's
  `gone` flag; the entry is dropped when the page lets go, so it does not come back on the next visit) and the "Enable digital signatures" button stays available. Nothing polls for ever.
- Wording (`enrollmentView.ts`, `SigningCertificateCard`): `issueModeOf(result, info)` - the enrollment's own `provider` first (a request made to a CA stays a CA request after a configuration change), else the
  deployment's `backend`/`automatic`, else "unknown". **automatic**: "Requested from <ca.host>. The CA sends a verification e-mail to <address>; this usually takes about <N> minutes." above the bar and steps (each part
  only as far as known); **manual**: "This server issues signing certificates manually: an administrator has to upload the certificate for your request. Contact your administrator." + `Administrator: <contactEmail>` +
  the absolute request date, **no bar and no steps** (there is no progress to report); **unknown** (an older server, or the endpoint failed): "Requested - waiting for the certificate. Use Check status to see where the
  request is." - nothing that is only true of one way of issuing (the old static "issues this via an automated email exchange... takes effect automatically" sentence is gone; the "leave this page" line is automatic-only).
  `health.lastError` -> a warning row "The certificate authority reported a problem: <lastError> (last successful contact <time | never>)" (pending card and the request UI); a pending request with `requestedAt` and
  `updatedAt` (else `requestedAt`) both over an hour old -> "This is taking longer than expected - last checked <t>. Use Check status to ask again." (the Check status button is always there for a pending request).
  Before anything is asked: `beforeRequestText()` says how it will be issued; `backend: "none"` says so and **hides** the Enable button. Never a spinner-only state: every spinner (the active step, the indeterminate bar) has words beside it.
- Not looked at in a browser this round (the harness was gone); unit tests cover every state and sentence (card, view, tracker, signingInfo, the page).

**Reconciled with R6's `signingProviderApi.ts` once it landed.** Its `SigningEnrollmentInfo`, `getSigningEnrollmentInfo()` and `SIGNING_ENROLLMENT_UNKNOWN` matched my stand-in's contract field for field (`backend`,
`automatic`, `ca?: { host }`, `contactEmail?`, `typicalDurationMinutes?`, `adminUpload`, `health?: { ok, checkedAt?, lastSuccessAt?, lastError? }`; same 404 code) - no wording or shape changes needed. `signing/signingInfo.ts`
now imports the type and the request from `@rapidmx/react-shared/crypto/signingProviderApi.js` and is only the caching/never-rejects/hook wrapper on top (its own `normalizeSigningInfo` is gone - R6's function is typed and
trusted like every other `apiFetch<T>()` call in react-shared, not runtime-validated, so keeping a second validator would have been inconsistent with the rest of the codebase); `enrollmentTracker.ts`'s
`UNKNOWN_ENROLLMENT_CODE` now re-exports `SIGNING_ENROLLMENT_UNKNOWN` instead of repeating the literal. Did not touch `signingProviderApi.ts`. One thing worth flagging: `yarn lint` on react-shared fails on that file
alone - `jsdoc/check-indentation` on its module-level bulleted-list comment (lines 5-16) - pre-existing in R6's file, not introduced by me; left alone per instruction not to edit it.

### 2026-09-21 (later) - New admin page `apps/admin/signing-certificates` (R6)

Not committed. Fixed the lint W-D flagged above (de-indented the bulleted continuation lines in `react-shared/crypto/signingProviderApi.ts` - `yarn lint` is clean on it now). Added the admin fallback for signing
certificates: a new `apps/admin/signing-certificates/index.tsx` (table of pending requests across every mailbox - address, requested, provider, status, actions; Download CSR link, Upload certificate dialog
(paste or choose a file, a client-side PEM sanity check, server refusals shown inline), Reject dialog with a reason; a summary of which backend is active and its health) plus one `AdminShellActive` id
(`"signingCertificates"`) and one `NAV_ITEMS` entry (`HiOutlineDocumentCheck`, "Signing Certificates") in `AdminShell.tsx` - the only file outside my own new one this touched, per the brief's "nothing else in
web-client". Built on `react-shared/crypto/signingProviderApi.ts` (my own file, see its repo's NOTES). Followed `apps/admin/data-requests/index.tsx`'s established shape (direct fetch + reload, `Modal` for the
upload/reject actions, `getNotificationsSnapshot().history` in tests rather than expecting a visible pop-up - **`NotificationCenter` is not mounted in `AdminShell`**, same as `PluginsManager`'s existing
`notify()` calls, so a success/rejection notification is recorded in the shared store but nothing currently renders it inside the admin console; not something to fix here, an existing gap). Tests:
`test/apps/admin/signing-certificates/{index,index.ssr}.test.tsx` (13 tests: every state, both providers, upload success/failure, file read, cancel-clears-draft, reject success/failure, load failures);
`test/apps/admin/_components/AdminShell.test.tsx` (existing, unmodified) still passes with the new nav item. `yarn tsc --noEmit` and `yarn lint` clean repo-wide.

## 2026-09-21 (R5) - Sent Items showed a false "not addressed to this mailbox" notice on an ordinary encrypted send

Found while proving `@rapidmx/restapi`'s same-server key-discovery fix (see that repo's NOTES) end to end with a real client: Alice
sent an encrypted message to Bob, then opened her own Sent Items copy - it decrypted fine (she has her own cert as a CMS recipient,
per `ComposeWindow`'s existing "encrypt to the sender's own cert too" behavior) but showed "The recipients this message was signed or
encrypted for don't include this mailbox - it may have been forwarded or re-sent to you unchanged, or you were Bcc'd." **Root cause:**
`messageSecurity.ts`'s `notAddressedToReader` compares the reader's address against the message's protected (signed/encrypted-for)
`To`/`Cc` headers - which, for a message sent to someone else, never include the sender's own address, so the notice fired on every
single sent message rather than the genuine forwarded/re-sent/Bcc case it's meant to flag. Fixed by gating the notice's render in
`MessageDetailPane.tsx` on `!isSentItems` (the same folder-type signal the Recall button already uses) instead of touching the shared
`messageSecurity.ts` check, which the Inbox/other-folder case still needs unchanged. One new test in `MessageDetailPane.test.tsx`
(160/160 passing in that file). `yarn tsc --noEmit` and `yarn lint` clean.

### 2026-09-22 - Autodiscover on the Domain DNS setup page

`DomainDnsSetup.tsx` gained labels and a "why this matters" explanation for the two new Autodiscover checklist rows (`autodiscover_cname`/
`autodiscover_srv`), with SRV-specific priority/weight/port/target value splitting mirroring the existing MX split.

Files: changed `DomainDnsSetup.tsx`. Full suite (isolated run): 270/270 files, 4139/4139 tests, 100/99.91/100/100 (one pre-existing flaky contacts
test - a cold compose-window code-load race - reproduced under concurrent load and passed clean alone, unrelated to this change).

### 2026-09-22 - A general resolve-then-confirm person picker, for a mailbox's owner and an escrow scope's key holders

`apps/shared/components/sharing/PrincipalPicker.tsx` (mailbox-sharing's own resolve-then-confirm widget) is now a thin wrapper over a new, general
`PrincipalResolver.tsx` - parameterized by an injected `resolve`/`onResolved` pair instead of being hardcoded to `resolveMailboxPrincipal()`/
`setMailboxAccess()`. `PrincipalPicker`'s own tests pass byte-for-byte unchanged, so `ShareAccessCard.tsx`/`settings/sharing/index.tsx` needed no
changes. Wired `PrincipalResolver` into `MailboxCreateForm.tsx`'s new "Owner" section (an owned mailbox's owner is now looked up and confirmed, not
typed as a raw uid) and a new `PrincipalListField.tsx` (an add-only-via-resolve, remove-by-click list, same visual shape as `StringListField.tsx`
but never taking raw text as a value) into `EscrowScopeKeyAndHoldersFields.tsx`'s holder list - previously a plain `StringListField` of raw uids.
One real bug fixed while wiring: `PrincipalResolver` originally rendered its own `<form>`, invalid once nested inside `MailboxCreateForm`'s outer
form - replaced with a `<div>` + explicit Enter-key handling. Confirmed already fine and left untouched: mailbox sharing, escrow access requests
(always the caller's own uid), distribution list membership (legitimately free-text addresses), legal hold custodians (mailbox uids, a different
picker problem), retention policy (no user/mailbox targeting), admin impersonation (a searchable list, not a raw uid box).

Files: new `apps/shared/components/sharing/{PrincipalResolver,PrincipalListField}.tsx`; changed `PrincipalPicker.tsx`, `MailboxCreateForm.tsx`,
`EscrowScopeKeyAndHoldersFields.tsx`, `apps/admin/mailboxes/new/index.tsx`. Full suite (isolated run): 270/270 files, 4139/4139 tests,
100/99.91/100/100.

### 2026-09-22 (later) - Calendar reminder pop-ups: the client side of restapi's already-shipped `CalendarReminderJob`

`CalendarEvent.reminderMinutesBeforeStart` was stored, and `restapi`'s `CalendarReminderJob` already fired a `"CalendarEvent"`/`"reminder"`
push event (`{ eventUid, title, startDate }`, to `[event.folderUid, event.mailboxUid]`) when it came due - but nothing in this client ever
listened, so it went into the void. `mapi`/`activesync` translate the minutes into Outlook's/EAS's own native reminder properties, so desktop
Outlook and phone calendar apps already popped up their own reminder; only the web/Electron client lacked one.

- **No new channel subscription needed.** `mailboxFolders` (what `useMailLiveUpdates`'s `pushChannelsFor()` subscribes) is filtered to mail
  folder types only, so a calendar folder's own `folderUid` channel is never subscribed - but every accessible mailbox's own `mailboxUid`
  channel already is (Mail needs it to hear about new folders), and the reminder is published there too. So the new hook only has to listen
  on the shared `getPushClient()` singleton; it manages no channels of its own and needs no `mailboxes`/`mailboxFolders` prop.
- **`apps/shared/calendar/calendarReminders.ts`** (pure, no React): `calendarReminderOf(event)` narrows a `PushEvent` to the reminder payload;
  `snoozeDelayMs(startDate, now)` = `SNOOZE_MS` (5 min) or less if the meeting starts first, never negative; `reminderMessage()` the pop-up's
  "Starting in N minutes - 3:00 PM" line; `reminderNotificationId(eventUid, startDate)` the id a reminder and every snooze of it reuses.
- **`apps/shared/calendar/useCalendarReminders.ts`**: one `getPushClient().onEvent()` listener, gated on `enabled && userUid` like
  `useMailConnection`'s own option. A reminder is a sticky `notify()` (new kind `"calendar"`, bell icon) with two actions - **Dismiss** has no
  `onClick`, so `NotificationCenter`'s default action behaviour (run it, then `dismiss()` since not `keepOpen`) does exactly "close it, nothing
  else"; **Snooze**'s `onClick` schedules a `setTimeout` (this tab's own, cleared on unmount) that calls the same `notify()` again with the
  same id - past that point the store no longer holds an entry with that id (Snooze's own click already dismissed it), so it comes back as a
  fresh, non-deduplicated pop-up rather than being silently merged into a same-id "already showing" no-op.
- **Mounted once, in `AppShell`**, next to `useSigningEnrollmentWatcher` - so a reminder shows on whichever page the user is on (Mail,
  Calendar, Contacts, Settings), not only while Calendar is open. No per-event deep link exists yet (the calendar opens an event via local
  modal state, not a URL), so the pop-up's link just goes to `/calendar`.
- **`NotificationKind` gained `"calendar"`** (`store.ts`, `NotificationCenter.tsx`'s `KIND_STYLE`, `NotificationHistoryDialog.tsx`'s
  `KIND_LABEL` - all three are exhaustive `Record`s, so `tsc` catches a fourth spot if one is ever missed).

Files: new `apps/shared/calendar/{calendarReminders,useCalendarReminders}.ts`, `test/apps/_calendar/{calendarReminders,useCalendarReminders}.test.ts(x)`;
changed `notifications/{store,NotificationCenter,NotificationHistoryDialog}.tsx`, `components/layout/AppShell.tsx`. `RELEASE_NOTES.md` updated
(Unreleased > Features). Verified: `tsc --noEmit` clean, `eslint` clean on every file of this entry, full suite 4172/4174 tests (271/273 files)
passing - the two failures (`contacts/index.test.tsx`'s cold compose-window race, already a known flaky one in this file's own 2026-09-22
entry above; `settings/filters/new/index.test.tsx`'s `resolveFolders is not a function`) are both pre-existing and in files this change never
touches.

### 2026-09-22 (later still) - A "Join Meeting" button on the reminder pop-up, when the event's location is a URL

JP's ask: when a reminder's event location is itself a link, the pop-up should offer a one-click way in, above
Dismiss/Snooze. Pairs with `restapi`'s `CalendarReminderJob` change of the same date, which adds `location` to the
`"reminder"` push payload.

- **`apps/shared/calendar/calendarReminders.ts`** gained `location?: string | null` on `CalendarReminderNotice`
  (`isReminderNotice()` widened to accept it) and a new pure `joinMeetingUrl(location)`: trims, parses as a `URL`,
  and returns the original string back only for `http:`/`https:` - anything unparsable, empty, or another scheme
  (a room name, a physical address, `tel:`, etc.) is `undefined`, so the button never appears for non-link text.
- **`apps/shared/calendar/useCalendarReminders.ts`**'s `show()` computes `joinMeetingUrl(notice.location)` and, only
  when it resolves, prepends a `"Join Meeting"` entry to the pop-up's `actions` array - first in the array, which
  `NotificationCenter` renders as the leading button in its single-row action bar, ahead of Dismiss/Snooze. Its
  `onClick` is `window.open(joinUrl, "_blank", "noopener,noreferrer")` and it sets `keepOpen: true`, so clicking it
  opens the link in a new tab and leaves the pop-up exactly as it was for a later Dismiss or Snooze.
- No change to `CalendarReminderNotice`'s wire shape otherwise, and a reminder from an older `restapi` that never
  sends `location` just never grows the button - the field is optional throughout.

Files: changed `apps/shared/calendar/{calendarReminders,useCalendarReminders}.ts`,
`test/apps/_calendar/{calendarReminders,useCalendarReminders}.test.ts(x)`. `RELEASE_NOTES.md` updated (Unreleased >
Features, folded into the existing "Meeting reminder pop-ups" bullet). Verified: `eslint` clean on every file this
touches; scoped `vitest` run over `test/apps/_calendar/` with coverage limited to `apps/shared/calendar/**`,
28/28 tests passing, 100%/100%/100%/100% - a full-repo `yarn test:prod` is blocked by an unrelated, concurrent
peer session's `Domain.aliasOf` TypeScript errors in `apps/admin/domains/*`, none of which this change touches.

### 2026-09-22 (later) - "Add video conferencing" on the event form (`EventModal.tsx`)

Not committed. The compose/UI half of the video-conferencing integration: react-shared gained the client
(`videoconf/videoMeetingsApi.ts`, see its NOTES entry of the same date), `@rapidmx/meet-plugin` owns the
routes, and `@rapidmx/restapi`'s `MeetingSchedulingJob` does the per-attendee link substitution in the invite
mails - none of that is here. **Written to the agreed contract, not run against a real server**; the plugin's
`organizerJoinUrl` on create/read is being added in parallel by another agent.

- **The control.** A checkbox **"Add video conferencing"** directly under Location. While it is checked, a
  muted line under it always says: *"Changing attendees after enabling video conferencing won't update meeting
  invitees - turn this off and back on to reissue links to the current attendee list."* A failure of the video
  call itself renders as a `role="alert"` line in the same block, next to the checkbox - never in the form's
  own `Alert` at the top, which stays the event save's own error.
- **Save order, always: the event first, then the meeting.** The invitee list must be built from the attendee
  list that was actually stored, so every branch of `handleSubmit` (create / detach one occurrence / save the
  series / plain update) now keeps its saved `CalendarEvent` and `applyVideoConferencing(saved)` runs after it.
  Checked and unlinked -> `POST /mail/video-meetings` (`visibility: "private"`, `calendarEventUid` the just-saved
  uid, `startTime`/`endTime` the event's own, `invitees` the attendees **minus the organizer** - `isOrganizer`,
  or an address equal to the saved event's own organizer address, or blank), then a second `PUT` on the event
  setting `location` to the placeholder and `videoMeetingUid`. Unchecked and linked -> `PUT
  /mail/video-meetings/:id` `{ status: "cancelled" }`, then a `PUT` clearing both fields with explicit `null`s.
- **The placeholder location is exactly `"Video call — link in this invitation"`** (`VIDEO_LOCATION_PLACEHOLDER`,
  em dash). Generic on purpose: the event is one shared record, so no join link - personal or not - may be
  written into it. **Restoring it on uncheck** is a plain identity test, not a heuristic: if the Location field
  at that moment still holds exactly that string (trimmed), it is cleared (`location: null`); anything else the
  user has since typed is theirs and is sent back unchanged. So a stale "Video call ..." line can never survive
  a cancellation, and a real location is never clobbered by one.
- **An already-linked meeting is left completely alone** when the toggle is checked and `videoMeetingUid` is
  already set - deliberately, and documented in `applyVideoConferencing()`'s own doc comment as well as in the
  helper text. The plugin's `PUT` is title/status only and cannot add or remove invitees, and a private
  meeting's personal join links are minted once at creation, so there is no honest way to reconcile an attendee
  change: pretending otherwise would leave a new attendee with no link and a removed one with a working one.
  Extending the plugin route was explicitly out of scope. Off and back on is the documented way to reissue.
- **A video failure never loses the event.** The event is already stored by the time the meeting call runs, so
  `applyVideoConferencing()` never throws: it sets the inline error and reports `failed`. The modal then stays
  open (`onSaved()` is not called, exactly as the existing detached-occurrence sync warning already does) with
  the toggle still checked and `videoMeetingUid` untouched, and remembers the stored event in `savedEvent` - a
  **retry updates that record at the version the first save returned**, rather than creating a second event or
  re-sending the stale prop's version into a 409. Minting a meeting with no attendee but the organizer is
  refused client-side with the same inline error (the route would 400), again without touching the save.
- **"Join video call"** sits above the form's `disabled` fieldset (joining is not editing, so an invitation's
  read-only copy keeps it) and shows whenever the event has a `videoMeetingUid`. A meeting minted in this
  session uses the create call's own `organizerJoinUrl` - no refetch; an event that arrived with a link fetches
  it once on open (`GET /mail/video-meetings/:id`). The button is disabled until a URL is in hand, and opens it
  with `window.open(url, "_blank", "noopener,noreferrer")`. A fetch failure and a meeting with no organizer link
  are one state (`null`, "This meeting's join link isn't available.") - there is nothing to open either way.
- **The event detail *is* this modal** - the calendar page opens the same component for an existing occurrence -
  so there was no separate view to add the join button to.
- **Known gap, not fixed here:** editing *one occurrence* of a video-conferenced series detaches a copy that
  does not carry `videoMeetingUid` (the series keeps it); nothing mints or moves a meeting for the detached
  copy. Reaching a sensible answer needs a per-occurrence meeting model the plugin doesn't have yet.
  **Update, 2026-09-23:** this bullet only ever described the *non-destructive* half of that same fact (toggle
  left checked through a detach → detached copy silently ends up with no meeting - still true, still an open
  gap). The other half - toggle unchecked through a detach - was not merely a missing feature but a real bug:
  it cancelled the *series'* shared meeting out from under every other occurrence. Fixed; see the dated entry
  below.

Files: `apps/shared/components/calendar/EventModal.tsx`, new
`test/apps/_components/EventModal.videoconf.test.tsx` (16 tests), `RELEASE_NOTES.md` (Unreleased > Features).
Verified: `yarn tsc --noEmit` and `yarn lint` clean; `EventModal.tsx` 100% statements/branches/functions/lines
(measured over its four test files); full suite **273/273 files, 4174/4174 tests, 100 / 99.91 / 100 / 100**
(gates 100/99/100/100 - the same branch figures as the entries above; before this change: 272 files / 4158
tests). That green run needed `--retry=2`: two earlier full runs failed 1 and 32 tests respectively, all in
`contacts/index.test.tsx`, `settings/filters/new/index.test.tsx`, `index.test.tsx`'s bulk-action block and
`settings/appearance/index.test.tsx` - every one of them already documented above as a full-suite-scale flake,
all pass in isolation (275/275 and 89/89 re-runs), and **another agent was running this same suite in parallel
at the time** (which is also why the first two runs left no coverage report at all: vitest skips it when the
run fails, and parallel runs share and wipe `coverage/`). react-shared's own suite, with its half of this
work, is 96/96 files, 1261/1261 tests, 100/99.48/100/100.

### 2026-09-22 (later still) - Domain aliases in the admin console

Not committed, unpublished. The UI half of restapi's new pure-domain-alias feature (that repo's NOTES entry of the same date): a `Domain` can
name another it aliases (`plc.gg` aliasing `powerlevel.gg`) and then receives/sends mail for the same addresses with no mailboxes of its own.
Needs `@rapidmx/react-shared`'s new `Domain.aliasOf` (its own NOTES entry, same date) - not yet published, so `web-client`'s own `tsc --noEmit`
won't see the field until that lands and this repo's dependency is bumped; the code below is written against the field as it will exist.

- **`apps/admin/domains/new/index.tsx`**: a new "Alias of" `<select>` under the domain name, populated from `listDomains({ limit: 200 })`
  filtered to `!d.aliasOf` (only a non-alias domain can itself be aliased - matches restapi's own no-chains rule), defaulting to "None - a
  regular domain with mailboxes of its own". `createDomain({ name, aliasOf: aliasOf || undefined })`. The extra `GET /mail/domains` this adds
  needed no changes to the file's own existing tests: `apiFetch` is `async`, so a mock that doesn't recognize the URL rejects rather than
  throwing synchronously, and the component's own `.catch(() => setPrimaryDomains([]))` absorbs it - confirmed by running the existing suite
  unchanged before adding a dedicated test for the real (populated, filtered, submitted) behavior.
- **`apps/admin/domains/[uid].tsx`**: a new "Alias" panel (below the existing DNS-setup status/checklist) with a plain text input rather than
  a domain-list `<select>` - deliberately, so this page adds **no new fetch call** and every one of its ~20 existing tests (which enumerate
  every URL they expect and throw on anything else) keeps working unchanged. Save disabled until the value actually differs from the domain's
  current `aliasOf`; on success, bumps a `refreshCount` state used as `DomainDnsSetup`'s own `key` prop to force it to remount and re-fetch -
  needed because `DomainDnsSetup` owns its own `domain` state (fetched once per `uid`, not a controlled prop), so a parent-side `updateDomain()`
  call has no other way to make the shared status panel reflect the new value immediately. Server-side validation errors (unknown domain,
  self-alias, chain) surface verbatim via the same `ApiRequestError` pattern every other action on this page already uses.
  - **Latent bug found and fixed while wiring this up**: `DomainDnsSetupProps.onLoaded` is typed as `(domain: Domain) => void`, but
    `DomainDnsSetup` actually calls it with `null` when `getDomain()` resolves to `null` (the existing "falls back to 'Domain not found.'"
    test already exercises this). The page's own previous `onLoaded={setDomain}` tolerated it silently (`setDomain(null)` is fine); my new
    `handleLoaded` initially read `d.aliasOf` and crashed on that same case (`Cannot read properties of null (reading 'aliasOf')`) - fixed with
    `d?.aliasOf`. Left `DomainDnsSetupProps`'s own type as-is (out of scope) rather than widening it to `Domain | null`.
- **`apps/shared/components/admin/settings/DomainDnsSetup.tsx`**: the status `<dl>` gains an "Alias of" row, shown only when `domain.aliasOf`
  is set, alongside a "(no mailboxes of its own)" hint - read-only, shared verbatim by both the detail page and the setup wizard (this
  component's own existing purpose).
- **`apps/admin/domains/index.tsx`**: a new "Alias of" column, `domain.aliasOf || "—"` per row.

Files: `apps/admin/domains/{new/index,[uid],index}.tsx`, `apps/shared/components/admin/settings/DomainDnsSetup.tsx`, their four test files,
`RELEASE_NOTES.md` (Unreleased > Features). Verified: full suite **273/273 files, 4180/4180 tests** (no `--retry` needed this run - no
concurrent agent this time); `tsc --noEmit` fails only on the still-unpublished `aliasOf` field (9 errors, every one exactly "Property
'aliasOf' does not exist on type 'Domain'"/"'aliasOf' does not exist in type '...Input'" - confirms nothing else is broken, this is purely the
package-boundary gap the intro paragraph describes).

### 2026-09-22 (even later) - Adversarial-review fixes: dead search Worker, unvalidated join-link scheme, unbounded list growth

Three independent findings from an outside review, fixed and committed together.

- **A crashed Tier 2 (local search) Worker used to hang every search forever.** `localIndexRpcClient.ts`'s
  `getWorker()` only ever registered a `message` listener; if the Worker died (an uncaught exception, the WASM
  module aborting), nothing ever resolved or rejected the `pending` map's outstanding promises, and
  `searchTier2.ts`'s try/catch is powerless against a promise that never settles, not just throws. Fixed with
  a companion `error` listener that rejects everything in `pending` and drops the module-level `worker`
  reference (plus `terminate()`) so the next `call()` spawns a replacement instead of `postMessage`-ing into a
  corpse. That alone doesn't cover a Worker that's merely **wedged** rather than crashed (an infinite loop, a
  stuck OPFS lock) - no `error` event fires for that at all - so `searchTier2.ts#searchLocalIndex()` now also
  races its own work against a 5 s timeout (`TIER2_SEARCH_TIMEOUT_MS`) and degrades to `{ results: [], hasMore:
  false }` exactly like every other failure mode this function already tolerated. Together these mean
  `apps/www/index.tsx`'s `Promise.all([searchMailbox(...), searchLocalIndex(...)])` call sites can no longer
  block Tier 1's already-arrived results behind a dead/stuck Tier 2 indefinitely - deliberately fixed inside
  `searchTier2.ts` itself rather than by adding a second timeout at each `index.tsx` call site, since this
  function already owns "never throws, never rejects, degrades silently" as its contract.
- **"Join video call" (`EventModal.tsx`) opened `organizerJoinUrl` via `window.open()` with no scheme check** -
  inconsistent with `calendarReminders.ts#joinMeetingUrl()`, which already restricts a reminder's own location-as-link
  to `http:`/`https:`. Reused that same helper rather than duplicating it: a `validatedJoinUrl` derived value now
  gates both the button's `disabled` state and what gets passed to `window.open()`. `undefined` (still loading)
  and `null`/an invalid scheme (nothing safe to open) are told apart the same way the original code told `null`
  apart from `undefined`, purely by reading `organizerJoinUrl` itself alongside the validated value.
- **Unvirtualized message/conversation lists had no ceiling on total accumulated rows.** `MAX_EMPTY_PAGE_CONTINUATIONS`
  only bounds a streak of *empty* pages, not total row count - a fully-scrolled large mailbox kept growing
  `messages`/`conversations` state (and the DOM) without limit. Rather than introduce virtualization (a bigger,
  riskier change - new dependency, layout/measurement implications, this file's existing structure doesn't make
  it a drop-in), capped `appendUnseenRows()` (the one function every "load more" continuation goes through - the
  fresh-search and aggregate-mailbox paths don't accumulate the same way and were left alone) at a new
  `MAX_LOADED_ROWS = 500`, added a matching `atRowCap` early-return inside `loadMore()` (reading `messagesRef`/
  `conversationsRef`, the same refs the rest of that callback already reads instead of closing over state) so a
  capped list stops fetching further pages entirely, and swapped the "Load more" sentinel for a "Showing the most
  recent 500 ... - refine your search or filters to see more" banner once the cap is hit.

Files: `apps/shared/search/localIndexRpcClient.ts`, `apps/shared/search/searchTier2.ts`,
`apps/shared/components/calendar/EventModal.tsx`, `apps/www/index.tsx`, their test files (`test/apps/_search/
localIndexRpcClient.test.ts`, `test/apps/_search/searchTier2.test.ts`, `test/apps/_components/
EventModal.videoconf.test.tsx`, `test/apps/index.test.tsx`), `RELEASE_NOTES.md` (Unreleased > Security, Fixes).

**Cross-reference, not acted on here**: `@rapidmx/react-shared`'s shared `apiFetch`/`authApiFetch` (which this
repo's every API call goes through) has an **open, already-documented CSRF finding** that needs a coordinated
backend fix - out of scope for this pass and not something to act on from `web-client` alone. See that repo's
own NOTES.md for the finding itself.

### 2026-09-22 (yet later) - Second-round adversarial review, follow-up on commit d5766f8

Four more findings from a second review pass of the fixes just above, all addressed in one follow-up commit.

- **"Add video conferencing" gave a raw, confusing 404 on a server without `@rapidmx/meet-plugin` installed.**
  `videoMeetingsApi.ts`'s own doc comment already says a caller offering video conferencing optionally must treat
  a 404 (the plugin's routes simply aren't mounted) as "not available here," not an alarming error - but
  `EventModal.tsx#applyVideoConferencing()`'s catch block surfaced `err.message` verbatim regardless of status.
  Picked the cheaper of the two options the review offered (catching the 404 specifically) over an
  availability-check-on-mount, since the checkbox unconditionally rendering is otherwise harmless (the event
  still saves fine either way) and an extra fetch just to decide whether to show a checkbox felt like the wrong
  trade for this. Now checks `err instanceof ApiRequestError && err.status === 404` and shows "Video conferencing
  is not available on this server." instead.
- **Recipient addresses were case-sensitive cache keys for compose-time encryption lookups.** `ComposeWindow.tsx`'s
  `recipientStatuses`/`lookupsInFlightRef`/`lookupFailuresRef` were all keyed by `recipient.address` verbatim from
  `recipients.ts#parseRecipient()`, which doesn't lowercase - while `@rapidmx/react-shared`'s
  `classifyRecipientTier()` already lowercases domains for its own comparison. The same mailbox typed with
  different casing across To/Cc/Bcc (autocomplete in one field, a pasted address in another) was tracked as two
  independent recipients; if one lookup lagged or failed while the other succeeded, `decideMessageEncryption()`'s
  all-or-nothing check saw a spurious unresolved recipient and denied auto-encryption for a message every *real*
  recipient could actually receive encrypted. Fixed with a new `addressCacheKey()` (`address.trim().toLowerCase()`)
  used everywhere `recipientStatuses` is built or read - **only as an internal cache key**, deliberately: the
  actual `ComposeRecipientInput.address` sent to the server, and shown in the compose fields themselves, is
  untouched, so this doesn't relitigate whether local-parts are "really" case-insensitive (they're not, per RFC,
  even though every real provider treats them that way) for anything that leaves this cache. Also had to
  de-duplicate the "supports encryption" / "no encryption key found" pill list by the same key - it already had a
  latent duplicate-`key` React warning for the same address typed twice (pre-existing, just literal-duplicate
  only), and normalizing made the different-casing case just as common a trigger.
- **The row-cap banner ("Showing the most recent 500...") could show even when the list was already complete.**
  `rowCapReached` (`apps/www/index.tsx`) checked only the row count (`>= MAX_LOADED_ROWS`), not `hasMore` - a
  folder/search whose true size lands at/near 500 with a partial (or otherwise not-page-sized) final page
  correctly turns `hasMore` false, but the banner didn't know that and would still claim rows were being hidden
  behind the cap. Fixed by folding `hasMore` into `rowCapReached`'s own definition (`loadMore()`'s separate
  `atRowCap` guard was left alone - it doesn't need this, since the composite guard it's part of already checks
  `!hasMore` on its own).
- **[Cheap, optional, done anyway] The Worker `error` listener in `localIndexRpcClient.ts` wasn't scoped to its own
  Worker instance.** It only ever read/wrote the module-level `worker`/`pending`, so an already-superseded Worker
  (crashed once, replaced, then - implausibly - firing a second, late `error` event) could reject a healthy
  replacement's in-flight requests and terminate it for no reason of its own. Fixed by capturing the Worker each
  `getWorker()` call creates in its own `created` const and guarding the listener with `if (worker !== created)
  return`, so a stale instance's event can never touch whatever Worker is actually live.

Files: `apps/shared/components/calendar/EventModal.tsx`, `apps/shared/components/mail/compose/ComposeWindow.tsx`,
`apps/www/index.tsx`, `apps/shared/search/localIndexRpcClient.ts`, and their test files
(`test/apps/_components/EventModal.videoconf.test.tsx`, `test/apps/_components/ComposeWindow.test.tsx`,
`test/apps/index.test.tsx`, `test/apps/_search/localIndexRpcClient.test.ts`), `RELEASE_NOTES.md` (Unreleased >
Fixes - appended to, not replacing, the entries the first pass already added there). Verified: `tsc --noEmit`
clean; full suite run twice more (as above, this repo's full-suite run needs `--retry=2` to filter out the
already-documented `contacts/index.test.tsx` toolbar-Email flake, which showed up again, once, in the first of
the two runs here) - clean at 273/273 files, 100/99.9-ish/100/100 (comfortably inside the 100/99/100/100 gate).

### 2026-09-23 - Third-round review: HIGH-severity bug, unchecking video conferencing on one occurrence cancelled the whole series' meeting

Confirmed, traced end to end, and fixed in one follow-up commit on top of the round-2 fixes above.

- **The bug.** `react-shared`'s `expandAllOccurrences()` spreads the master event's fields into every occurrence,
  so every occurrence of a recurring series shares the exact same `videoMeetingUid` - one meeting for the whole
  series. Opening a single occurrence, leaving the default "This event only" scope, and unchecking **Add video
  conferencing** ran `handleSubmit()` → `detachOccurrence()` (react-shared's `calendarMutations.ts`), which
  deliberately never copies `videoMeetingUid` onto the newly detached standalone event (see this file's own
  earlier "Known gap" note, now updated in place above) - so `saved.videoMeetingUid` came back `undefined`
  regardless of the toggle. `applyVideoConferencing(saved)` then ran, but its guard compared `videoEnabled`
  against the component's own **state** variable `videoMeetingUid` - seeded from the series' shared meeting at
  mount and never touched by the detach - not against `saved.videoMeetingUid`. `false === !!<truthy state>` is
  `false`, so the guard never short-circuited, execution fell into the "off" branch, and
  `updateVideoMeeting(videoMeetingUid!, { status: "cancelled" })` cancelled the **series-wide** meeting - every
  other occurrence kept `videoMeetingUid` set and kept offering "Join video call," now pointed at a dead meeting,
  with no warning anywhere.
- **The fix.** A second, narrower guard right after the existing one: `if (!videoEnabled && !saved.videoMeetingUid)
  return { event: saved, failed: false }`. `saved.videoMeetingUid` is the actual just-persisted record, not stale
  component state, so this is `true` for every detach (whatever the checkbox is doing) - and `false` for every
  other save path (plain update, whole-series edit, retry), where the server's response reliably still carries
  whatever `videoMeetingUid` was already stored, since none of those paths' PATCH bodies ever touch that field
  either. Deliberately did **not** touch the "on" branch or the top guard: doing the more thorough-looking thing -
  reading `saved.videoMeetingUid` in the *top* guard too - would have also changed behavior for the still-checked
  detach case (toggle left on through a detach), turning the already-documented, deliberate "nothing mints a
  meeting for the detached copy" gap into "silently mints a brand new one," which is a bigger, unreviewed behavior
  change this bug report never asked for and the plugin's invitee-substitution model hasn't been thought through
  for. Left that gap exactly as documented, just no longer also destructive.
- Test added: a recurring occurrence with a shared `videoMeetingUid`, "This event only" (the default scope),
  toggle unchecked, Save - asserts the detach's own two calls (PUT the exception onto the master, POST the
  detached copy) happen and, critically, that no `PUT /mail/video-meetings/...` call happens at all.
- **Test-mock fallout, not a source bug**: three pre-existing tests (`cancels the meeting...`, `keeps a location
  the user typed...`, `reports a non-API failure of the cancel call...`) started failing once the new guard shipped
  - not because they were wrong to expect a cancel, but because `mockVideoFetch()`'s generic default `updateEvent`
  response (`{ ...occurrence(), version: 3 }`) never carried `videoMeetingUid` at all, for *any* PUT, which the new
  guard (correctly) now reads. Fixed by giving those three tests (all genuinely non-recurring, already-linked
  occurrences, where a real server's PATCH response would echo the existing `"vm1"` back since none of those PUTs'
  bodies touch that field) an explicit `updateEvent` override that echoes `videoMeetingUid: "vm1"` - rather than
  making the shared mock's own default smarter, which would have then had to fake up per-occurrence state to avoid
  wrongly injecting `"vm1"` into the *other* tests that start with no meeting at all.

Files: `apps/shared/components/calendar/EventModal.tsx`, `test/apps/_components/EventModal.videoconf.test.tsx`,
`RELEASE_NOTES.md` (Unreleased > Fixes), and this file's own "Add video conferencing" entry above (the "Known gap"
bullet updated in place, not rewritten). Verified: `tsc --noEmit` clean; `EventModal.test.tsx`/`.round3`/`.round4`/
`.videoconf` all green (75 + 19 = 94 tests); full suite (combined with the react-shared-bump entry below, verified
together in one final run) clean at **273/273 files, 4203/4203 tests, 100/99.88/100/100**.

### 2026-09-23 (later) - Bumped `@rapidmx/react-shared` to 0.14.0 - two already-published security fixes weren't actually reaching users

`package.json` still said `^0.13.0`; since react-shared is pre-1.0, caret semantics never resolve across a minor
bump on their own, and `yarn.lock` had stayed pinned at exactly `0.13.0` - so the sanitizer/key-import fixes
0.14.0 shipped were live in the *published package* but not in web-client's actual dependency tree, despite this
repo directly executing both code paths (`apps/shared/components/mail/reading/bodyHtml.ts` and
`apps/shared/components/mail/compose/quotedBody.ts` call `sanitizeMessageBodyHtml()`; `KeyEnrollmentGate.tsx`/
`UnlockPromptProvider.tsx` drive the key-session module that imports the private keys).

- **What 0.14.0 actually changed** (confirmed by reading the installed package, not just trusting the version
  number): `messageBodySanitizer.js`'s `DISPLAY_FORBIDDEN_TAGS`/`QUOTE_FORBIDDEN_TAGS` now list `svg`/`math`
  outright (DOMPurify's `FORBID_TAGS`), rather than counting on this repo's own second, structural DOM-hardening
  pass (`bodyHtml.ts`) to catch whatever they could still carry through DOMPurify's defaults; and `keySession.js`
  now imports the unlocked/enrolled private keys as **non-extractable** `CryptoKey`s (previously extractable, on
  the reasoning - reverted here - that an XSS able to call `exportKey()` on them already has bigger problems).
- **Why this was low-risk to pull in**: an earlier round already confirmed web-client has independent
  defense-in-depth for both - its own structural DOM pass already forbids most dangerous SVG content even without
  the upstream `FORBID_TAGS` change, and nothing in this repo calls `exportKey()` on a session key, so tightening
  `extractable` to `false` removes a capability nothing here was using.
- **The bump itself (`package.json`/`yarn.lock`, `^0.13.0` → `^0.14.0`) had already landed on `main`** as its own
  commit (`692d515`, "Upgrading react-shared dep") by the time this task reached this session - evidently done in
  parallel by another agent/session working the same coordinated sibling-repo release. This entry's own work was
  verification (`yarn install`, `yarn build`, the full test suite) and documentation
  (`RELEASE_NOTES.md`/this file), not the bump itself.
- **Not quite a no-op for `apps/**` after all**: no new react-shared *API surface* is used, but the sanitizer
  change broke a real, still-relevant test. `test/apps/_reading/bodyHtml.test.ts`'s "removes scripts, frames,
  media..." test fed the sanitizer an `<svg>` containing both dangerous sub-elements (`use`/`set`/`animate`/
  `foreignObject`) and a harmless one (`<circle>`), and explicitly asserted the harmless one survived - true
  under 0.13.0, where only svg's specific dangerous children were forbidden (by this file's own
  `REMOVED_ELEMENTS`, a second structural pass) and DOMPurify's own `FORBID_TAGS` didn't touch `svg` itself. Under
  0.14.0 the whole `<svg>` (circle included) is now forbidden by DOMPurify before that second pass ever runs, so
  nothing under it survives any more - a strictly *more* secure outcome, just one the old assertion no longer
  matched. Updated the test to expect `<svg>`/`<circle>` gone too, with a comment noting `bodyHtml.ts`'s own
  `REMOVED_ELEMENTS` entries for svg's dangerous children are now unreachable through this exact path but are
  kept anyway, deliberately, as defense in depth against a future regression in the upstream `FORBID_TAGS` list -
  **no source change**, only the test's expectation.
  `quotedBody.test.ts` (the sanitizer's other caller) has no svg/circle assertions of its own and needed nothing.

Files: `test/apps/_reading/bodyHtml.test.ts` (the one test fix above); everything else is dependency-only,
already committed in `692d515`. This follow-up itself touches only that test file, `RELEASE_NOTES.md`
(Unreleased > Security) and this file. Verified: `yarn install` clean (pre-existing, unrelated eslint
peer-dependency warning only), `yarn build` clean (`checkDistReferences` passes), `tsc --noEmit` clean, `eslint`
clean on the changed test file, full suite clean at **273/273 files, 4203/4203 tests, 100/99.88/100/100**
(`--retry=2` needed for the same documented `contacts/index.test.tsx` flake - and, this run, for genuine
`ECONNREFUSED`-style collisions from another agent's own concurrent `vitest run --coverage` in this same working
directory, which briefly left this repo's coverage lock held by a stale process from an earlier, wrongly-trusted
"completed" backgrounded run of this session's own - see this repo's own project memory / the harness's own
background-task notes for why a "completed" notification on a long `pool: "forks"` run isn't always final;
sidestepped with `--coverage.reportsDirectory=coverage-verify-round4`, a scratch directory deleted again once the
real run had a clean result in hand).

### 2026-09-23 (later) - `stopImpersonating()`'s GET became POST in `@rapidmx/react-shared` (ecosystem CSRF fix); two mocked test conditions updated to match

A coordinated cross-repo CSRF hardening pass (`@rapidrest/service-core`/`@rapidrest/auth`/`@rapidrest/auth-server`/
`@rapidmx/react-shared`, not run from this repo) changed `react-shared`'s `stopImpersonating()` from GET to POST
(a state-changing GET is exploitable via a bare navigation, bypassing CSRF defenses entirely - see
`@rapidrest/auth`'s `BaseImpersonationRoute`). This repo doesn't call the endpoint's URL/method directly - both
`MailShell`/`AppShell` call `stopImpersonating()` through `react-shared`, so no source change was needed here -
but their tests' mocked `fetch` implementations branched on `init?.method === "GET"` to decide which response to
return for that URL, and would have silently stopped matching (falling through to whatever the next branch/default
does) the moment this repo picks up the new `react-shared` version. Updated both to `"POST"` in
`test/apps/_components/MailShell.test.tsx`/`AppShell.test.tsx` (3 occurrences each) ahead of that dependency bump,
so the tests don't quietly start passing for the wrong reason. No `react-shared` version bump made in this repo as
part of this change - that's a separate, deliberate dependency-bump step (see the 0.14.0 entry above for the
pattern), and this fix is safe to land before or after it either way.

### 2026-09-23 (later still) - uninstalled plugins can be reinstalled; "Add by name" lookup moved to a query string; `<host>` setting defaults; "Notifications" switch

JP (screenshots of the powerlevel.gg admin console): an uninstalled plugin ("Booking pages", "Data deleted") had no way back, and Add by name answered "Request failed.". Nothing committed, no version bumps. Companion changes in `restapi`, `react-shared`, `meet-plugin`, `autodiscover` (each has its own Unreleased entry).
- **Reinstall.** The server never refused (`POST /` cancels a pending purge and 409s only while one is *running*); the gap was the UI: `UninstalledPluginRow` had only Retry. It now has **Install** (disabled while `running`), which reads the latest version with `planPluginChange(name)` (query string) and goes through the normal `install()` (dependency preview, purge-cancelled warning). `onRow()` takes any `{uid}` so the row is busy meanwhile.
- **Add by name = "Request failed."** (empty body, empty `statusText` over HTTP/2, so `decodeApiResponse()` falls through to its default). The lookup was the only call with a scoped name in the URL *path* (`/registry/%40rapidmx%2Fbooking-plugin`); every other call sends it in the query. Envoy Gateway's ClientTrafficPolicy default `escapedSlashesAction: UnescapeAndRedirect` unescapes `%2F` and redirects to a path with no route. **Inferred from the code and Envoy's documented default - the live host was not queried (the access was denied), so unconfirmed.** Fix: `restapi` `GET /registry?name=`, `react-shared` `lookupPluginPackage()` uses it (path form kept server-side). Needs the new restapi on the server *and* the new react-shared here; web-client's `node_modules/@rapidmx/react-shared` is a copy, so I copied the built `dist/admin/pluginsApi.*` over it to run the tests - `yarn install` with the released react-shared replaces it.
- **`<host>` defaults.** Manifest defaults are static, so a string `default` may contain `<host>`; `suggestedHost()` in `PluginsManager.tsx` fills in `window.location.host` when nothing real is saved (nothing, `""` - an older manifest's seeded default - or the literal placeholder an older server stored) and `save()` sends it as shown. Clearing the field still clears the setting (it comes back as the suggestion on reopen). It is now only the fallback for a plugin installed before the server did this itself: **JP wants the value saved and active at install, no form save** - `restapi` `installRow()` resolves `<host>` from the request (`X-Forwarded-Host`, else `Host`), `PUT` on a version change fills an empty one, and the server's `PluginStateStore` seeds the default plugins from `mail:dns:mx_hostname`. An already-installed plugin keeps its stored manifest (default `""`) until its version changes, so the form still offers it there.
- **Notifications switch.** `notifications/preferences.ts` (`getNotificationsEnabled()`), read by `notify()`: off means never shown, still recorded in the history; the menu item dismisses what is on screen. It keeps the localStorage key `rapidmx-new-mail-popups` so existing "off" choices carry over. `AppShell` already passed `showNotificationSettings`, so it shows in every app. Desktop notifications for new mail follow the same switch (as before).
Verified: `tsc --noEmit`, web-client suites for plugins/notifications/UserMenu/mail (447 tests), restapi plugin suites incl. the route suite on Mongo and SQLite, react-shared `pluginsApi`, meet/autodiscover `plugin.test.ts`.

### 2026-09-23 (night) - mobile conversation opens the whole thread; Reply All in the card footer

JP (phone screenshot of `/messages/:uid`): tapping a conversation showed only the latest message. Cause: `handleOpenConversation()` on mobile (`isMobile`) navigated to the single-message route (`apps/www/messages/[uid].tsx`, comment "no dedicated mobile thread route yet"); only the desktop's `hidden md:flex` pane used `ConversationThreadPane`. Fix: the navigation carries `?conversation=<conversationId>`; the page reads it with `useLocationSearch()` and renders `LazyConversationThreadPane` (opened at the uid, `mailboxUid` from the fetched message) under a back link, in a `flex flex-col h-full` wrapper like the single pane. The thread marks read and loads attachments itself, so the page's own `useMarkMessageRead`/`useMessageAttachments` get `null` in that mode. `ConversationThreadPane` now takes `ConversationThreadHead` (`conversationId`, `subject`, `messageCount`) - the page only has a message, so it passes `messageCount: 1`. Desktop's Enter-opens-message-page still goes to the single message (unchanged). New-mail notification links (`/messages/:uid`) also stay single-message. Reply All: third footer button in `MessageDetailPane` (`aria-label` "Reply all to this message", distinct from the header's "Reply All"). Not verified on a real phone.
Verified: `tsc --noEmit`, `yarn lint`, `index`/`messages`/`MessageDetailPane*`/`ConversationThreadPane` suites (one unrelated focus test in `MessageDetailPane.test.tsx` failed once under load and passes alone, with and without these changes).

### 2026-09-23 (late night) - phone swipe actions, calendar swipe, header search + floating compose, full-screen compose, no shortcuts item

JP, all "on mobile". Nothing committed. Not verified on a real phone (jsdom touch events only).
- **`apps/shared/gestures/useSwipe.ts`** - one-finger horizontal swipe on touch events only (mouse untouched): decides after 10px whether it is a swipe or a vertical scroll (a scroll stays one), commits at max(80px, width/3) or on a fling (>0.5px/ms and >=40px), sets `touch-action: pan-y`, gives up on a second finger. Used by `SwipeRow` and the calendar.
- **Mail rows: `SwipeRow` (`components/mail/SwipeRow.tsx`).** Renders the row's own element (`li`, or the conversation row's `div`) so nothing else about the rows changed; the green (archive, right to left) and blue (folder, left to right) panels are `absolute` children just outside the row's edges (`right-full`/`left-full`), so they travel with it - the list needs `overflow-x-clip` (not `-hidden`, which would make the `ul` a scroll container). Archive slides the row off and awaits `onArchive()`; a `false` brings it back. Move snaps back and opens `MoveToFolderDialog`. In `apps/www/index.tsx`: `swipeArchive()`/`swipeMove()` go through `runBulkAction()` (`bulkArchive`, `moveMessages`) like the selection bar; a conversation resolves its messages with `loadOpenConversation()` (only the ones in the listed folder). `swipeEnabled = isMobile && !selectMode && !aggregateFolderType && !isSearching && !listingOutbox`.
- **Calendar (`apps/www/calendar/index.tsx`, done by a subagent).** `useSwipe` on a wrapper around the view area (not the toolbar), off while an event is dragged (`dragging` from `DndContext`) or the editor is open; calls `shiftView()` like the buttons. **Direction: swiping LEFT shows the NEXT period and RIGHT the previous, as most apps do (JP first asked for the reverse - left = previous - then had it flipped on 2026-09-24); it is `SWIPE_PERIOD_SHIFT` in `components/calendar/swipeNavigation.ts`, one line to flip.** No calendar view scrolls horizontally today; if one ever does, the swipe must ignore touches that start in it. A phone in landscape wider than 768px counts as desktop (`useIsMobile`), so no swipe there.
- **Search (reworked 2026-09-24: JP - "search should always work on all devices, even for conversations").** `MailShell`'s phone header row is the folders button + a slot (`mobileSearchSlot` in `MailShellContext`, a state so consumers re-render once it exists); `InboxPage` portals its one search input into it when `isMobile`, and renders it in the list on a desktop - in both arrangements. Three flags in `apps/www/index.tsx` now, all derived once: `isSearching` (a query is held, not in an aggregate view), `asConversations = preferences.showAsConversations && !isSearching` (the list's *data*: conversation summaries vs messages - every fetch/paging/select/row-count use), and `threadPane = preferences.showAsConversations` (the *reading pane* and what the keyboard acts on: the whole thread, whatever the list is showing). `groupedResults = isSearching && preferences.showAsConversations` renders `groupByConversation(messages)` - results grouped by `conversationId ?? uid`, in ranking order, each group a header ("N matching messages") over the same row markup as the flat list (`renderMessageRow`, extracted) - so only matching messages are listed. `handleSelect()` on a result opens `openThreadOf(message)`: the thread pane (or, on a phone, `/messages/:uid?conversation=<id>`) via a `ConversationThreadHead` built from the message (`messageCount: 1`); `ConversationThreadPane` expands from the picked message to the newest. The conversation is not known to have more messages than matched until the thread loads, hence the header counts matches, not the thread. Swipe is off while searching. The floating **New message** button is `MobileComposeButton` in `MailShell` (`fixed right-4 bottom-[4.5rem]`, just above the `h-14` bottom bar; accessible name "New message" so it doesn't collide with the sidebar's "Compose").
- **Compose full screen.** The compose sheet's class list had `relative` *and* `fixed inset-0` on a phone; Tailwind emits `.relative` after `.fixed`, so it won and the sheet sat in the flow of the fixed bottom-right container (the partial window in JP's screenshot). `relative` is now desktop-only (the resize handles need it there). Watch for the same pairing elsewhere.
- **UserMenu** hides "Keyboard shortcuts" with `useIsMobile()`.
Verified: `tsc --noEmit`, `yarn lint`, `test/apps/index.test.tsx` (267), `gestures`, `calendar` (55), `UserMenu`, `MailShell`, `ComposeWindow`, `ComposeContext`.

### 2026-09-24 - admin menu on a phone; account menu name; Profile settings page; device time zone

JP, from phone screenshots of the admin console and the account menu. Nothing else than what is written here was decided by me.
- **Admin console on a phone:** the ten-plus items didn't fit `BottomTabBar`'s equal-width flex (labels overlapped). `AdminShell` no longer renders the bar; a `md:hidden` hamburger ("Open menu") in its header opens react-shared's `Drawer` (left) titled "Admin" holding `<nav aria-label="Admin menu">` of the same `navItems` (mailbox-scoped sections stay off it, as off the rail); picking a link closes it (the link still does its page load). `EscrowShell` and `AppShell` (4 items) still use `BottomTabBar`, which now also scrolls sideways with a min item width (react-shared) - JP only asked for the admin console; the escrow console has 6-7 items and may want the same.
- **Account menu name** (agent-built, reviewed by report only): profile name -> display name of the mailbox the user OWNS (`ownerUserUid === userUid`, shared/delegated never) -> username alias -> uid; initials follow. Runs only with `authServerUrl` and no profile name. Inside the app frame it reads `MailConnectionContext`'s mailboxes (a second `listMailboxes()` broke the "lists the mailboxes once" test in `AppRouter.mailConnection.test.tsx`) and waits while that is "checking"; outside it (admin/escrow consoles) it lists them itself.
- **Profile page** `apps/www/settings/profile/index.tsx` (first in `SETTINGS_SECTIONS`): mailbox `displayName` (validated like the server: trimmed, non-empty, <=255, no `@` or look-alikes, no line breaks) and `timezone` (`timeZoneOptions()` select + "Use this device's time zone"). Only changed fields are sent with the current version. A saved `"UTC"` is treated as the placeholder the server gives a mailbox nobody chose a zone for, so the device zone is preselected (unsaved until Save) when the device is not on UTC - a mailbox truly meant to be UTC by someone in another zone sees the note and can pick UTC. Not disabled for a delegate on a shared mailbox (the server's refusal shows as a pop-up); saving doesn't refresh the shell's mailbox list, so the mailbox switcher label and the menu fallback stay stale until reload.
- **Device time zone:** react-shared `deviceTimeZone()`/`timeZoneOptions()`; `autoProvisionMailbox()` sends it and restapi's `POST /mailboxes/auto-provision` stores it when `isValidTimeZone()` (else UTC); `MailboxCreateForm` starts on it. Existing mailboxes are not migrated.
Verified: `tsc --noEmit`, `yarn lint`, AdminShell (26), UserMenu (55), profile page (23), SettingsShell, MailboxCreateForm page, index (271), and the full suite before the last three changes.

### 2026-09-24 (later) - the calendar swipe is animated (`useSwipeSlide`)

JP: the swipe worked but was hard to see; wanted the view to visibly slide, as in Outlook mobile. `apps/shared/gestures/useSwipeSlide.ts` wraps `useSwipe()`: the contents (an inner element, `contentStyle`) follow the finger (transition off); on commit they slide out in the swipe's direction (200ms), `onShift()` (the page's `shiftView()`) runs while they are off-screen, the new contents are put at the opposite edge without a transition, then slide in (200ms). A short swipe slides back. Timed with `setTimeout`, not `transitionend`, so a skipped transition can't stall it; `sliding` blocks a second swipe until it ends; timers are cleared on unmount; `prefers-reduced-motion` skips it (immediate `onShift`). The clipping outer element (`overflow-hidden`, `touch-action: pan-y`, handlers, `ref` for the width) is separate from the inner one so the contents can leave without widening the page. It is a slide-out/swap/slide-in of one element, not a three-page carousel: the adjacent period isn't rendered beside the current one (it would need its events fetched ahead), so the old period isn't visible while dragging - only the finger-following contents and the empty space behind. `data-swipe-phase` (idle/dragging/sliding) is on the content element for tests. Tests: `test/apps/gestures/useSwipeSlide.test.tsx` (fake timers), `test/apps/calendar/index.swipe.test.tsx` ("the slide"; the older tests there use `mockMatchMedia(true)`, which also answers `prefers-reduced-motion` true, so they exercise the immediate path).

### 2026-09-24 (later still) - the wheel moves through the calendar (`useWheelPaging`, `useEnterSlide`)

JP: use the desktop mouse wheel to scroll month to month / week to week / day to day, infinite, no pause. Asked what the wheel should do in the time-grid views, which already scroll the hours with it; JP's answer (kept verbatim in spirit): month view - the wheel scrolls month to month; week / work week / day - the wheel scrolls the hours, and at the end it carries on into the next period's hours (scrolling down past 11pm shows the next day's hours; the same in reverse), and week/work week do the same with weeks; vertical slide.
- **`useWheelPaging(ref, { enabled, getScroller, onStep })`** (`apps/shared/gestures`): a non-passive `wheel` listener on the clipping element that also carries the swipe (`swipe.ref`). No scroller (month): every 100px of wheel movement (`WHEEL_STEP_PX`, one notch) is a step, a big turn several, the remainder carries, direction change or 250ms idle resets. With a scroller (`[data-calendar-scroller]`, set on `TimeGridView` and `SplitDayView`): the browser scrolls it as usual (event untouched) and only 80px pushed against an end (`WHEEL_EDGE_PX`) steps, once, with `edge: "top"` (arriving after going on) or `"bottom"` (after going back); 100ms afterwards the wheel is left to settle the new page so one hard push isn't two steps. Line/page delta modes are converted; Ctrl+wheel and sideways-dominant movement are ignored. The event is `preventDefault()`ed only when it counts towards a step.
- **`useEnterSlide()`**: the swap is immediate (no waiting for an animation, so a wheel kept turning never queues) and the new contents start 56px below (next) or above (previous) at 0.35 opacity and settle in 140ms; a step mid-settle restarts from its start. Sits on its own wrapper inside the swipe's content element, so the touch swipe's horizontal transform and this vertical one don't fight. Reduced motion: no movement.
- **Page (`apps/www/calendar/index.tsx`):** enabled when `!isMobile && !dragging && !modal`; `onStep` = remember the arrival edge, `shiftView(direction)`, `wheelSlide.enter(direction)`; a layout effect on `viewDate` puts the scroller at 0 / its bottom. Works because events are loaded for the whole calendar once and the visible range is computed locally, so a period change is instant (no loading state to wait for).
- **Not a true continuous timeline:** the next day is not rendered under the current one, so there is a jump (with the slide) at each edge rather than a seamless scroll, and the header row (it scrolls with the hours) belongs to the day being shown. Real seamlessness would render adjacent periods stacked with their occurrences computed for three ranges. A touchpad's inertia can carry a flick through several steps. Not tried in a real browser.
Verified: `tsc --noEmit`, `yarn lint`, `test/apps/gestures` (31), `test/apps/calendar` (66: month stepping and direction, the slides, day/week carry-over both ways with the scroll position, off on a phone and while the editor is open).

### 2026-09-24 (evening) - meeting invitations in messages: card, RSVP chip and popover, propose a new time

JP: an invitation's `.ics` only downloaded; Outlook shows Accept/Decline (and an RSVP button with a conflicts check in the list) and mails the sender. Server half is in restapi (`/calendar-events/invite/:messageUid`, see its NOTES); this is the client.

- **One `MessageInvite` per message through a shared cache** (`apps/shared/components/mail/invite/inviteStore.ts`, 30 s TTL; a 404 is remembered, a failed lookup is not cached and is never retried automatically). The reading-pane card, the list row chip and its popover all use it, and every answer goes through `storeInvite()`, so an answer given in one shows in the others.
- **`InviteCard`** (`mail/InviteCard.tsx`): rendered by `MessageDetailPane` between the notices and the body only when the message has a `text/calendar`, `application/ics` or `.ics` attachment, is not `encrypted` (the server holds only ciphertext) and is not in Drafts/Outbox. Heading and buttons come from the server's `can*` flags (REQUEST -> Meeting invitation; CANCEL; REPLY -> one line with `invite.reply`; COUNTER -> "X proposed a new time" + Accept proposal; anything else -> Calendar event). The `.ics` chip is hidden from the attachment list only while the card is drawn (kept while the lookup is out, on a 404 and on a failure). All-day dates are drawn in the invitation's `timezone` (UTC if absent) with an exclusive end.
- **`InviteRowChip`** (list): only for `meetingMethod === "REQUEST"` and not encrypted, so the lookup is only made for those rows (not deferred until the row scrolls into view). It sits beside the row's open button, not inside it, and stops click and touch events (including its popover's, which React nests under it) so pressing RSVP neither opens the row nor starts a `SwipeRow` swipe. Pointer events are not stopped, so other open popovers still close on an outside click. Conversation parent rows use `ConversationSummary.latestMessageUid` / `latestMeetingMethod`; their answers live in `ConversationList`'s own state (which is why they do not call `onMeetingResponded` - only child rows do, with the real message).
- **`InviteRsvpPopover`**: a `PopoverPortal` on desktop (360 px, height estimated from the day view), a `Modal` on a phone. Day view (`InviteTimeline`): hour rows from two hours before the meeting to two after (at least five hours), the invitation highlighted, overlaps side by side, conflicts in red (named "conflicts with this meeting" to screen readers), tentative events dashed, all-day events listed above. Footer: Accept, Decline, "?" (Tentative), "..." (Propose new time, Open in calendar). Propose new time (`ProposeTimeForm`) prefills the invitation's own time in the reader's zone and sends ISO instants plus an optional comment.
- **Not tested in a real browser:** the popover's placement, the day view's height estimate against the real timeline, and the "..." menu near a popover edge (jsdom lays nothing out).

### 2026-09-24 (night) - calendar event dialog: read-only details first, Google-style quick create and More options

JP: clicking an event (an invitation he did not create) opened the edit form; wanted read-only first with Modify for the organizer, and the New Event card to look and work like Google Calendar's quick-create popover and its expanded card (still a popover, not full screen).

- `EventModal` is a thin wrapper (still exports `VIDEO_LOCATION_PLACEHOLDER`) drawing three faces through one `EventShell` frame: `EventDetails` (read-only; organizer sees Modify, an invited reader sees RSVP with the given answer marked and no Modify), `EventQuickForm` (new event: popover beside `anchor`, bottom sheet on a phone) and `EventExpandedForm` (card; "More options" and Modify). `EventEditor` owns the single set of form values (`EventFormValues`), so quick to expanded keeps what was typed (the frame's element tree is identical for every variant so React never remounts). All the old save logic moved into `EventEditor` unchanged in behaviour: `toSeriesFields`, the save-order and video rules (`applyVideoConferencing`), the `savedEvent` retry, the "This event only" no-rule detach and the `VIDEO_LOCATION_PLACEHOLDER` semantics.
- **Close semantics.** X or Escape in Modify returns to the details, edits discarded (no dirty tracking). A backdrop press does nothing while the form holds anything. Closing after a stored-but-video-failed save calls `onSaved`. Delete now lives only in the details view (recurring keeps its this-event/series two-step).
- **Times** are wall-clock strings read in `formZone` (the device zone until the Time zone select is used; then instants are kept and the event is stored with the chosen zone). A start change shifts the end by the same delta. The reminder row converts minutes/hours/days/weeks locally but stores minutes only (the model has one reminder). Recurrence presets map to plain rules; Custom opens `RecurrenceEditor` (`hideToggle`).
- **Anchors.** The calendar views pass an `EventAnchor` (`anchorOf(element, "side"|"below")`); `MonthView` has an optional `onSelectSlot` and `initialAllDay` makes an all-day new event. A slot click is still 30 minutes (the existing slot size).
- **Not built (the model or API has nothing behind them):** Find a time (no free/busy route or client), description (`CalendarEvent` has no description field - adding one needs the restapi model and react-shared), visibility, guest permissions, Task and Appointment schedule tabs.
- **Not verified in a real browser:** popover placement and clamping, drag, the two-column card at 880 px, and `ResourcePicker`'s `PopoverPortal` (z-50) against the z-1000 shell (same as under the old Modal).
- Tests: `EventModal.newEvent/.details`, `EventShell`, `eventFormat` and `eventModalHelpers.tsx` are new; the existing EventModal test files moved onto Modify and More options (`renderModal(occ, props, view)` in round3/4/videoconf presses Modify unless `view`). Pitfall: scripts run through Bash heredocs lose backslashes; use the Write or Edit tools for regexes.

### 2026-09-24 (night, later) - Task and Appointment tabs; description, visibility, guest permissions, Find a time, change requests

**Replaces the earlier "Not built" line of the calendar event dialog entry.** Server side is in restapi (see its NOTES, 2026-09-24 event fields, free/busy and the late fixes).

- **Tabs.** `EventModal` (create mode only) gained `QuickCreateTabs` (WAI-ARIA tablist, automatic activation, arrows wrap, Home/End). `EventEditor` still owns the Event values; with a `quickCreate` prop it renders `QuickCreateFaces`, which stays mounted and keeps the Task and Appointment drafts. Title, mailbox and calendar are shared. `EventEditor` without `quickCreate` is always the expanded card. A tab change refocuses the selected tab (each face remounts the strip) and resets `expanded`, so the Event form is never lost.
- **Task tab**: `findWellKnownFolderUid(mailbox, "tasks")`, `listTaskLists`, then `createTask`; a date-only due date is local midnight, as the Tasks app writes it. The calendar shows no tasks, so success is `notify()` "Task added" and a close. The Tasks app has no full editor or deep link, so More options is an expanded card (notes, priority, reminder, My Day). No assignee (no user picker).
- **Appointment tab**: shown only when `pluginNav.settingsSections` has the booking plugin's `booking-types` section (`bookingSettingsHref()`, passed as `bookingHref`) - the only client-side plugin signal, since the plugin list is admin-only. `apps/shared/calendar/bookingPlugin.ts` mirrors the plugin's `POST /api/mail/booking-types` (its own client is in the plugin's `apps/`, not importable): one meeting type named after the title, one window per selected day, `bufferAfterMinutes`, slug from the name with `-2`..`-5` retry on 409; success shows `${origin}/book/<mailbox>/<slug>` with `CopyButton`; More options links to `/settings/booking-types/new?mailboxUid=`.
- **Only what changed is sent.** `dialogFields()` (`eventDialogFields.ts`) sends description, visibility and the guest flags only when they differ from what the event started with (HTML compared canonically, so a rewrite of the same text is not a change; an emptied description sends `null` for both), so saving an untouched event asks for no re-invite.
- **Description.** `DescriptionEditor` is TipTap (already a dependency) with a trimmed StarterKit (no heading, quote, code, rule, strike, gapcursor or trailing node) and plain-text paste; `LazyDescriptionEditor` fetches the chunk on first draw and remembers it (deliberately not `React.lazy`, so a failed download can retry). Read-only display is `EventDescriptionView`, built from `parseEventDescription()` - no `dangerouslySetInnerHTML` anywhere.
- **Find a time** (`FindATime`, `findTimeGrid.ts` - a file named `findATime.ts` would clash with `FindATime.tsx` on Windows): fetches the day plus 6 more in one request with a 300 ms debounce and a per-effect `current` flag for stale answers; asks about the organizer plus guests (max 50); `minuteOfDay()` for positions so blocks line up with the hour labels on DST days; suggested times are weekdays 8:00-18:00 in the form zone. Unknown/restricted people are never drawn or counted as free.
- **Guest changes.** `RequestChangeForm` (uid, `canChange`, `canInvite`) is used by EventDetails and InviteCard. Time fields are omitted for a series (the request acts on the master row) and for an all-day event. A hidden guest list shows only the reader plus "The organizer has hidden the guest list".
- **Live updates.** `apps/shared/calendar/calendarLiveUpdates.ts` and an effect in the calendar page: only `redacted` calendar-event pushes are handled (refetch by uid; 404 removes it); other calendar-event pushes are still not consumed.
- **Profile.** "Free/busy visibility" is disabled for a mailbox shared with the reader (`isSharedWithMe`; a manager delegate could change it server-side but the client cannot tell that role apart).
- **Fix found in a real browser:** `EventShell.place()` threw when a `ResizeObserver` notification arrived after the popover had closed on save (`reading 'offsetWidth'` of null), crashing the page to "Something went wrong" right after a slot-click save; it now returns when the dialog is gone.
- **Not verified in a real browser:** popover placement and clamping (including the taller Appointment form), drag, the 880 px card and the phone card, the Find a time grid layout and hatch patterns in both themes, the real contentEditable (focus, selection, IME, Ctrl+K), and `ResourcePicker`'s `PopoverPortal` (z-50) against the z-1000 shell.
- Pitfalls: scripts run through Bash heredocs lose backslashes (use the Write or Edit tools); the CopyButton's `role="status"` span sits beside the tab content's own status text, so wait for the booking link with `findByLabelText("Booking link")`.

### 2026-09-25 - own mailbox first and default; Back to mail; erasing a deleted mailbox's data

JP's clean install: shared mailboxes were listed before his own and were the default in Mail/Contacts/Tasks; the admin console had no way back to the app; a deleted mailbox's address could not be reused.

- **Primary mailbox is defined once**, in `apps/shared/mail/primaryMailbox.ts`. Own = `ownerUserUid` is the signed-in uid; shared = not own and (`accessRole` "delegate", or ownerless; with no `accessRole` and a known user, anything not the user's own). Primary = own (earliest `dateCreated` if several), else the first non-shared, else the first. `orderMailboxes()` = primary, other own, then shared, each by name. Every shell that lists mailboxes (`useMailConnection`, `ContactsShell`, `TasksShell`, `SettingsShell`, `CalendarShell`, `ComposeWindow`) orders the list it fetched with it and every default uses `primaryMailboxUid()`; never use `mailboxes[0]` or a bare `find(ownerUserUid === userUid)` for a default. An explicit `?mailboxUid=` and a compose session's mailbox win. Root cause was the shells' `mailboxes[0]` fallback over the server's order.
- **`UserMenu` has an opt-in `showMailLink`** ("Back to mail", `href="/"`), on in `AdminShell` only.
- **Leftover-data UI** uses `leftoverConflictOf()`, which reads `ApiRequestError.details.reason` (the console never parses the 409 message). `EraseLeftoverDataDialog` is keyed by address and owns its own polling; closing it only stops watching. `LeftoverMailboxesSection` keeps the dialog mounted when the last row disappears, because a remount would reset it to "confirm". The admin pages live under `apps/admin/...`.

### 2026-09-25 - collapsible Mail sidebar sections; floating action button on phones

- **Sidebar sections.** Logic in `apps/shared/mail/useCollapsedSections.ts` (`useSidebarSections`, `sectionChosenOpen`, `read/writeSectionChoices`, `ALL_MAILBOXES_SECTION = "all"`), markup in `components/mail/layout/SidebarSection.tsx`, the chip in `FolderBadgeChip.tsx`. Storage is `rapidmx:mail-sidebar-collapsed:<userUid>` holding `{sectionId: collapsed}` (booleans only; any read or write failure is swallowed). Default: All mailboxes and the primary mailbox (`primaryMailboxUid()`) open, others collapsed. With one mailbox there are no toggles and no badge, and a stored choice is ignored. Collapsed lists stay in the DOM with `hidden`, so tests query them with `{hidden:true}`.
- **No locking.** Every section - the primary mailbox and the one holding the open folder included - can be collapsed, and a collapsed section stays collapsed across reloads. **Navigation opens:** when the active section changes from one defined section to another (a sidebar click, a link, a search result) the new section shows expanded through an in-memory, non-persisted override derived while rendering (no effect); the first section that becomes known (address read, mailboxes loaded) is not a navigation, so a reload onto a collapsed section stays collapsed; toggling the opened section clears the override and persists the opposite of what was showing.
- **Badge:** `unreadBadgeTotal()` sums unread over all folders except `UNREAD_BADGE_EXCLUDED_FOLDER_TYPES` in `folderCounts.ts` (drafts, outbox, sent_items, deleted_items, junk; consistent with `badgeFor()`), so mail a filter rule filed in Archive or a user folder still shows; Junk/Deleted were left out on purpose as noise. All mailboxes sums the same kinds across mailboxes. The chip shows only when collapsed and above 0; the accessible name is "<label> N unread".
- **Default view:** an address that names nothing opens All Mailboxes > Inbox (`aggregate=inbox`) when there is more than one mailbox, and that mailbox's Inbox otherwise; `?aggregate=`, a valid `?mailboxUid=` or any `?folderUid=` wins, an invalid `?mailboxUid=` gives the default. Nothing is selected until the address has been read (`selectionRead`). The primary mailbox is still the mailbox for Compose, the mobile compose button, the new-message shortcut, key unlocking and `apps/www/index.tsx`'s `activeMailboxUid` while the merged view is open. **Consequence to know:** the existing aggregate-mode limits apply on a default load with 2+ mailboxes - search is disabled ("Open a mailbox's own folder to search") and keyboard list actions, swipe and select mode are off.
- **Native `<select>` pop-ups:** a global rule in `app.css` gives `select option`/`optgroup` the opaque `--rr-color-*` colours - a `bg-transparent` select's pop-up is filled white by the browser while the options inherit the page's light text (the compose From picker was unreadable on the dark theme).
- **Not collapsible on purpose:** Contacts/Tasks (a mailbox `<select>`, no sections) and the calendar's My calendars groups (their checkboxes drive what is drawn, so hiding them - or defaulting shared mailboxes to hidden - would hide state that is on screen).
- **`FloatingActionButton`** (`apps/shared/components/layout/`): the shared round phone-layout primary action `{label, icon}` plus any button attributes, with Mail's classes verbatim (`md:hidden fixed right-4 bottom-[4.5rem] z-30 ...`). Calendar ("New event", shown with a mailbox and calendar folder and no open modal) and Contacts ("New contact", hidden in `mode === "new"`) render it when `useIsMobile()` is true and hide their top button then (`!isMobile` in the calendar toolbar, `ContactsToolbar hideNew`); Mail's `MobileComposeButton` uses it too. `useIsMobile()` is false on the first render, so a phone shows the old top button for one frame. Tasks keeps its inline quick-add row.
- Not verified on a real phone: the placement of the floating buttons.

### 2026-09-25 - phone navigation drawers are full screen

Every `Drawer` call site (Mail folders, Calendars, Contacts, Tasks, Settings, Admin menu, the Contacts/Tasks sidebars) passes `fullScreen`, a new react-shared `Drawer` prop (`fixed inset-0 w-full`, safe-area padding top and bottom); the default is still the 18rem strip, so other consumers are unaffected. Needs the react-shared release that has the prop.

### 2026-09-25 - cross-mailbox search

JP: search must work across all mailboxes (it was disabled in the All mailboxes view, which is now the default landing view). Replaces the earlier note that search is off in the aggregate view.

- **Scope.** `apps/www/index.tsx` searches every readable mailbox (`mailboxFolders` entries without `error`, ordered by `orderMailboxes`, capped by `SEARCH_LIMITS.maxMailboxes` = 25) in the aggregate view, or after "Search all mailboxes" from a folder; a single mailbox is the same code with a list of one. Helpers are in `apps/shared/search/crossMailboxSearch.ts` (`SEARCH_LIMITS`, `mergeSearchResults` pooled per tier, `runLimited`, `withTimeout`, `classifyFailure`); tests shrink the mutable `SEARCH_LIMITS`, never write it elsewhere.
- **Fan-out.** Phase A (Tier 1 server + Tier 2 local index) then phase B (Tier 3) per mailbox, 4 mailboxes at a time; page size `max(10, ceil(50 / n))` per mailbox. Ordering stays relevance-based; hit identity is `mailboxUid + entityUid`; conversation groups are keyed `mailboxUid + conversationId`. The cursor is one `CompositeCursor` per mailbox (`tier3Total` replaced reading the Tier 3 cache length); a mailbox failing a later page is dropped from that search. A failed, denied or timed-out mailbox is named in a non-blocking notice and the others' results stay; the search only fails if no mailbox could be searched. There is no AbortController (`searchApi.search` takes no signal): a superseded query stops scheduling further mailboxes and late answers are dropped by run id.
- **Tier 2 caveat.** The local index is built only for the active mailbox (`LocalIndexLifecycle`), so other mailboxes get Tier 2 only if they were indexed in an earlier session and are unlocked now; otherwise Tier 3 (200 candidates, server-narrowed) is the only route to their encrypted mail, and locked mailboxes get neither. The UI says which applies to each mailbox. Searching an unlocked never-indexed mailbox makes `initLocalIndex` create an empty index for it.
- **Actions on results.** Archive, Delete and Report junk run per hit's mailbox (`inEachMailbox`); Move to is offered only when all selected hits share one mailbox, Apply label only when all are in the open (primary) mailbox (`MailSelectionBar` `moveDisabledReason` / `labelsDisabledReason`). Swipe stays off in search results.
- **Vitest quirk:** a second concurrent dynamic `import()` of a `vi.mock`ed module can return the real module; `searchTier3Windows` and `decryptEncryptedRows` share one import per pass.
- Not verified against a real server or browser: `/mail/search` for an `in:` folder of another mailbox and a 403 for an inaccessible one (assumed error or empty), the OPFS/WASM Tier 2 behaviour with several mailboxes, and latency with many mailboxes.

### 2026-09-25 - event guests use compose's recipient field

JP: typing a mailbox name in an event's Guests field gave "isn't a valid email address"; wanted compose's lookup and chips.

- The guests field reuses compose's `RecipientInput` (`mail/compose/RecipientInput.tsx`) through `calendar/GuestInput.tsx`. `RecipientInput` gained optional props (`onEdit`, `initialPending`, `hideChip`, `placeholder`, `ariaLabel`, `listLabel`, `className`, `dropdownZIndex`); compose passes none and is unchanged. The suggestion `zIndex` must be above the event shell's `z-[1000]` (`GuestInput` uses 1100) - the dropdown is portalled to `document.body` and fixed-positioned so the popover's overflow cannot clip it.
- Attendees stay the source of truth. The field's value is `[...guests.map(guestChip), ...invalid, draft]`; `applyGuestChips()` (`eventFormat.ts`) maps chips back to attendees, keeping existing guests as they are, skipping duplicates and the organizer and returning non-addresses as `invalid`. `EventFormValues.guestInvalid` holds committed non-addresses and Save is blocked on them with the old "isn't a valid email address" message. `mergeGuests(current, text, skipAddresses?)` splits on commas and semicolons and understands `Name <addr>`.
- Whitespace no longer separates guests ("support desk" is one token; a token of several bare addresses is still split). Blur commits the draft. The organizer's address is skipped when typed (a new event could add yourself before). There is no client-side guest cap (the server's 50 per change request stands).
- A distribution list is one guest with the list address: compose does not expand lists and there is no non-admin members endpoint.
- Tests that assert "no fetch happened" after typing guests must filter to the save call, since lookups may fire. `ResourcePicker`'s `PopoverPortal` is `z-50`, below the shell's `z-[1000]`, so it may already be hidden behind the dialog - not checked.

### 2026-09-25 - sent replies show in the open conversation

JP: a reply sent from an open thread did not appear in it. Root cause: `messages/send` (background) moves the draft into Outbox, which has no `conversationId`; the id is only set when the server relays the message and files it in Sent Items (the uid stays the same), and the thread pane read the thread once, at open, and never listened. The server's thread query is not limited to the current folder.

- `apps/shared/mail/outbox/outgoingReplies.ts` is a view of the background send, not a second state machine: `startSend` opens an entry, and `notifyFailure`, `handleSendEvent` (`send-succeeded` / `send-failed`) and the retry/open-draft paths update it (`sending`, `failed`, `sent`). `ConversationThreadPane` draws a `PendingMessageCard` at the top (the pane lists newest first) for entries in the same mailbox whose `inReplyTo` or `references` match a `messageId` in the loaded thread (the compose session's `threading`, added to `SendRequest`, or the draft's own headers). New messages and scheduled sends are not tracked. The card carries the same actions as the sticky failure pop-up (Retry, Open draft, Unlock, the plaintext override).
- **Dedupe key** is the draft uid (the Outbox and Sent Items copy share it). A card is hidden whenever a real message with that uid is in the thread; the store entry is forgotten only after the real message has been drawn (`flushSync`), so there is no frame with neither. **Completion:** `send-succeeded` or a synchronous send flips the entry to `sent` and the pane reads the thread at once; the live update the same event triggers reads it again ~400 ms later. A sent entry the thread never contains is dropped after 2 reads (`MAX_SETTLE_MISSES`), which is also what happens to a forward the server threads elsewhere.
- The pane also refetches quietly on `useMailShell().live` updates that touch one of the mailbox's folders or name none: a failed read changes nothing, an unchanged read does not re-render, a newer local copy (by version) wins, messages archived or moved away in the pane stay removed (a conversation spans folders, so a re-read would resurrect them) and the reader's expand/collapse choices are kept. Messages that arrive from elsewhere appear collapsed at the top and are not auto-marked read.
- Not covered: the mobile message page without `?conversation=` (one message only). Unverified against a real server: how fast the Sent copy appears after `send-succeeded`, and that its `conversationId` matches the open thread. The real card's body iframe loads from the server, so there is a brief skeleton where the pending card showed the composed body.

### 2026-09-25 - release bump levels follow upstream

When releasing packages that depend on each other (rapidmx: restapi / react-shared -> web-client -> meet-plugin, booking-plugin, autodiscover, mapi, activesync, server; rapidrest: core / service-core -> auth / auth-server / react / cli and the projects built on them), the bump level of a downstream release matches the level of the upstream release it picks up: an upstream **minor** is a downstream **minor**, an upstream patch a downstream patch, major to major. Where a downstream bump crosses several upstream releases, use the highest level among them, and never choose "patch" just because the downstream's own diff is only a `package.json` bump. Betas keep their prerelease line but follow the same idea - say which level was chosen.

Why: meet-plugin 0.4.2 and booking-plugin 0.5.2 were cut as patches after web-client 0.15.x -> 0.16.0 and react-shared 0.17.0 -> 0.18.0 (both minors), and autodiscover 1.1.1 after restapi 0.20.1 -> 0.21.0; the downstream versions then hid additive behaviour. JP accepted those releases as they were (2026-09-25) and asked for the rule going forward. Releases only happen when JP asks for them.

### 2026-09-25 - message card: Report junk and More actions menu; permanent delete

- Report junk, Delete, Block and the other menu rows live in `reading/useMessageActions.ts` and `reading/MessageMoreMenu.tsx`. All of them act in the message's own mailbox (`resolveFolderOfType(message.mailboxUid, ...)`), never the open one. **Bug caught:** an optional call with no callee never evaluates its argument - `onMoved?.(await move())` moves nothing when there is no `onMoved`, so the move is awaited on its own line.
- **Block / Never block are filter rules** (the server had no blocked-senders list): `fromContains` is a substring match on the From header, and `Message.from` is the envelope sender, so the rule names both addresses (the header one comes from `/raw`). Rules never run on mail the spam filter judged junk, so Never block cannot override that. Rules are found by what they do, not by name. Phishing reports and spam training did not exist server-side: "Report phishing" only files the message and says so. `MenuButton` gained `iconOnly`, row `icon` and `title`, and a submenu with no enabled row focuses its Back row. "Create rule" reads `window.location.search` once in a lazy initial state (`useLocationSearch()` is empty until an effect runs).
- **Permanent delete.** Delete on a message in a `deleted_items` folder is a hard delete (`DELETE /mail/messages/:uid?purge=true`), for whoever holds `delete` on the folder. Empty folder uses `DELETE /mail/messages?folderUid=` (needs `truncate`; all or nothing on a legal hold); on 403 or 409 the client lists the folder (500 per page, capped at 20,000) and purges one by one, reporting each refusal. Every permanent delete goes through `usePermanentDelete()` in `apps/shared/mail` (one confirmation, one purge path, one notification, one badge update; `permanentDelete.ts` holds the logic): the list, the selection bar, the shortcuts and the card's menu share it. A selection with any message outside Deleted Items keeps the normal Delete, which moves only the messages not already there. The folder-level bar (`EmptyFolderBar`) is only on a mailbox's own Deleted Items and Junk Email, not in the aggregate view or over search results.
- **Known server gaps at the time (restapi):** route purge and truncate left attachment rows and blobs orphaned (`RetentionEnforcementJob.purgeMessage` does it right) and truncate wrote no audit entry; the legal-hold 409 text lists matter uids to ordinary users. On the mobile message page `onMoved` is `setMessage`, so the page keeps showing a deleted (or archived) message until the reader goes back.

### 2026-09-25 - message card uses the server's report route and sender lists

- `useMessageActions` calls `reportMessage` (no client move) and falls back to `moveMessage` on a 404; Block and Never block use the per-mailbox lists and fall back to the `senderBlocking.ts` filter rules on a 404. Filter rules made by the old code are left alone: they are not converted, and the new Block does not detect them.
- **Blocking is not reporting:** Block moves the message with a plain move, so it does not teach the spam filter; Report junk does. The `MailSelectionBar` bulk Report junk is still a client-side move with no learning.
- **FULL access is not knowable:** `access/me`'s `canManage` is UPDATE, so "always trust" is shown to anyone who may update the mailbox and hidden for view-only readers and the reader's own address; a delegate without FULL gets the server's 403 text. A restapi `canFull` flag would let the UI hide it exactly. List entries use the From header address (read through `/raw`), falling back to the address the message is filed under; the reader's own addresses (aliases of all their mailboxes included) are never blocked.
- The settings page is `/settings/blocked-senders` (id `blocked-senders` in `SETTINGS_SECTIONS`); the Block and Never block notification actions link to it. There is no UI for `fromEquals` / `fromDomainEquals` in the filter rule builder (an older server would ignore them and the rule would match every message). `sed -i` on a CRLF file strips the CRs - use the Edit tool or a script that preserves them.
