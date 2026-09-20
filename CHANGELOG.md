# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-09-20

### Added
- Added copy buttons to every name and value of the domain DNS checklist, and show each record's type and name

### Changed
- Redirect an administrator whose token is not elevated to the auth-server's /auth/elevate page and back, instead of showing no administrator access, with a two minute guard against a redirect loop
- Show the reason the server gave when a mailbox can't be set up, and offer Retry when the identity service can't be reached
- Show the profile name in the account menu, else the username, else the uid, and add an Account link to the auth-server's account page
- Update the inbox, conversation lists, all mailboxes views and unread counts as mail arrives, over the push connection with a poll as a fallback, without a reload or losing the selection
- Show the sender's address next to their name in lists, the reading pane, recipient lines and a forward's quote
- Keep the compose window open after a failed send with an expandable technical details block, and ask before closing it
- Test the new components and hooks and the changed ones
- Document the changes in the README, the release notes and NOTES, including that this needs the next @rapidmx/react-shared and @rapidmx/restapi
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgraded react-shared dep

### Removed
- Removed the custom header from the admin console and keep its footer

## [0.8.0] - 2026-09-20

### Added
- Added a Reset to server default button under each mailbox policy field whose value differs from the server's config value, on the Mailbox Policy page and in the setup wizard, so an administrator can take a newly deployed default without typing it in

### Changed
- Fill the field in and leave saving to the form's own Save, so dirty tracking, the unsaved-changes prompt and the send-only-what-changed patch keep working, and offer no button when the server reports no defaults or the field is already at the config value
- Test the reset of each of the three fields, that nothing is sent before Save, and that no button shows at the config value or without defaults
- Document the change in the release notes and NOTES, including that it needs @rapidmx/react-shared with MailboxPolicy.defaults and type-checks only once that is published and the dependency is bumped
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgraded react-shared dep

## [0.7.0] - 2026-09-17

### Added
- Added an embedded mode to PluginsManager, BrandingForm and the encryption, retention and mailbox policy forms, so the setup wizard no longer repeats their page titles and introductions under its step heading
- Added RecipientInput for Compose's To, Cc and Bcc fields, showing recipients as removable chips and suggesting contacts and server directory entries while typing through react-shared's fetchRecipientSuggestions
- Added an accessible combobox to the recipient fields with arrow key, Enter, Tab, Escape and mouse selection, a 150 ms debounce, aborted stale requests, contacts listed first, one entry per address and a kind hint on each entry
- Added recipients.ts to split recipient lists at commas and semicolons outside quoted names and angle brackets, parse and format Name <address> recipients and flag invalid addresses
- Added MenuButton, an accessible ARIA menu over react-shared's PopoverPortal, with a checkmark on the current choice, roving focus, Enter/Space or Arrow Down to open, arrows and Home/End to move, Escape or Tab to close with focus returning to the trigger, and a click outside to dismiss
- Added MailSelectionBar and a Select toggle that turns the list into a multi-select: a checkbox per row, the number selected, Select all, Clear and Cancel, and bulk Mark read, Mark unread, Flag, Unflag, Archive, Move to, Report junk and Delete
- Added labelMenu.tsx, the one multi-select label list behind the Filter menu's Labels submenu, select mode's Apply label and the reading pane's Labels button, so all three tick several labels with the menu staying open and commit them with a single command
- Added keepOpen, a mixed checked state and one level of submenu to MenuButton, with a synthesized Back row, Arrow Right to open a submenu and Arrow Left or Escape to leave it for its parent menu as ARIA specifies
- Added inThread to MessageDetailPane, which drops its subject from an h1 to an h3 because a document has one h1 and inside a thread that is the conversation's own subject

