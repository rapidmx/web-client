# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-09-13

### Changed
- Updated react-shared dep to v0.3.0

## [0.3.0] - 2026-09-13

### Added
- Added KeyEnrollmentGate, gating a mailbox's normal content behind one-time E2E encryption key setup per specs/end-to-end_encryption.md's "Generate signing and encryption keypairs on the client's device on first sign-in"
- Added test/apps/_components/KeyEnrollmentGate.test.tsx covering every status transition, both unmount-before-settle races, and both enrollment-error message paths
- Added key-vault unlock step to KeyEnrollmentGate
- Added Phase 4: compose-time discovery indicator and Contact key display
- Added Phase 5 (partial): Settings > Encryption page
- Added real key rotation to Settings > Encryption
- Added global idle-timeout key destruction
- Added mailing-list signature suppression on reply
- Added HP-Outer header-tamper warning banner
- Added operator-grammar search parsing and snippet rendering to inbox search
- Added Archive folder support: sidebar entry, Archive action, restapi patch refresh
- Added Labels settings page (create/edit/delete)
- Added message label-assignment UI to MessageDetailPane
- Added a Digital signatures section to Settings > Encryption for RFC 8823 ACME signing-certificate enrollment
- Added tests covering enrollment start, polling to issued/failed, unmount-mid-poll, and error paths
- Added an Escrow section to Settings > Encryption, shown when the mailbox is assigned an escrow scope
- Added escrow protection: fetch the scope's public key, wrap MK against it, and submit via addMasterKeyWrap
- Added tests covering both states and the fetch/wrap/submit error paths
- Added admin EscrowScope CRUD pages under apps/admin, mirroring transport-rules's list/create/edit shape
- Added a shared EscrowScopeKeyAndHoldersFields sub-form and a reusable StringListField control
- Added a new top-level, holder-facing apps/escrow app: Matters list/create/detail, access-request workflow, audit log viewer
- Added a nav entry for EscrowScope to AdminShell
- Added tests for the re-wrap success path, the failure path, and the non-ApiRequestError fallback message
- Added a Delete mailbox action to the admin mailbox detail page, wired to the already-existing but never-used deleteMailbox() helper
- Added tests for the delete flow: success/redirect, Cancel, the modal's own close button, and both error paths
- Added an admin Retention Policy settings page for the two optional message/audit-log retention windows
- Added a retentionPolicy nav entry to AdminShell
- Added a Settings > Privacy & Data page with a self-service data-export section (format picker, request list, native browser download once ready)
- Added a privacy entry to SettingsShell's SETTINGS_SECTIONS
- Added an Import mail section to Settings > Privacy & Data: destination-folder picker, file upload, and a status list
- Added tests covering the upload flow, both format inferences, folder selection, and every error/empty-state path
- Added a Delete my account section to Settings > Privacy & Data: confirmation modal, request list, no-cancel disclosure
- Added the shared apps/admin/data-requests page: admin-mediated export/import creation, and erasure approve/deny review
- Added a dataRequests nav entry to AdminShell
- Added tests for every section: create/upload flows, approve/deny, modal close paths, and every error/empty-state path
- Added Export this matter and Search this matter's custodians sections to apps/escrow/matters/[uid].tsx
- Added tests forcing the stale response to resolve after the newer one on both the success and error paths, confirming the guard actually discards it rather than asserting the create/upload call fired
- Added a regression test asserting the actual request carries q=budget&from=alice%40example.com for a from:alice@example.com budget query, not the raw unparsed text

