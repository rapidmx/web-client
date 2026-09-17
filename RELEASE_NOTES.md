# Release Notes

## v0.7.0

Needs `@rapidmx/react-shared` with `mail/directoryApi.js`, `mail/messageBodySanitizer.js`, `composeQuoting.js`'s
`buildComposeBodyHtml()`/`buildReplyRecipients()`/`buildReplyThreading()`, `listMessages()`'s
`sortBy`/`sortOrder`/`filter`/`labelUids`, `createDraft()`'s `threading`, the bulk message helpers and
`mail/conversationsApi.js`'s `folderUid`/`filter`/`labelUids` and `listConversationMessages()`; and
`@rapidmx/restapi` with `BaseDirectoryRoute`, the sorted/filtered/label-filtered/bulk/conversation message routes and
a send that writes a reply's `In-Reply-To`/`References` (all unreleased).

### Features

- **Mail opens on Focused, shown as conversations.** A mailbox you have never arranged now opens on the Focused half
  of the Inbox with "Show as conversations" on, the way Outlook does out of the box. A mailbox you *have* arranged is
  untouched: a stored flat list, or a stored All, stays exactly as you left it, and either default can be turned off
  from the Sort and Filter menus (or the tab row) as before.
- **Select works over conversations.** The Select toggle used to be greyed out whenever conversations were shown -
  which, with conversations now on by default, meant always. It now ticks whole conversations: the header counts
  "3 conversations selected", and Mark read, Flag, Archive, Move to, Apply label, Report junk and Delete act on every
  message of the ticked conversations that is in the folder you are looking at (never on the Sent Items copy of a
  reply, which that list never showed you). The list reloads afterwards, since a conversation row is a summary of its
  messages. Select is still unavailable in the merged All Mailboxes views, and is greyed out - saying why - while a
  folder is still loading or has nothing in it.
- **The reading pane's actions are icons.** Reply, Reply All, Forward, Archive and Move to Other/Focused are now icon
  buttons in one row, at every window size - each keeps its name as its tooltip and its accessible name, and nothing is
  written beside the glyph. The row reads the same in the ~400px-wide reading pane beside the message list as in a
  maximised window, without wrapping or scrolling sideways, and every message in a thread keeps its own.
- **Select is an icon too.** The Select toggle is an outlined square, the way Outlook draws "select items", with
  "Select" as its tooltip and its accessible name. While select mode is on the square sits on a tinted background, so
  it still reads as pressed next to a greyed-out one.
- **"Move to Other" asks first.** The loose "Always for this sender" checkbox that sat permanently beside the button is
  gone. Moving a message between Focused and Other now opens a small confirmation with "Always move mail from this
  sender to Other" (or Focused) in it, so the rule that outlives the message is a deliberate choice made at the moment
  you move it. It does exactly what the old checkbox did.
- **A mail list toolbar, as in Outlook.** The two rows of tabs above the message list ("By date / By conversation" and
  "All / Focused / Other") are replaced by a toolbar with **Filter**, **Sort** and **Select**. The Focused/Other tabs
  stay where they were, and now filter server-side.
  - **Sort** offers Date, Date sent, From, Subject, Importance and Flag status, each with the order that reads
    naturally for it ("Newest on top"/"Oldest on top", "A to Z"/"Z to A", "Highest on top", "Flagged on top"). Changing
    the key resets the direction to that key's own.
  - **Filter** offers All, Unread, Read, Flagged and Has attachments, plus Focused and Other in an Inbox. Only one
    filter applies at a time, so picking Focused or Other replaces the filter above it, and the menu always shows which
    one is in force.
  - Both sort and filter are applied by the server across the **whole folder**, not just the page that happens to be
    loaded, so scrolling further keeps them correct. Sorting isn't offered for search results (ranked by relevance) or
    for the merged All Mailboxes views (one page from each mailbox, always by date); filtering still is, per mailbox.
  - **Filter > Labels** narrows the list to the labels you pick - several at once, with the menu staying open while you
    tick them and one "Apply labels" applying them together. A message is listed if it has *any* of the ticked labels,
    the Filter button names what you picked, and "Clear labels" drops the label filter in one step.
  - Your sort, filter, labels and conversation choice are remembered per mailbox on this device, so reopening Mail
    lands where you left it.
- **Select several messages and act on them at once.** "Select" turns the list into a multi-select: a checkbox on each
  row, a header counting what is ticked, Select all and Clear, and bulk Mark read, Mark unread, Flag, Unflag, Archive,
  Move to, Report junk and Delete. Delete means *move to Deleted Items* - nothing is erased, and Deleted Items, Junk
  and Archive are created for you the first time you need one. An action whose folder is the one you are already in is
  greyed out and says why. If the server rejects part of a bulk change, the list reloads and says that some messages
  may already have changed, rather than showing a list that no longer matches the server.
- **Apply labels to several messages at once, and from the open message.** Select mode has an **Apply label** action,
  and the reading pane's own **Labels** button now works the same way: tick as many labels as you like with the menu
  staying open, then Apply once. Unticking a label removes it. Across a mixed selection a label only some messages
  carry shows as a dash, and leaving that row alone keeps each message exactly as it is - ticking it applies the label
  to all of them, and clearing it removes it from all of them. The reading pane's Labels button replaces a dialog that
  saved a request per tick. Every label menu - Filter, Apply label and the reading pane's - can also create a new label
  on the spot ("New label"), and links to Settings > Labels for renaming, recolouring and deleting.