### Changed
- Scan @rapidmx/react-shared's published dist for Tailwind classes, both under this package's node_modules and hoisted beside it in a consumer's node_modules/@rapidmx, instead of a src path that never existed, so Modal, Button, Alert and FormField are styled and dialogs get their backdrop again
- Head each setup step with a "Step N of 6" eyebrow over its title, mark completed step pills with a check, and show the server settings and branding forms in panels
- Merge the installed plugins' State and Servers columns into one Status column, show Enable/Disable, Settings and Upgrade as buttons with Change version and Uninstall below, and stack each plugin row on narrow screens
- Keep the plugin settings dialog's Save and Cancel in view while its settings scroll, lay checkbox help beside the checkbox, and match the admin forms' input styling
- Test the embedded plugins manager and wizard headings, and closing the plugin settings dialog with its close button, Escape and a backdrop click
- Document the fix and the browser screenshot workflow in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Send recipients typed or picked as Name <address> with their display name instead of as the address, and run key discovery as soon as a suggestion is picked
- Commit typed recipients as chips on a separator, Enter, paste or leaving the field, and remove the last chip with Backspace in an empty field
- Test the recipient input, the recipient parsing and the Compose integration, and read prefilled recipients from chips in the Compose, message and contacts tests
- Document recipient autocomplete in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Open a reply or forward with the caret on an empty line at the top of the body, above the signature and the quoted original, so what is typed goes above the quote, by seeding the body through react-shared's buildComposeBodyHtml and focusing the editor at the start of the document
- Focus a new message's To field, or its Subject when a recipient is already prefilled, and never the body
- Move the caret only once per compose session, so restoring a minimized window doesn't move it again
- Take the editor's own serialization of the seeded body as the autosave baseline, since TipTap appends a paragraph after a trailing quote and drops attributes its schema doesn't hold on its first transaction, which made an untouched reply count as edited and be autosaved as a plaintext draft
- Quote the message's full body, loaded by the new loadOriginalMessage: the decrypted or verified content the pane shows, else the server's sanitized HTML body, else the text part of the raw message, with the truncated preview only as a fallback
- Quote nothing for an encrypted message this device can't open, and never its ciphertext
- Start a reply to or forward of an encrypted message with encryption requested, so a decrypted quote is never saved as a plaintext draft and can't go out unencrypted without an explicit choice
- Leave the replying mailbox's own address and aliases out of Reply All's To and Cc, repeat no address, carry no Bcc recipient over and keep display names, so a reply no longer comes back to the sender
- Recover the original To and Cc for Reply All from a verified message's protected headers or the raw message's own headers, since a delivered message records only the envelope recipient
- Reply to the original recipients, rather than back to itself, for a message the mailbox sent
- Sanitize a quoted body with react-shared's messageBodySanitizer, which MessageDetailPane's own purifier moved into, and indent the quote in the compose editor
- Disable Reply, Reply All and Forward while the body to quote loads
- Test the caret and focus behaviour, the untouched reply, the quoted body sources, the encrypted reply and every reply recipient case
- Document the reply and forward changes in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Replace the mail list's "By date / By conversation" and "All / Focused / Other" tab rows with an Outlook-style toolbar - a Filter menu, a Sort menu and a Select toggle - keeping the Focused/Other tabs as a shortcut into the same filter
- Sort the whole folder server-side by date, date sent, from, subject, importance or flag status, each offering the order that reads naturally for it, and reset the direction when the key changes rather than carrying Date's newest-first over to Subject
- Filter the whole folder server-side by all, unread, read, flagged or has attachments, plus Focused and Other in an Inbox - one filter at a time, which is all listMessages() accepts, and the menu says so
- Ask the server for the Focused or Other half of the Inbox instead of filtering the loaded page in the browser, which was wrong for every page after the first
- Grey out the sort keys, but not the menu that carries "Show as conversations", while a search, an aggregate view or the conversation list is what decides the order
- Remember the sort, filter and conversation choice per mailbox in localStorage, read while rendering so the very first listing already uses them
- Delete by moving to Deleted Items, never through the collection DELETE that truncates a folder, and create Deleted Items, Junk or Archive on demand for a mailbox that has none yet, remembering what was created so a second delete doesn't create a second folder
- Reload the list, and say that some messages may already have changed, when a bulk update is rejected - it is applied element by element and stops at the first failure
- Replace the flat "By conversation" list with nested conversation rows showing participants, subject, message count, unread count, attachment and flag hints and the latest message's preview, expanding through their own chevron into the conversation's own messages, fetched once with listConversationMessages
- Open a conversation's latest message from its row and that message from a child row, and remove ConversationThreadPane, whose merged thread pane showed the same messages the list now lists
- Scope the conversation list to the selected folder and the current filter, and page it with the same sentinel the message list uses
- Clear localStorage between tests, since jsdom keeps one per file and a preference a test left behind silently became the next test's starting state
- Test the toolbar menus, their keyboard support and their persistence, the server-driven Focused/Other split, select mode and each bulk action including a rejected one, and conversation rendering, expansion and paging
- Document the mail list overhaul in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Filter the list by label from a Labels submenu of the Filter menu, ticking as many as wanted and applying them together as one request, with a message listed when it carries any of them, the Filter button naming what was picked and Clear labels dropping the filter in one step
- Remember the chosen labels per mailbox alongside the sort, filter and conversation preference, and leave an empty selection out of the query entirely rather than sending it empty
- Take the labelUids parameter and its MAX_MESSAGE_LABEL_FILTER cap from react-shared now that both have landed, so the stored selection is trimmed to the same number the server refuses a longer list with
- Apply labels to a whole selection from select mode, writing each message's own resulting list in one bulk update rather than one identical list for every message, so a label only some of them carry can be left exactly as it is
- Show a label only part of a selection carries as partially applied, with a dash and aria-checked="mixed", and say what Apply does to the rest: ticking applies to every selected message, unticking removes from all, and leaving the dash alone keeps each message as it is
- Preserve labels this mailbox no longer defines, which the menu couldn't show and the reader therefore never chose to remove
- Replace the reading pane's Labels dialog, which saved a request and burned an optimistic-lock version on every single tick, with the same menu saving once
- Create a label from any of the label menus through NewLabelDialog, which the New label row opens because a role="menu" has nowhere to put a text field, and link to Settings > Labels for renaming, recolouring and deleting
- Key MenuButton's roving-focus effect on the open submenu too, since drilling in or out can land on the same index in the other level's list, where that index means a different button
- Size a menu's fixed popup box from the level actually shown rather than always from the top level, so a submenu no longer stands in the taller box its parent menu needed
- Give a note as many lines as it wraps to at the width the menu is drawn at, instead of assuming two, which cut the last rows off a label menu whose note explains what a partially-applied label does
- Read the Filter menu's labels from the open mailbox rather than from the selected message's, which in search and aggregate views can be another mailbox whose labels must not be offered as a filter here
- Test the shared label menu, its draft and partially-applied semantics, label filtering end to end, the bulk apply over a mixed selection, a rejected bulk label update refetching, and creating a label from the menu
- Document the label work in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Open a conversation as the whole thread in the reading pane rather than the single message its row stands for, bringing back ConversationThreadPane - a parent row opens it at the newest message, a child row at that message, so picking 5 of 10 opens the thread at 5 of 10
- Expand every message from the one that was opened through to the newest and collapse everything older to a one-line summary of its sender, date and preview, which means opening the newest message shows exactly that message expanded and opening the oldest shows the whole thread
- Give each message's header a button carrying aria-expanded and aria-controls, so the run can be changed from the keyboard, and hand focus to the message the thread was opened at
- Render every expanded message as a MessageDetailPane of its own instead of reimplementing it, so the signature and verification badges, the verification-seal and decryption behaviour, the labels chips and menu, the attachments and Reply, Reply All, Forward and Archive are identical to the single-message pane and each acts on the message it belongs to
- Mount nothing for a collapsed message, whose body iframe, attachments request and mark-as-read would otherwise all be paid for up front in a long thread
- Scroll to the opened message's own element with scrollIntoView block nearest, which moves the least that brings it into view and nothing at all when it is already there, rather than computing an offset from row heights that aren't known until the messages above it have been laid out
- Put a message whose header was just clicked back where it was on screen afterwards, measured on whichever ancestor actually scrolls, so expanding a message above the one being read doesn't shove it off the screen
- Sit out the render that has a new conversation with the previous one's messages still in state, or the thread anchors on a message from another conversation and scrolls to a row that is about to unmount
- Key the expansion run on the conversation and the opened message in a ref, since the thread arrives after the click that selected one of its messages and a patched copy would otherwise re-expand what the reader had just collapsed
- Load a thread with listConversationMessages in pages of 100 up to 500 messages, which is also the number the server groups into a conversation at most, and say which messages are shown if it ever stops there
- Keep the message list in step with the thread: a newer copy from marking read, labelling, classifying or recalling patches the listed row and the conversation's child row, and archiving or sending a scheduled message back to Drafts removes it from both
- Wrap the reading pane's action row, which at the width the pane has beside the message list is six controls on one line
- Test opening at the newest message, opening at a child, the expanded-and-collapsed rule including the oldest message, the scroll and focus, per-message actions, the paging and its cap, and every response that lands after the reader has moved on
- Document the thread pane in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Open a mailbox nobody has arranged yet on Focused and shown as conversations, the way Outlook does out of the box, while honouring a stored arrangement exactly as it was - a stored flat list or a stored All is a choice someone made, and only a record that never carried the field falls back to the new default
- Enable Select over the conversation list, which was greyed out whenever conversations were shown and, with them now on by default, therefore always
- Tick whole conversations in select mode, resolving each ticked conversation to its own messages with listConversationMessages() as it is ticked and caching them per conversation, so the selection bar and every bulk action keep taking the Message[] they always took
- Act only on the messages of a ticked conversation that are in the folder being listed, never on the Sent Items copy of a reply that list never showed
- Reload the conversation list after a bulk action instead of patching a row, since a conversation row is a summary of its messages - its count, unread count, participants and preview all move when part of it changes
- Count what was ticked in the selection bar through MailSelectionBar's new totals ("3 conversations selected") while what the actions act on stays the messages, and hold those actions while a tick's own fetch is still in flight
- Untick a whole batch, saying why, when any of its conversations' messages can't be loaded, rather than acting on the part of a selection that happened to arrive
- Grey out Select, each with its own reason, only for an aggregate view, a folder still loading and a list with no rows to tick
- Fill the reading pane with the message body, which inside a thread sat in a 150px box with its own scrollbar - an iframe's own default height, since flex-1 there has no flex column to grow in
- Give a message in a thread a body two thirds of the window tall rather than sizing it to its content, which would need a script inside a frame that deliberately runs none because it renders mail from strangers
- Replace Reply, Reply All, Forward, Archive and Move to Other with icon buttons keeping each action's name as both its tooltip and its accessible name, showing the name beside the icon on a wide window and icons alone in the ~396px pane beside the message list
- Draw Reply All as the reply arrow doubled, the conventional glyph, since hi2 has no reply-all icon and nothing else in it means "answer everyone"
- Ask before moving a message between Focused and Other, carrying "Always move mail from this sender" in the prompt instead of as a loose checkbox parked beside the button, and report a failed move beside the button that would retry it
- Record the thread a reply, Reply All or forward continues on the draft it creates - buildReplyThreading() through OpenComposeInput, the compose session and createDraft() - so the message is relayed with In-Reply-To and References and is filed into the conversation it answers rather than one of its own, which is what made a thread show as one row per message, each reporting one message
- Ask for the open mailbox's labels once per view instead of twice, deriving the reading pane's list from the one the toolbar already fetched and only fetching separately for a selected message that belongs to another mailbox
- List a folder once per view instead of twice, by listing nothing until the shell has resolved which folder to list - in conversation mode the discarded first listing was a mailbox-wide grouping pass - and, in a merged view, until every mailbox's folders have arrived
- Test the new defaults and that a stored arrangement still wins, conversation select mode end to end including a conversation whose messages can't be loaded and a rejected bulk action, the Select toggle's own states, the selection bar's conversation counting, the move prompt, the body's height, the threading a reply and a forward record, and that one view makes one request of each kind
- Store the flat, unfiltered arrangement in index.test.tsx's beforeEach, since every test there was written against the list an unconfigured mailbox used to open on
- Document the round in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Draw the reading pane's Reply, Reply All, Forward, Archive and Move to Other as icons alone at every width, rather than showing each action's name beside its glyph on a wide window, keeping the name as both the tooltip and the accessible name
- Draw Select as an outlined rounded square with no word beside it, the way Outlook draws its own "select items" command, keeping "Select" as its tooltip and accessible name and giving the pressed state its own background so it reads next to a greyed-out one
- Fill the reading pane with the message body at any window size, in a thread and out of one, by resolving the height down the flex chain from the window instead of giving a message in a thread two thirds of the viewport
- Give an expanded message in a thread a row as tall as the scrolling list it sits in, which is what a body iframe that deliberately runs no script - it renders mail from strangers - can take a height from
- Take h-full off the pane inside a thread, since an explicit height opts a flex item out of the stretching that actually sizes it there and Chrome won't resolve that percentage against a parent whose own height came out of the flex algorithm - which left the body back at an iframe's own 150px default
- Keep h-full for the standalone message route, where the pane is rendered into a block that stretches nothing
- Order the conversation rows by the sort the reader picked - date, the latest sender, subject or flag status, both ways round - applied to the rows already fetched, since the conversations endpoint takes no sort parameters of its own and pages them by latest activity
- Grey out Date sent and Importance while conversations are shown, each saying that a thread has neither of its own, rather than reordering the rows by something a thread summary doesn't carry
- Read a conversation's own messages in the same order sense as the rows, newest first while the list is
- Stop re-listing the folder when only the order of the conversation rows changes, which fetched the identical page and collapsed whichever conversations the reader had expanded
- Take a conversation row's unread count down as its messages are read in the thread pane, which reports the unread copy it replaced so a summary can tell a message being read from an already-read message being relabelled
- Test the icon-only action row and Select toggle, the body's height in a thread and out of one, conversation ordering in both directions with its own messages, the two-tab row and a stored All filter, and the unread count clearing
- Document the round in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Read the conversation thread pane newest first always, independent of the list's own sort order
- Expand the opened message together with everything newer than it in that order, and scroll/focus to it correctly
- Replace the reading pane's Move to Other/Focused action and its per-sender override with a Move to folder picker shared with the bulk action
- Let the folder picker create a new folder and move into it in one step, refusing an empty, too-long, separator-containing, or duplicate name
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgraded react-shared dep