### Changed
- Wire KeyEnrollmentGate into MailShell, wrapping AppShell unconditionally at a stable tree position regardless of whether mailboxUid has resolved yet, so AppShell never remounts partway through - a conditional wrap (only once ready) tears down AppShell's own in-flight state (e.g. the impersonation banner mid-action) exactly at that transition, confirmed by direct reproduction and fixed by always wrapping
- Provision only the encryption key automatically; the signing key's public-CA enrolment (RFC 8823 ACME automation) has no server-side endpoint yet, so generating a signing keypair here would have nowhere to enroll it
- Generate 8 recovery codes at enrolment, wrapped independently under distinct sequential methodIds (not derived from the code itself), requiring explicit user confirmation before unlocking mail
- Fail open (render children unchanged) on a key-vault check error, since encryption setup is optional and gradual, not a hard prerequisite for reading mail
- Patch @rapidmx/react-shared to pick up its new crypto/ module ahead of a real npm publish, and add @peculiar/x509, hash-wasm, and reflect-metadata as direct dependencies (yarn patch alone does not pull in a patched package's new transitive dependencies)
- Mock @rapidmx/react-shared/crypto/keyvaultApi.js at the module level in MailShell.test.tsx rather than through the shared mockFetch() helper, working around a Vite/Vitest module-resolution quirk specific to this not-yet-published subpath
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Document the KeyEnrollmentGate addition, the AppShell remount bug it surfaced, and the yarn patch bridge in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Previously KeyEnrollmentGate only handled first-time key provisioning -
- once a mailbox had enrolled keys, it rendered children immediately with no
- way to actually unwrap them into usable CryptoKeys for this session. Adds
- an "unlock" status: when a mailbox has enrolled keys but react-shared's new
- keySession.ts reports nothing unlocked yet, prompt for the encryption
- password and call unlockWithPassword() before rendering children. A
- mailbox already unlocked earlier this session (getUnlockedKeys()) skips
- the prompt entirely, so navigating between pages never re-prompts.
- Also switches KeyEnrollmentGate.test.tsx's cleanup to vi.resetAllMocks()
- instead of vi.clearAllMocks() - the latter doesn't clear a mock's
- implementation, which let one test's getUnlockedKeys.mockReturnValue(...)
- leak into every later test in the file.
- Refreshes the yarn patch bridging @rapidmx/react-shared's unpublished
- crypto/ modules (keySession.ts, composeSecurity.ts, plus the
- findActivePublicKey move into keyvaultApi.ts) into this repo.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- ComposeWindow's new getMailbox()/getEncryptionPolicy() effect had no
- cancelled-guard, so a resolved/rejected fetch after unmount could still
- call the component's state setters - the same class of bug KeyEnrollmentGate
- already had to guard against. Only surfaced under the full suite (a stale
- promise from one test's unmounted ComposeWindow landing during a later
- test), never in isolation, which is what made it easy to miss initially.
- Also completes MailShell.test.tsx's crypto/keyvaultApi.js mock: its
- "clicking Compose" test mounts a real ComposeWindow, which now calls
- getEncryptionPolicy()/lookupKeys() unconditionally on mount - previously
- only getKeyVault()/enrollKey() were stubbed, so the real (undefined) export
- threw synchronously during React's passive-effect commit.
- Refreshes the yarn patch for react-shared's new crypto/messageSecurity.ts
- and adds the dompurify dependency it needs for client-side sanitization
- of a decrypted message body before rendering it.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire message-view decrypt/verify and close remaining coverage gaps
- MessageDetailPane.tsx now evaluates every message's security state via
- react-shared's new messageSecurity.ts (fetching raw MIME through server's
- new GET /mail/messages/:id/raw route), rendering a 5-state security
- indicator badge and, for a decrypted/verified body, a dompurify-sanitized
- srcDoc instead of the ordinary server-sanitized /content iframe src.
- Adds the missing unmount-guard test for ComposeWindow's mailbox/policy
- effect and a lookupKeys()-failure test, closing the last statement/function
- coverage gaps this session's changes had opened - full suite now back to
- 100% statements/functions/lines, 99.86% branches.
- Documents both in NOTES.md.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- ComposeWindow.tsx now runs lookupKeys() on blur of the To/Cc/Bcc fields
- (not on every keystroke, and independent of the lookup assembleForSend()
- already performs at send time), caching each recipient's encryption
- availability and showing a small pill below the fields once known.
- ContactDetailPane.tsx gained an Encryption section: each pinned key's
- fingerprint (grouped into 4-character blocks for easier phone
- verification), revocation status, and the contact's encryption preference,
- plus an informational key-conflict warning when Contact.keyConflict is
- set, with the previously pinned key kept visible and unchanged alongside
- the newly observed fingerprint.
- The spec's Key Conflict Handling accept/reject action itself is not
- implemented - restapi's BaseContactRoute hard-rejects any client attempt
- to set keys/encryptPreference/keyConflict directly, and there is no
- dedicated resolve-conflict route in the current release to call instead.
- Documented in NOTES.md as a real gap in restapi, not a client-side
- deferral.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Refactor KeyEnrollmentGate to use react-shared's new masterKeyWraps.ts
- Removes the inlined password/recovery-wrap construction now that
- react-shared exports buildPasswordWrap()/buildRecoveryWraps() directly -
- the upcoming Settings page's "add password"/"regenerate recovery codes"
- actions need the exact same logic, wrapping an already-unlocked MK rather
- than a freshly generated one.
- Refreshes the yarn patch for the new module.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- New apps/www/settings/encryption/index.tsx: enrolled-key status (from the
- already-loaded Mailbox.keys), unlock-method list with Remove (with the
- spec-required "not true revocation" caveat shown inline), add a new
- password unlock method, and recovery-code regeneration with the same
- one-time-display-plus-confirm flow KeyEnrollmentGate's own first-enrollment
- path uses. A "destroy keys on this device now" action clears this
- session's in-memory keys client-side only.
- SettingsShell doesn't already gate its children behind KeyEnrollmentGate
- the way MailShell does, so this page wraps its own content in it a second
- time - safe by that component's own design, since it short-circuits
- immediately once a mailbox is unlocked anywhere else this session too.
- Passkey-method registration, full key rotation (rekey), and idle-timeout
- configuration are deliberately not included - each would roughly double
- this page's scope on its own. Documented as follow-ups in NOTES.md, not
- silently dropped.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- "Rotate keys now" re-wraps this mailbox's existing private key(s) under a
- brand new master key (react-shared's new rewrapPrivateKeysUnderNewMasterKey()),
- wraps that new MK under a freshly entered password and a fresh set of
- recovery codes, and atomically replaces the vault via keyvaultApi.ts's
- rekey() - the actual revocation mechanism for a captured wrap. The
- enrolled keypair/certificate itself is unchanged (restapi's own rekey()
- route requires this); every other unlock method on file stops working
- the instant it succeeds, since rekey() replaces masterKeyWraps wholesale.
- Re-primes this session's own keySession.ts cache against the new MK via
- unlockWithPassword() right after rekey() succeeds, since the session's
- cached master key would otherwise go stale and silently corrupt any later
- action (a second "Add a password", another rotation).
- Reuses the existing "Save your new recovery codes" one-time-display
- screen, with a recoveryCodesReason flag swapping in copy that explains a
- rotation invalidates every other unlock method too, not just the codes.
- Refreshes the yarn patch for react-shared's new crypto/keyRotation.ts.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Mounts react-shared's new useIdleKeyTimeout() in AppShell.tsx - the one
- component every app (Mail/Calendar/Contacts/Tasks/Settings) renders
- through - so activity anywhere in the client resets the clock, per JP's
- own direction, not just in Mail/Settings where the unlocked keys are
- actually read. Listens at the document level (mousedown/keydown/scroll/
- touchstart); after the configured idle period with none of those,
- destroys every unlocked mailbox's in-memory keys.
- Settings > Encryption gained a "Session timeout" select (5/15/30/60
- minutes, or Never) reading/writing the new localStorage-backed preference
- directly - no API call needed, takes effect on the app's next mount
- (already the case for every navigation, since this framework has no
- client-side router).
- Refreshes the yarn patch for react-shared's new crypto/idleTimeout.ts and
- crypto/useIdleKeyTimeout.ts.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Refresh react-shared patch (listUnsubscribeHeader, HP-Outer detection)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Refresh react-shared patch (search query grammar, scoring, updated searchApi)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire Tier 3 encrypted-candidate search into the inbox search flow
- Merge and re-score Tier 1/Tier 3 results by normalized score
- Refresh react-shared patch (Tier 3 search, recovered message subject)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Refresh react-shared patch (labelsApi, Message.labelUids)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Generate a signing keypair/CSR, wrap the private key under MK, and start automated enrollment on demand
- Poll enrollment status every 15s without blocking the UI, refetching the mailbox once a certificate issues
- Update KeyEnrollmentGate's stale comment now that automated signing enrollment exists
- Refresh the react-shared patch to pick up startSignEnrollment/checkSignEnrollmentStatus
- Document Phase 4 of consuming restapi's 11 post-0.6.0 commits in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Show a plain disclosure once escrow protection is in place, matching the spec's transparency requirement
- Refresh the react-shared patch to pick up getEscrowInfo/buildEscrowWrap/Mailbox.escrowScopeId
- Document Phase 5b (mailbox-owner wrapping UI) of consuming restapi's 11 post-0.6.0 commits in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Gate apps/escrow on "signed in and API reachable" only, since there is no clean canary endpoint to distinguish a non-holder up front; every holder-gated action enforces and surfaces its own 403 server-side
- Refresh the react-shared patch to pick up the four new escrow/matter API wrappers
- Document Phase 5c of consuming restapi's 11 post-0.6.0 commits in NOTES.md, closing out the batch
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Re-establish escrow coverage after a successful rekey by building a fresh wrap under the new MK and submitting it via addMasterKeyWrap, since rekey() itself can never carry one through
- Report a re-wrap failure separately from a rotation failure, since the rotation itself already succeeded by that point
- Show the escrow error unconditionally rather than only in the "not yet protected" branch, since a stale wrap keeps hasEscrowWrap true even after a failed re-wrap
- Document this adversarial review pass and the fix in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Surface the delete confirmation via the same Modal pattern used throughout this codebase, showing restapi's own error message (e.g. an active legal hold 409) verbatim
- Document Phase 2 (Legal Hold enforcement) of consuming restapi's next batch in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Surface the endpoint's own validation messages verbatim rather than duplicating them client-side
- Refresh the react-shared patch to pick up retentionPolicyApi.ts
- Document Phase 3 (Retention Policy) of consuming restapi's next batch in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Refresh the react-shared patch to pick up dataExportApi.ts
- Document Phase 4 (GDPR data export) of consuming restapi's next batch in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Infer the mbox/pst format client-side from the picked file's own extension
- Refresh the react-shared patch to pick up mailboxImportApi.ts
- Document Phase 5 (mailbox import) of consuming restapi's next batch in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Surface a legal-hold 409 from approve() verbatim, naming the blocking Matter
- Refresh the react-shared patch to pick up erasureRequestApi.ts
- Document Phase 6 (GDPR erasure + shared admin page) of consuming restapi's next batch in NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Widen reload()'s Promise.all to include listMatterExportRequests(), filtered to this matter client-side the same way access requests already are
- Refresh the @rapidmx/react-shared yarn patch to pick up admin/matterExportApi.ts, admin/matterSearchApi.ts, and the exported buildSearchParams()
- Document Phase 7 (eDiscovery: Matter export + Matter-scoped search) of consuming restapi's next batch in NOTES.md, closing out the full compliance-roadmap batch
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Guard each of the four loadRequests() functions with a per-call sequence ref so only the most-recently-issued call's response is ever applied to state, discarding a stale response that lands late
- Strengthen a weak test in matters/[uid].test.tsx that only asserted a mock flag rather than the export list actually reflecting the new request after reload()
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Parse the query via parseSearchQuery() and forward the structured fields the same way the inbox search UI already does, before calling searchMatter()
- Refresh the react-shared patch to also pick up a related Tier 3 free-text quotes/negation/OR parity fix
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Refresh the react-shared patch to pick up the searchTier3.ts scoring doc comment and pinning test from this session's adversarial review pass, no behavior change on this side
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Update release notes

### Fixed
- Fixed unmount-guard gap and incomplete test mock from crypto-aware ComposeWindow
- Fixed a false-positive test that passed only because the shell's own probe error UI masked the page's real fetch-error branch
- Fixed a real bug found by adversarial review: key rotation silently broke escrow protection while the Escrow section kept claiming it was active
- Fixed a real race condition found by adversarial review: ExportRequestsSection/ImportRequestsSection (apps/admin/data-requests) and ExportSection/ImportSection (apps/www/settings/privacy) could silently revert a just-created/uploaded request off the list if the initial mount fetch resolved after the faster create/upload-triggered reload
- Fixed Matter search sending the raw search-box text straight through with no operator-grammar parsing, so from:/subject:/etc. were treated as literal free-text words instead of structured filters

### Removed
- Removed a dead functional-updater guard on the initial folder selection - this effect only ever runs once per mount in this MPA

## [0.2.0] - 2026-09-11

### Added
- Added the webmail and admin console React UI extracted verbatim from rapidmx/server
- Added a package.json exports map so apps/book (staying in rapidmx/server) can still reach the handful of
- Added a Tailwind @source for react-shared's own source so its component classnames get scanned
- Added missing scaffold files

### Changed
- apps/www, apps/admin, and apps/shared/components (including apps/shared/styles/app.css, the Tailwind
- entry point and design tokens), moved as one unit rather than split - AppShell (the chrome every page
- wraps in) transitively pulls in most of the component tree including compose/tiptap, so a partial move
- wasn't realistic.
- primitives it needs - Alert, Button, BrandingChrome - as a package import instead of a relative path.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Copy apps/shared/styles/app.css into dist/apps on build, alongside the compiled JS
- tsc never copies non-TS assets into outDir, so AppShell.tsx's own `import "../../styles/app.css"`
- resolved fine when consumed from raw TSX source (rapidmx/server's own Vite build bundles this way) but
- broke when consumed via this package's compiled dist (electron-client's Vite build does, since it goes
- through the package's exports map) - dist/apps/shared/styles/app.css simply didn't exist. dist/ should
- be a self-consistent mirror of apps/ on its own merits, not something each consumer works around.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Update every import of react-shared modules to their new nested paths
- Update every import of the 8 moved components to @rapidmx/react-shared/components/*
- Update NOTES.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Update NOTES.md with the root cause: server builds one Rollup entry per page, so Tailwind's automatic per-chunk content detection only ever covered whichever one chunk app.css got attached to
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Updated react-shared dependency

### Fixed
- Fixed an incomplete Tailwind build in server by adding an explicit @source for this package's own apps/** tree

### Removed
- Removed Button, Alert, Skeleton, FormField, PopoverPortal, ContactAvatar, MiniDatePicker, and BottomTabBar, now provided by @rapidmx/react-shared

[Unreleased]: https://github.com/rapidmx/web-client/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/rapidmx/web-client/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rapidmx/web-client/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rapidmx/web-client/releases/tag/v0.2.0
