# Release Notes

## Unreleased

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