### Removed
- Removed the All tab, leaving Focused and Other, and leave a remembered All filter exactly as it is - it is still the Filter menu's own first item, so that mailbox still lists the whole Inbox with neither tab pressed
- Removed the Focused Inbox settings page and its per-sender rules, now that Focused/Other classification is purely automatic

## [0.6.0] - 2026-09-15

### Changed
- Let the app rail, settings and admin console shells take plugin navigation entries from a pluginNav prop, added after the core entries and skipped on id collisions, unsafe hrefs or malformed items
- Fall back to the current path in the settings mailbox switcher when the active section isn't listed
- Emit type declarations with the built pages so TypeScript plugin pages can import the shells
- Document the package layout and the supported plugin UI surface in a README
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Name the local search Worker by its compiled localIndexWorker.js file, so dist/apps/shared/search/localIndexRpcClient.js no longer references a .ts file missing from dist and Vite builds of the compiled modules resolve the worker
- Fail yarn build when a compiled module under dist imports, re-exports or new URL()s a relative file that doesn't exist there
- Document the fix in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Depend on the published @rapidmx/react-shared ^0.5.0 instead of a local patch of 0.4.0, and remove the old react-shared patches
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Upgraded react-shared dep

### Removed
- Removed the Booking Links settings pages, their settings section and AvailabilityEditor, which moved to @rapidmx/booking-plugin and return through plugin navigation

