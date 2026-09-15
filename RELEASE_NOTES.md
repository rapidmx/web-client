# Release Notes

## Unreleased

Needs `@rapidmx/react-shared` with `mail/directoryApi.js`, `mail/messageBodySanitizer.js` and `composeQuoting.js`'s
`buildComposeBodyHtml()`/`buildReplyRecipients()`, and `@rapidmx/restapi` with `BaseDirectoryRoute` (all unreleased).

### Features

- **Recipient autocomplete in Compose:** the To, Cc and Bcc fields suggest your contacts and the server's directory
  (people, shared mailboxes, rooms, equipment and groups) as you type two or more characters of a name or address.
  Contacts come first, each address is listed once, and each entry shows its name, address and what it is. Use the
  arrow keys and Enter or Tab, or click, to pick one; Escape closes the list. Contacts of the mailbox you're sending
  from are included when you can read them.
- **Recipients as chips:** each recipient in To, Cc and Bcc shows as a removable chip, with its name when it has one.
  Typing a comma or semicolon, pressing Enter or leaving the field turns what you typed into a chip, pasted lists are
  split the same way, and Backspace in an empty field removes the last chip. Addresses that don't look valid are shown
  in red. `Name <address>` recipients (including quoted names containing commas) are now sent with their display name,
  and semicolons separate recipients as well as commas.

### Fixes

- **Replying and forwarding:**
  - Reply, Reply All and Forward now open with the caret on an empty line at the very top of the message, above your
    signature and the quoted original, so what you type goes above the quote - as in Outlook and Gmail. A new message
    still starts in To (or in Subject when the recipient is already filled in, for example from Contacts), and the body
    is never focused for it.
  - The quote now carries the original message in full, as you saw it - its formatting, lists and links - instead of
    the short preview the server derives at delivery (which cut a long message off mid-sentence). Quoted HTML is
    sanitized the same way a displayed body is: no scripts, no remote images or stylesheets, nothing that could load a
    tracker, and no images that only existed inside the original message. Messages with no HTML body are quoted from
    their full plain text, and the preview is used only when nothing else can be loaded.
  - Replying to or forwarding an encrypted message quotes the decrypted content you were reading, so the new message
    starts with Encrypt turned on: it is never saved as a plaintext draft, and can only go out unencrypted if you
    explicitly choose to. An encrypted message this device can't open quotes nothing at all, never its ciphertext.
  - **Reply All no longer addresses the reply to yourself.** Your mailbox's own address and its aliases are left out of
    both To and Cc, so you no longer receive a copy of your own reply; no address is listed twice; Bcc recipients are
    never carried over; and recipients keep their display names. Reply All now puts the original To recipients in To
    (with the sender) and the original Cc in Cc. It also recovers who the message was really addressed to from its own
    headers, since a delivered message's stored recipients name only your own mailbox - so Reply All reaches everyone
    on the original again.
  - A sender whose name the server stored with its address attached (`"Bob Allen" <bob@example.com>`) is no longer
    shown, or addressed, as `"Bob Allen" <bob@example.com> <bob@example.com>`.
  - Replying to a message you sent yourself (from Sent Items) now writes back to its original recipients instead of to
    yourself.
  - The reply attribution line names the sender as `Name <address>`, and the quoted original is indented behind a
    grey bar while you write, instead of running on as if it were part of your own message.

- **Styles for `@rapidmx/react-shared` components:** `app.css` told Tailwind to scan
  `node_modules/@rapidmx/react-shared/src`, a path that doesn't exist relative to the stylesheet, and the published
  package ships only `dist`. So Tailwind generated none of the classes react-shared's components use: dialogs had no
  backdrop, position or width and couldn't be closed by clicking outside them, and buttons, alerts and form fields lost
  their styling. The stylesheet now scans react-shared's `dist` in two places: under this package's own `node_modules`,
  and beside this package in a consumer's `node_modules/@rapidmx`. The second is how the server installs both, plugin
  pages included.