- **Conversations are now nested rows in the list.** "Show as conversations" (in the Sort menu, as in Outlook) groups
  the list into one row per conversation - participants, subject, message count, unread count, attachment and flag
  hints and the latest message's preview - with a chevron that expands it into that conversation's own messages as
  child rows. Unlike the old "By conversation" view, conversations now follow the folder selected in the sidebar and
  honour the current filter, and can be scrolled past the first page.
- **Opening a conversation opens the whole thread.** The reading pane shows every message in the conversation, newest
  at the top, positioned at the one you opened: a conversation row opens it at the newest message, a child row opens it
  at that message (picking 5 of 10 scrolls to 5 of 10). Everything from the message you opened through to the newest is
  expanded - in this order, that message and the entries above it; the older ones below are a one-line summary - sender,
  date and preview - that expands when you click it or press
  Enter, and expanding one above what you are reading leaves what you are reading where it was on screen. Each message
  keeps its own security badges, labels, attachments and Reply/Reply All/Forward/Archive, acting on that message, and
  anything you do there is reflected in the list. Messages are read in pages of 100, up to 500 for one conversation -
  the server groups no more than that into a conversation anyway - and the pane says so if it ever stops there.
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

- **A reply composed here joins the thread it answers.** Replies, Reply Alls and forwards sent from this app went out
  with no `In-Reply-To` or `References` header at all, so every mail system - including your own Sent Items - filed
  each one as a brand-new conversation: the list showed a separate row per message of a thread, each saying "1
  message", and older replies never appeared when you opened one. A reply now records the message it answers on its
  draft, the server writes the headers into what it relays, and the reply is listed inside the conversation it belongs
  to. (Needs the matching `@rapidmx/restapi` and `@rapidmx/react-shared`.)
- **Mail asks the server for less on every view.** Opening a folder fetched the mailbox's labels twice and listed the
  folder twice - the second listing replacing the first the moment the shell knew which folder to list. Both are down
  to one request, and a merged "All Mailboxes" view no longer lists everything twice while each mailbox's folders
  arrive.
- **The message body uses the whole reading pane, at any window size.** An expanded message in a thread rendered its
  body in a 150px-tall box with its own scrollbar - an `<iframe>`'s default height - leaving the rest of the pane empty
  below it. The reading pane is now the height of the window, in a thread and out of one, and the body fills whatever
  the message's own header leaves: it reaches the bottom of the pane in a tall window and in a short one, and follows a
  resize, because the height is resolved from the window down rather than fixed to a proportion of it. A message longer
  than the pane still scrolls inside its own frame: the frame runs no scripts (it renders mail from strangers), and
  without a script inside it there is nothing that can measure the message and size the frame to it.
- **A conversation always reads newest first.** The thread in the reading pane used to be listed oldest at the top. It
  now opens with the newest message at the top whatever the message list is sorted by - the list's order arranges rows
  to pick from, while the pane is one conversation being read, and the message a conversation row stands for should be
  the first thing in it every time. The expand/collapse rule is unchanged in meaning: the message you opened and
  everything newer than it (the entries above) are expanded, everything older (below) is collapsed - so opening a
  conversation row expands just the top entry, and opening its oldest message expands the whole thread. The quoted
  history inside each message is untouched.
- **"Move to" moves a message to a folder.** The reading pane's Focused/Other control is gone, and in its place is a
  Move to action that asks which folder to move the message into - every folder of its mailbox, with the one it is
  already in shown but not selectable, a filter box once there are more folders than fit a glance, and "New folder…"
  to create one and move into it in a single step. A new folder is created at the top level of the mailbox and appears
  in the folder list straight away, with no reload. The same prompt now backs select mode's bulk Move to, so both offer
  the same destinations and the same way to create one; a refused move or a refused creation is reported inside the
  prompt, beside the button that would try again.
- **Focused and Other are entirely automatic.** The "Move to Other"/"Move to Focused" button, its "Always move mail
  from this sender" confirmation and the Settings > Focused Inbox page of per-sender rules are all removed. Which half
  of the Inbox a message lands in is decided on delivery, from who you correspond with, whether the sender is internal
  and the spam score - nothing to configure and nothing to keep in step. The Focused and Other tabs stay exactly where
  they were and now simply show what that automatic classification decided.
- **Conversations follow the sort you picked.** The conversation list ignored the Sort menu entirely and always read in
  the order the server happened to page them in. Date, From, Subject and Flag status now order the conversation rows,
  both ways round, and a conversation's own messages read newest-first while the list does. Date sent and Importance are
  greyed out while conversations are shown and say why - they belong to a message, not to a thread - and the menu says
  that conversations are ordered within the rows loaded so far, since the conversations endpoint has no sort of its own.
  Changing the order no longer re-fetches the same rows or collapses the conversations you had expanded.
- **A conversation stops claiming unread mail you have just read.** Opening an unread message inside a conversation
  left the row's "2 unread" chip - and its bold styling - exactly as they were until the whole folder was reloaded,
  because that count belongs to the conversation summary rather than to any message the reading pane had patched. The
  row's count now goes down as its messages are read.
- **The "All" tab is gone.** The tab row above the message list is Focused and Other, as in Outlook. The whole Inbox is
  still one pick away, under Filter > All, which is where every other named filter already lived and the only place
  that can show which one is really in force - so a mailbox that remembered "All" still lists everything, with neither
  tab shown as pressed.
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