## [0.5.0] - 2026-09-15

### Added
- Added a Find plugins section to the Plugins page that searches the configured namespaces, showing each plugin's latest version and install state with Install and Upgrade buttons
- Added a recovery code unlock mode to the unlock dialog and key enrollment gate, with follow-up steps to optionally set a new encryption password, remove the used code and show how many codes remain
- Added Trust this signer for validly signed mail from senders with no pinned signing key, confirming the certificate email and fingerprint before pinning it and re-checking the message

### Changed
- Show an Update available badge with an Upgrade button for installed plugins that have a newer published version
- Change installed plugins to show an Enabled or Disabled badge with Enable/Disable and Uninstall buttons
- Patch @rapidmx/react-shared 0.4.0 with the plugin search, update and namespace API functions until its next release
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Check what installing or upgrading a plugin also takes before doing it: conflicts are explained instead, and other plugins it installs or enables are listed for confirmation first
- Show the dependencies installed or enabled with a plugin, reloading the list after a version change or enable that brought some in
- Show Requires and Required by on installed plugins
- Refresh the @rapidmx/react-shared patch with planPluginChange()
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Delete every local search index on sign-out and wait for it before leaving, and remove indexes for mailboxes the signed-in user can't access
- Run local index worker requests one at a time per mailbox, take a per-mailbox browser lock, and rebuild an index found corrupt instead of failing forever
- Only narrow encrypted search to the local index once a build is complete, dedupe load-more pages and ignore stale search, folder, label and calendar responses
- Skip already-indexed messages when rebuilding, limit fetch concurrency, measure the index budget by database size with incremental vacuum and evict in bulk, and prune messages no longer on the server
- Load labels for the selected message's own mailbox, and keep folder changes from archive and scheduled-send cancel in the local index
- Only offer mailboxes the user can write to in compose From and the new event, contact and to-do mailbox pickers, and create the new draft before deleting the old one when From changes
- Settle an earlier unlock request instead of leaving it pending, and only check setup status for trusted users
- Confirm enabling a plugin through the dependency preview, send the confirmed plan with every plugin change, keep polling status after errors and changes, re-check the Add plugin preview when the name or version changes, and send only changed plugin settings
- Require downloading the escrow private key before confirming it was saved, delay revoking the download URL, and make generated key fields read-only
- Confirm running setup again, warn before discarding unsaved settings in the wizard, save step progress in order, retry a failed domain load and require a domain before finishing, and keep locally created mailboxes when the list reloads
- Show access granted outside the Sharing page as custom access
- Refresh the @rapidmx/react-shared patch
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Only narrow encrypted search to the local index for mail a build completed this session covered, searching mail newer than the pass, and key the Tier 3 cache by the windows searched
- Index custom folders, re-walk folders whose message count changed mid-build before pruning, cancel builds from before a lock, and skip messages older than the eviction watermark
- Close the reopened index when rebuilding after corruption fails, and detect corruption by SQLite error codes rather than message text
- Sign out of local search in every tab, remove index directories inside each mailbox's queue and retry failed removals on the next load, and skip stale-index cleanup when the mailbox list is truncated
- Offer mailboxes in compose and pickers by the caller's own create access from getMyMailboxAccess, cached per page, without blocking the From list; delete superseded drafts when compose closes
- Show a retry when mailbox auto-provisioning can't check the policy
- Send every plugin setting again so saving doesn't wipe unchanged ones, enable plugins without the registry when planning fails, and skip dependency planning for version changes of disabled plugins
- Poll plugin status with backoff until it loads without overlapping requests, track busy plugins per row, show when the plugin list may be out of date, and ignore a closed Add plugin dialog's late result
- Keep unsaved setup edits tracked when choosing the current step, send only changed mailbox policy fields without rounding quotas, and clear retention periods by sending null
- Refresh the @rapidmx/react-shared patch
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Regenerate recovery codes safely: add uniquely labelled new wraps before removing old ones, confirm removing unlock methods and never remove the last one, and show rotated recovery codes as soon as rekey succeeds
- Search the open mailbox in every search tier, keep privacy export and erasure to the caller's own mailbox, and clear decrypted rows, previews and caches when keys lock
- Keep mailbox versions between saves, clear dates and fields with null, add federated read receipt settings, parse date-only values as local dates, and page contacts and tasks past 500
- Edit single occurrences without their series rule, apply series edits as time-of-day changes, keep organizers on invited events, and store all-day events as dates
- Never send plaintext when Encrypt or Sign can't be honoured, autosave drafts and confirm discards, replay schedule times, block encrypted Bcc and inline images, and restrict decrypted HTML to data and cid URLs
- Call the auth server's logout on Sign Out and sign out other tabs, and keep delegates from enrolling keys on shared mailboxes
- Require at least one condition before saving mail filters and transport rules, and stop unticked or emptied conditions from inverting or disabling rules
- Sanitize branding HTML and leave it out of the escrow console, confirm escrow scope, erasure, retention, matter close and approval, revoke and impersonation actions, and keep admins from becoming escrow holders
- Page admin and escrow request lists, label matter export audit actions, assign mailboxes to escrow scopes, and show server-wide plugin errors
- Refresh the @rapidmx/react-shared patch
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Never offer removing the last password wrap, and re-seal every key vault entry on rotation, refusing when any entry won't open
- Only offer adding a password when none exists, and keep escrow re-add visible when re-wrapping escrow fails after rotation
- Check free space before regenerating recovery codes so working codes never drop below the original set
- Limit export, erasure and import to the single mailbox the user owns, and key-vault writes to the owner when not impersonating
- Stop load-more retry storms and double loads, discard decrypts that finish after a lock, and reset Search all mail on context changes
- Show a notice when contacts or tasks hit the listing cap
- Disable close and discard while sending, hold autosave until encryption decisions are known, and require unlock when auto-encrypting with locked keys
- Recognise organizer aliases, default key provisioning to off, and clean up the old draft after a From switch using its latest version
- Save pending compose drafts before leaving the page or signing out
- Warn when a series save may duplicate detached occurrences, and explain messages not addressed to this mailbox
- Schedule sends through the send request body, following restapi's new contract, and refresh the react-shared patch
- Only send an escrow scope's public key when it changed, hide closed matter actions, and confirm escrow scope and retention reductions
- Call auth-server's logout from the admin and escrow consoles, keep plugins disabled when their preview fails, and block modal close while busy
- Continue paged lists after the last shown row, page transport rules in sequence order, and explain audit chain verification failures
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Show signatures from signers without a pinned contact key as signer not verified, using pinned signing fingerprints from the mailbox's contacts
- Show the signed Subject and only the attachments inside verified or decrypted content, and note when the delivered Subject differs
- Disable key rotation while a signing enrollment is pending, offer cancelling it, and send the replacement escrow wrap with the rekey itself
- Re-check the vault before first-time key setup and show an already-set-up screen on VaultAlreadyInitializedError
- Explain unopenable encryption keys on unlock instead of reporting an incorrect password, and list skipped signing keys
- Restore a removed recovery code when its replacement fails, destroy local indexes after console sign-out, and mark sign-out so compose's leave prompt can't block it
- Keep loading full pages that add no new rows, hide Deleted contacts from read-only delegates, and show in-progress statuses with neutral badges
- Show scheduled send errors on Outbox messages with a Move to Drafts action
- Keep compose open when a draft can't be saved, run draft saves in order, retry encryption policy loads, and treat unloaded encryption settings as possibly encrypted
- Refresh a draft's version after attachment uploads so discard works, and retry discards against the server's version
- Seed weekly recurrence from the event's start weekday and clear weekdays when leaving Weekly, and read legacy all-day end dates on the local calendar
- Refuse mailbox display names containing @ or line breaks, and refresh the react-shared patch
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Show the real sender address beside signature badges and warn when a display name looks like a different address
- Note when a verified signature doesn't cover Subject, To and Cc, and list recovered attachments for decrypted mail whose signature failed
- Show Sending while a send lease is live, hide Outbox actions then, and reload the message after a refused cancel or move
- Clear the pinned signer cache on lock, sign-out and contact changes, and detect a Deleted contacts view the server didn't filter
- Warn on members-only distribution lists that they need the mail server's trusted authserv id, and refuse look-alike @ in mailbox display names
- Re-check encryption suppression before a queued draft save runs, don't autosave before recipients are known when auto-encryption is possible, and retry failed key lookups
- Block sends when the mailbox or a key lookup couldn't be checked unless the user chooses to send without encryption
- Verify the session master key still opens the vault before adding wraps, regenerating recovery codes, enabling signing, adding escrow or rotating
- Only re-add escrow on rotation when the vault already holds an escrow wrap, treating a deleted scope as none
- Stop Discard from deleting a message another window already sent or scheduled, and omit address-like display names from signed and encrypted From headers
- Refresh the react-shared patch
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Require a new password before removing the last recovery code, and explain every password replacement failure without removing the code
- Refresh the react-shared patch
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Show when a pinned sender's signing key changed, comparing the trusted and new keys with their dates, with Accept new key after confirmation and Keep current key for a recorded change
- Show recorded key changes with accept and keep actions on contacts, list replaced keys as history, and label superseded keys separately from revoked ones
- Point unpinned senders with a recorded key change to their contact instead of offering Trust this signer
- Refresh the react-shared patch
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Show "Verified when first opened" for signed mail whose live check fails only because the signer's key changed, was removed or was revoked, with a caution badge when the key was later reported compromised
- Write verification seals after a live verification, best effort, once per message and master key generation
- Seal newly verified encrypted mail while building the local search index, bounded to two concurrent writes and 200 per pass
- Refresh the @rapidmx/react-shared patch with verification seals
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Fixed
- Fixed infinite scroll and offset paging after archiving, keep booking link and contact pages on save errors, and confirm task and contact deletes
- Fixed all-day series end dates west of UTC, keep series time shifts on the event's own clock, and keep weekly rules from collapsing to daily