- **Setup wizard and plugins:**
  - Each step shows "Step N of 6" above its title, and completed steps show a check. The plugins, branding and escrow
    steps no longer repeat the standalone page's title and introduction under the step heading. The server settings
    step shows its three policies as separate panels.
  - The installed plugins table merges the state and server columns into one Status column. Enable or Disable,
    Settings and any Upgrade are buttons, with Change version and Uninstall as links below them. On narrow screens,
    each plugin's details stack above its actions, so the actions no longer scroll out of view.
  - The plugin settings dialog keeps Save and Cancel visible at the bottom while a long list of settings scrolls. It
    places checkbox help beside the checkbox and uses the same input styling as the other admin forms.
  - `PluginsManager`, `BrandingForm`, `EncryptionPolicyForm`, `RetentionPolicyForm` and `MailboxPolicyForm` take an
    optional `embedded` prop for this. The standalone admin pages are unchanged.

## v0.6.0

This release lets server plugins add their own pages to the webmail and admin console navigation. It needs a server
that builds plugin UI and sends plugin navigation; older servers send none and nothing changes.

### Plugin pages

- **Navigation:** Settings, the admin console and the app rail list the pages of enabled plugins after their own
  entries, with a generic icon, and highlight a plugin's entry while its page is open.
  - An entry that reuses a built-in id, or whose link isn't a path on the same site, is skipped.
  - Switching mailbox on a plugin's settings page stays on that page.
- **Supported surface:** `README.md` lists the shells and `@rapidmx/react-shared` modules plugin pages can import:
  `AppShell`, `SettingsShell`, `AdminShell`, `BrandingChrome`, and the `pluginNav` types.
- **Type declarations:** the package now ships `.d.ts` files next to the compiled `dist/apps` modules, so TypeScript
  plugin pages get types for these imports.

### Fixes

- **Search worker in the compiled modules:** `dist/apps/shared/search/localIndexRpcClient.js` named its Worker by its
  `.ts` source file, which isn't in `dist`, so bundling the compiled modules with Vite (as plugin pages do) failed. It
  now names `localIndexWorker.js`, and `yarn build` fails if a compiled module references a missing relative file.

### Breaking changes

- **Booking links moved to a plugin:** the Settings → Booking Links pages (`apps/www/settings/booking-types`) and
  `AvailabilityEditor` are removed from this package, and `booking-types` is no longer a built-in `SETTINGS_SECTIONS`
  entry. They ship in `@rapidmx/booking-plugin`, whose `booking-types` settings section now appears through plugin
  navigation when the plugin is enabled. Resource mailbox booking settings in the admin console are unchanged.

## v0.5.0

This release adds recovery-code unlock, "trust this signer" and plugin search, updates and dependencies. It also
hardens compose, encryption, local search and the admin consoles after several rounds of review. It needs
`@rapidmx/react-shared` from the same release. "Trust this signer" also needs a server running the next
`@rapidmx/restapi` release.

### Recovery codes

- **Unlock with a code:** the unlock dialog and the key setup page offer "Use a recovery code instead".
- **After unlocking:**
  - an optional "Set a new encryption password" step replaces a forgotten password;
  - the used code is then removed;
  - you're told how many codes are left, with a link to regenerate them when two or fewer remain.
- **Last code:** a new password is required before the last code is removed. You can also keep the code for now.
- **Failures:** every failure explains what happened and never removes the code.

### Signed and encrypted mail

- **Trust this signer:** shown on validly signed mail from a sender with no pinned signing key. It confirms the
  certificate's email and fingerprint before pinning it, then the badge turns verified. A sender whose key changed
  isn't offered one-click trust.
- **Key changes:** needs a server running the next `@rapidmx/restapi` release.
  - Mail validly signed by a pinned sender with a different key shows "This sender's signing key changed". It compares
    the trusted and new fingerprints with their dates and offers Accept new key (after a confirmation) or, when the
    change was already recorded, Keep current key. Accepting re-checks the message.
  - A contact's recorded key changes show the same comparison and actions, and its replaced keys are listed as a
    history ("Renewed automatically" or "Replaced by you").
  - Revoked keys are labelled "superseded" after a routine replacement and "revoked" otherwise, in contacts and in
    Settings > Encryption.
  - An unpinned sender with a recorded key change links to the contact instead of offering Trust this signer.