## [0.4.0] - 2026-09-14

### Added
- Added UnlockPromptProvider/useUnlockPrompt() (mounted once in
- Added Settings > Sharing: manage who can access a mailbox, by email
- Added a From drop-down to compose
- Added a Mailbox drop-down when creating a calendar event
- Added a Mailbox drop-down when creating a contact
- Added a Mailbox drop-down when creating a to-do
- Added an admin Plugins page: list installed plugins with their per-server load status and errors, add a plugin after previewing it from the registry, change its version, edit its manifest-declared settings, enable, disable and remove it, with rollout progress and safe-mode warnings while servers restart
- Added Plugins to the admin navigation
- Added a first-run setup wizard at /admin/setup that walks an administrator through plugins, a domain and its DNS records, encryption, retention and mailbox policies, escrow, branding and the first mailboxes, resuming at the saved step and finishing with Finish setup
- Added an escrow step that can generate the escrow key pair in the browser, requires the private key to be downloaded and confirmed as saved before creating the scope, or uses an existing certificate, or skips escrow, and is hidden when end-to-end encryption is turned off everywhere
- Added Encryption Policy and Mailbox Policy admin pages and navigation items
- Added a Run setup again button to the admin Mailboxes page

### Changed
- Gate the E2E unlock prompt on demand, not on every page load
- KeyEnrollmentGate previously blocked all of Mail behind a full-page
- unlock screen the instant a mailbox with an existing vault resolved,
- regardless of what the user was actually doing - since this app has
- no client-side router, every navigation between top-level apps is a
- full page load, so this re-prompted constantly even for reading
- plain, unencrypted mail.
- AppShell, alongside useIdleKeyTimeout) as the on-demand counterpart:
- resolves immediately with no UI when a mailbox is already unlocked
- this session, otherwise shows a lightweight modal instead of a
- full-page takeover. KeyEnrollmentGate gets a new `blocking` prop
- (default true, unchanged everywhere except MailShell) so first-time
- key provisioning still always blocks, but an already-enrolled,
- not-yet-unlocked mailbox no longer does.
- Wire requestUnlock() into the three places unlocking is actually
- required:
- - ComposeWindow: signing/encrypting a message
- - MessageDetailPane: viewing an already-encrypted message
- - the inbox list and Tier 3 encrypted search (apps/www/index.tsx):
- decrypting a loaded row's "[...]" subject/preview, or including
- encrypted matches in search results - both silently skipped this
- before, with no indication unlocking would help
- Settings > Encryption keeps its existing blocking gate unchanged -
- navigating there already means managing encryption.
- Also adds a copy-to-clipboard button next to recovery codes on both
- screens they're shown (initial key setup, and Settings > Encryption
- regenerate/rotate), matching this codebase's existing
- admin/domains/[uid].tsx copy-button convention.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement Tier 2: local encrypted search index over recent mail
- Adds the local index tier from specs/search.md's 3-tier encrypted
- search architecture - Tier 1 (server) and Tier 3 (server-narrowed
- candidates) already existed; this is the remaining piece, a
- full-fidelity local index over recently-decrypted encrypted messages,
- so their content is fast to search without a server round-trip.
- Uses @journeyapps/wa-sqlite (PowerSync's actively-maintained fork of
- rhashimoto/wa-sqlite - the plain "wa-sqlite" npm package is an
- unrelated, unmaintained name-squat with no repo/license, avoided
- deliberately) for WASM SQLite + FTS5, over the OPFS SAH Pool VFS.
- EncryptingVFS (localIndexVFS.ts) is a from-scratch AES-256-GCM
- page-encrypting VFS wrapping that pool VFS: per-page random nonces
- (never reused, sidesteps any counter-persistence hazard), AAD bound
- to filename+page index (catches block reordering/tampering, not just
- per-block corruption), journal_mode=OFF (a documented, deliberate
- simplification - this index has no durability requirement, spec
- already requires discard-and-rebuild on corruption/schema
- change/eviction). Verified twice in a real headless Chromium session
- via Playwright before relying on it: the plain OPFS pipeline, then a
- genuine encrypted close-to-reopen-to-decrypt round trip. Covered by
- 7 real-WebCrypto unit tests (round-trip, tamper detection, wrong key,
- block-position swapping).
- Full RPC surface in the Worker (index/remove/search/coverage/
- setWindow/destroy), FTS5 bm25() ranking matching the existing
- subject/participants/body/attachmentText field weights, oldest-first
- byte-budget eviction, and lifecycle hooks wired into idle-timeout,
- the manual "destroy keys now" button, and logout (a real, previously
- unfilled gap - logout was a bare navigation with no explicit
- key/index teardown call at all).
- Merges into the existing 2-way search UI as a real third source:
- apps/www/index.tsx's mergeSearchResults()/searchMessages() now
- combine Tier 1 + Tier 2 + Tier 3, with a coverage line showing how
- far back local search reaches.
- Deliberately deferred (flagged, not dropped): the full animated
- skeleton/reordering progressive-results UI, and bounding Tier 3's
- query to Tier 2's own coverage window (a bandwidth optimization, not
- a correctness gap - Tier 3 still runs unbounded today).
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Make the Tier 2 local index's byte budget a user-adjustable, per-device setting
- Defaults to 500 MB in a browser tab and 1 GB in the Electron shell (detected
- via the window.rapidmx preload bridge, per-device via localStorage - same
- posture as idleTimeout.ts), with a picker in Settings > Encryption to override
- it. Supersedes the prop-threaded windowConfig plumbing added earlier this
- session (MailShell/LocalIndexLifecycle), which required each consuming shell
- to explicitly opt in - this resolves automatically instead.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement Tier 2 search's two deferred items: composite pagination cursor and Progressive Results UI
- Composite cursor (spec §8): threads Tier 1's server cursor, a new real OFFSET/hasMore
- pagination path in the Tier 2 worker, and a cached/sliced Tier 3 candidate array through
- both the fresh search and loadMore() - avoids a react-shared change (and its publish+patch
- cycle) by caching Tier 3's one decrypt-and-match pass per query instead of adding it a
- server-side cursor.
- Progressive Results (spec §_Progressive Results_): unconfirmed Tier 1 metadataOnly hits
- render as in-place skeleton rows, resolve or get pruned once Tier 2/Tier 3 report, a hard
- result count is withheld until every tier settles, and a new "Search all mail" action lifts
- Tier 3's default bound (tightened to Tier 2's coverage window otherwise).
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Lists a mailbox's delegates with a viewer/manager role picker, adds someone
- by email (resolved to a user via the new lookup-by-email route), and removes
- access behind a confirm dialog. One grant covers the mailbox's mail,
- calendar, contacts, and tasks, since folder ACLs already inherit from the
- mailbox. A 403 from the list call renders a "can't manage" message.
- Patches @rapidmx/react-shared 0.3.0 with its new mailboxAccessApi.ts (real
- tsc build output), since this repo consumes it as a published dependency.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Show every accessible mailbox's folders in Mail, plus merged All Mailboxes folders
- MailShell now renders each mailbox's own folder tree at once (shared ones
- labeled), replacing the single-mailbox switcher, and adds an All Mailboxes
- section (Inbox, Sent Items, Drafts, Deleted Items, Junk) with summed unread
- counts. ?aggregate=<type> selects one; the inbox list then fetches that folder
- from every mailbox in parallel and merges newest-first, labeling each row
- with its mailbox. One mailbox's fetch failure doesn't hide the rest.
- Deliberate limits for this pass: aggregate views show each mailbox's first
- page only (no load more), search and Focused/Other are disabled there, and
- unlock/decrypt stay scoped to one mailbox (the caller's own), so encrypted
- rows from another mailbox stay locked until opened in that mailbox.
- Compose gets a from-mailbox picker when there's more than one mailbox. Also
- fixes a brief empty-sidebar flash before folders load.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Show every accessible mailbox's calendars together in Calendar, color-coded per mailbox
- CalendarShell now loads calendar folders for all accessible mailboxes in
- parallel (replacing the mailbox switcher), and the sidebar groups them into
- one section per mailbox, with a shared mailbox labeled and its own
- "+ Add calendar". Events from every checked calendar render together.
- An uncolored calendar in someone else's mailbox falls back to that mailbox's
- accent color, so a shared mailbox's calendar is distinguishable from the
- caller's own default blue; explicit calendar colors still win. New/edited
- events use the target calendar's own mailbox for the organizer address and
- calendar picker. A folder-load failure shows only in that mailbox's section.
- Refreshes the react-shared 0.3.0 patch to include the new color helpers.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Document the shared-mailbox feature, its scope limits, and two gotchas
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- The compose window now lists every mailbox you can send from. A new message
- defaults to your own mailbox; a reply or forward defaults to the original
- message's mailbox, so replying to a shared mailbox's mail sends from it.
- Changing From discards the current unsent draft and starts a fresh one in the
- new mailbox's Drafts folder (reloading its signing/encryption context),
- keeping recipients, subject, and body. Once an attachment or inline image is
- uploaded the draft can't move mailboxes, so From locks.
- Replaces the sidebar "Compose from" picker; Contacts' Email action now also
- defaults to your own mailbox. Refreshes the react-shared patch for
- deleteMessage().
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- With more than one mailbox, the new-event form shows a Mailbox selector
- (defaulting to the calendar you clicked, else your own mailbox). Picking a
- mailbox switches the Calendar selector to that mailbox's calendars and makes
- it the organizer. Editing an existing event is unchanged.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- With more than one mailbox, the new-contact form shows a Mailbox selector
- defaulting to the mailbox being viewed. Choosing another mailbox saves into
- that mailbox's own Contacts folder; since it won't appear in the current
- list, a notice links to that mailbox's contacts instead.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- The Tasks quick-add form shows a Task mailbox select when the user has more than one mailbox, defaulting to the mailbox being viewed. Choosing another mailbox files the task in that mailbox's Tasks folder and shows a notice linking to its task list instead of appending the task to the current one.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Update the tests for the branding, retention policy and encryption policy APIs now served under system/
- Refresh the @rapidmx/react-shared patch with pluginsApi and the system/ settings paths
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Redirect administrators to the setup wizard from every admin console page and from the webmail apps while setup is required, leaving non-admins and impersonating admins alone
- Refactored the retention policy, branding, plugins, domain DNS setup and new mailbox forms into shared components used by both their pages and the wizard; the new mailbox form now starts from the mailbox policy's default quota
- Refresh the @rapidmx/react-shared patch with setupApi, mailboxPolicyApi and escrow key generation
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Upgraded @rapidmx/react-shared dep

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

[Unreleased]: https://github.com/rapidmx/web-client/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/rapidmx/web-client/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/rapidmx/web-client/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/rapidmx/web-client/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rapidmx/web-client/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rapidmx/web-client/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rapidmx/web-client/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/rapidmx/web-client/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rapidmx/web-client/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rapidmx/web-client/releases/tag/v0.2.0