- **Verified when first opened:** needs a server running the next `@rapidmx/restapi` release. A message whose
  signature verifies is sealed, so if the sender's key later changes, is removed or is revoked it shows "Verified when
  first opened" with the date instead of looking untrusted. The badge is muted, not green, and turns amber with a warning
  when the key was later reported compromised. The local search index seals encrypted mail as it builds, and messages
  re-seal after a key vault rekey the next time they verify.
- **Unverified signers:** a valid signature from a signer that isn't a pinned contact key shows "signer not verified",
  never a green badge.
- **Signature badges:**
  - they always show the real sender address;
  - they warn when a display name looks like a different address;
  - they note when Subject, To and Cc weren't covered by the signature.
- **Attachments:** only attachments inside the signed or encrypted content are listed under a badge, and they download
  as files rather than opening in the app.

### Compose

- **Plaintext safety:**
  - never sends plaintext when Encrypt or Sign can't be honoured;
  - blocks sends when the mailbox, the encryption policy or a recipient's keys couldn't be checked, unless you choose to
    send without encryption;
  - doesn't autosave a draft as plaintext before recipients and encryption are known.
- **Saving and closing:**
  - saves run in order;
  - Close waits for the save;
  - a draft that can't be saved keeps the window open;
  - sign-out and leaving the page save pending drafts.
- **Discard:** it no longer deletes a message another window already sent or scheduled, and it works right after
  attaching a file.
- **Other:** Bcc is blocked for encrypted mail, and so are inline images in signed or encrypted mail. Address-like
  display names are left out of signed and encrypted From headers.

### Encryption settings

- **Key rotation:**
  - re-seals every stored key and refuses if any won't open;
  - includes the escrow wrap in the same request;
  - is disabled while a signing enrollment is pending, which can be cancelled.
- **Stale keys:** every key-changing action first checks that the session key still opens the vault, so a rotation on
  another device can't lead to writing wraps of a dead key.
- **Unlock methods and escrow:**
  - the last password can't be removed;
  - recovery codes are regenerated without dropping below the working set;
  - setting up keys in two tabs at once is detected;
  - an escrow scope deleted by an admin no longer blocks rotation.

### Local search

- **Sign-out:** every local search index is deleted on sign-out in every tab, including indexes for mailboxes you can
  no longer access.
- **Builds:** one build at a time per mailbox, with corruption detection and rebuild, bounded fetches and size budgets.
  Messages no longer on the server are pruned.
- **Results:** encrypted search only uses the local index for mail a completed build covered.

### Plugins (admin console)

- **Find plugins** searches the configured namespaces, showing latest versions with Install and Upgrade.
- **Installed plugins** show update badges, enable, disable and uninstall, plus Requires and Required by.
- **Preview before changes:** installing, upgrading or enabling previews the other plugins it brings in. Conflicts are
  explained, and the confirmed plan is sent with the change.

### Mail, calendar and contacts

- **Outbox:** a message being sent shows "Sending…", and failed scheduled sends show their error with Move to Drafts.
- **Mailboxes:** compose, event, contact and to-do pickers only offer mailboxes you can write to.
- **Calendar:**
  - single occurrences can be edited without their series rule;
  - series edits apply as time-of-day changes;
  - all-day events are stored as dates, with correct end dates in every time zone;
  - switching repeat frequency no longer leaves a stale weekday.
- **Paging:** infinite scroll and paging are fixed after archiving, and contacts and tasks page past 500 with a notice
  at the cap.
- **Deleted contacts:** the view is hidden from people without the rights to see it.

### Admin and escrow consoles

- **Sign-out** calls the auth server's logout and signs out other tabs.
- **Confirmations:** escrow scope changes, erasure, retention reductions, matter close and approvals now ask first.
- **Mail rules:** mail filters and transport rules need at least one condition.
- **Distribution lists:** members-only lists warn that they need the mail server's `trusted_authserv_id`.
- **Display names:** mailbox display names can't contain `@`, a look-alike or line breaks.
- **Branding:** HTML is sanitized, and the escrow console shows no branding HTML.
- **Plugin status** polling backs off and doesn't overlap.
