# Release Notes

## Unreleased

## v0.12.0

## v0.11.0

Needs `@rapidmx/react-shared`'s next release (`queueMessageSend`, the send-event parser and the 401 observer) and, for the background send, an `@rapidmx/restapi` that answers `POST /mail/messages/:id/send` with `{ "background": true }` by `202 { "status": "queued" }` and publishes `send-succeeded` / `send-retrying` / `send-failed` events. Against a server without them Send still works: the client then sends the ordinary way and shows "Message sent" when it is done. Appearance needs `@rapidmx/react-shared`'s `appearance/preferencesApi.js` and an `@rapidmx/restapi` and `@rapidmx/server` with the `/mail/preferences/appearance` routes and the `appearance` page prop; without them a change is undone with a message when its save fails.

### Security

- **The admin console shows administrative details only, and "Impersonate this user" replaces "Access this mailbox".** The server no longer lets an administrator read other users' mail through the ordinary
  mail API (see `@rapidmx/restapi`'s release notes): an administrator sees their own mailbox and the mailboxes shared with them, in the mail client and in Settings, and nothing else. The console's mailbox
  list, mailbox page, setup wizard and the quarantine / ingest-queue pages ask for the administration scope (`scope: "admin"`), say that they show administrative details only, and the mailbox page's button
  is now **Impersonate this user** (the impersonation banner is unchanged). **Shared access** uses the audited Sharing endpoints: review and revoke any mailbox's members, **Add me** and a Read only / Full
  access grant on a shared (ownerless) mailbox - how an existing one such as `hello@` reaches the administrator's own mail client - and no grant form for a mailbox that has an owner. The mail client itself
  calls the plain endpoints and needs no change: its mailbox switcher and Settings dropdown now list only own and shared mailboxes. Needs the `@rapidmx/react-shared` and `@rapidmx/restapi` releases that carry this.

### Fixes

- **Your own Sent Items copy of an encrypted message wrongly said it "wasn't addressed to this mailbox."** The reading pane's "not addressed to you" notice compared the reader's address against the
  message's protected To/Cc headers, which never include the sender's own address on an ordinary send - so it fired on every encrypted message you sent, not just a genuinely forwarded/re-sent/Bcc'd one.
  It no longer shows in Sent Items; it still shows everywhere else.
- **Contacts no longer overlap.** The toolbar (New contact, Edit, Delete, Email, Favorite, Add category, Export, Import) was wider than the 384 px column it sat in, so its right end ran over the empty state ("Select a contact, or create a new one.") and, with the New contact form open, over the form's heading. The three panes now have a proper layout: the list is a third of the window (16 to 26 rem), the detail pane keeps the rest, each scrolls on its own (from tablet width up the page is exactly as tall as the window), the empty state is centred, the new/edit form has its own scroll area with **Save / Cancel always in view** (opaque over a background picture), the form's two-column rows follow the pane's own width rather than the window's, the list's Contact info column truncates instead of pushing the page sideways (a phone no longer scrolls sideways), and the contacts menu becomes a drawer below 1024 px so a tablet does not get a cramped third pane. A single-mailbox user also no longer has an empty 224 px column left of the contacts menu (the mailbox switcher's column is only there when there is a switcher).
- **Calendar and Tasks fit narrow windows too.** The same checks found the calendar's toolbar and month grid running off the right edge at 768 px and 390 px (the column could not shrink below its widest row; the toolbar row now wraps and the view buttons wrap under it), the Tasks "Add a task" row (title, due date, priority, Add) running off the pane on a phone (it wraps), and the same empty 224 px column in Tasks. Their menus become drawers below 1024 px like Contacts'.
- **New folders appear without a refresh.** The server makes Outbox, Sent Items and the other well-known folders lazily, on first use, and never said so: a new account's sidebar showed only Inbox, Drafts and Deleted Items until the page was reloaded. The client now files a folder the moment a `Folder` create event arrives (once, however many channels deliver it), subscribes to its push channel, reads its real counts, follows a rename or type change and drops a deleted one; and - whichever way a folder appeared and whether or not an event arrived - every refresh of the folder counts (a message event, or a message on screen, in a folder it does not know, a send outcome, the 45 s poll, the window getting focus, the browser coming back online, a reconnect, the server accepting a queued message) lists each mailbox's folders again and files any the sidebar lacks. Adding a folder no longer reloads the message list on screen. The sidebar shows one folder per well-known type (the oldest, as the server does), and Delete / Report junk no longer create Deleted Items or Junk themselves when the page's folder list is out of date - they ask the server for it first and create only where the server really has none (an older one). The sidebar order is now fixed: Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk Email, Archive, then your own folders; and a folder that appears has its badge right at once.
- **The Outbox and Sent Items show up the moment a message is on its way.** One mechanism instead of two: while a message is being handed to the server and the folders do not exist yet, the sidebar shows muted, non-link Outbox (with the sending indicator) and Sent Items rows in their places, and they are replaced by the real folders as they arrive - never a duplicate row.
- **Push channels are asked for in a better order.** Inboxes, then the mailbox itself (it announces new, renamed and deleted folders, so it must outrank any folder's own mail), then the other folders in the sidebar's order - so when the server's 40-channel cap bites it is the last folders that go without live updates, not the folder-create announcements.

- **Sharing shows who it is granting to, and flags entries that never matched anyone.** The admin console's **Shared access** and **Settings > Sharing** take an address, username or user id, look the person up and show their name and address before **Grant**, and store their user id (a grant to a typed username applied to nobody - the live shared mailbox `hello@` was granted to `jean-philippe`, so it never appeared in the mail client). An entry that is not a user id is flagged
  "Not a user - this entry has no effect" with **Replace with a user** (shared mailboxes in the console; every mailbox on the Sharing page) or Remove.

### Features

- **A dark / light switch in the account menu.** A "Theme" row with three icon buttons - System, Light, Dark - in the account menu (every shell that has the appearance provider: the app, the admin console and the escrow console). It applies in the same frame through the appearance provider (so message cards, the frame and the consoles all follow), saves in the background (rolled back with a pop-up if the save fails) and survives a reload from the browser's copy and the server's. It is a `radiogroup`: one tab stop, the arrow keys, Home and End move and choose, each button has a tooltip and an accessible name; it is not shown where there is no provider (a plugin page's own chrome).
- **Signing certificate progress on Settings > Encryption.** The "Digital signatures" section is now a **Digital signature certificate** card: a progress bar (the server's 0-100, with a moving highlight only while a step is active; `role="progressbar"` with a text value), the steps (request sent, verification e-mail, answered, validated, issued) each with a done / active / waiting / failed icon and its time, a plain-language line ("Waiting for the CA's verification e-mail", "Verification answered - waiting for the certificate", "Issued - valid until ...", "Failed: <reason>"), "Requested 4 min ago - last checked 20 s ago" kept current, and a **Check status** button that asks the server to re-check with the CA now, shows it is working, updates everything at once and says what came of it ("Still waiting - checked just now", or the new state); it waits out the server's rate limit with a countdown. While the enrollment is pending the page reads it with a 15 s, 30 s, then 60 s backoff, **only while the tab is visible**, stops when it ends and asks at once when you come back. An issued certificate shows its subject, issuer, serial number (shortened, with a Copy button), when it was issued and its expiry, with a warning and **Renew** inside 30 days; a failed one shows the reason and **Try again**; an expired one offers a new request. The card's words follow how the deployment issues certificates (`GET /api/system/signing-enrollment`): an automatic request says which CA it went to, that its verification e-mail goes to the mailbox's address and how long it usually takes; a manual deployment says an administrator has to upload the certificate (with the request date and the administrator's contact, never "takes effect automatically"), with no progress bar or steps; a CA that reported a problem is a warning row with its last successful contact; a request more than an hour old with no change says "This is taking longer than expected" with when it was last checked; and a request the server no longer knows (another provider after a configuration change) is cleared with "This request is no longer active - request a new certificate" and a new request is offered. A deployment that issues none offers no request; an older server gets neutral wording that claims nothing. A mailbox that never asked keeps the original "Enable digital signatures" button and rotation stays blocked while an enrollment is pending. An enrollment started on another device is found through the server. A certificate the CA has issued but the server has not installed yet (a background job does that a few minutes later) says "installing it on your mailbox", the page counts it as issued rather than offering "Enable digital signatures" again, and keeps looking for the new key; a CA that could not be reached is shown as still pending and retried, and the server's note is shown under the status. Everything new is optional in the server's answer: an older server still gets the old sentence, a plain progress bar and a plain Check status.
- **You are told when the certificate arrives, wherever you are.** A watcher in the app frame follows the enrollments of the mailboxes you own (the stored id, and the mailbox's current one from the server) and raises a pop-up when a certificate is issued ("Mail from ... is now signed (valid until ...)", with a View action) or fails (the reason, with Try again) - once per enrollment, on any page, and never for a certificate issued long ago. The Settings card and the watcher share one follower, so an enrollment is asked about once however many look at it.
- **Toolbars that fit their column.** Contacts' toolbar is now a `ResponsiveToolbar`: with room, every action with its caption; then icons alone (every button keeps its tooltip - New contact its shortcut's - and accessible name); then the rarely used actions (Import, Export, Add category, then Favorite, Email, Delete, Edit) in a **More** menu, a real keyboard menu (arrows, Home, End, Escape, focus back to its button). Arrow keys, Home and End also move along the bar. It can never paint outside its own column.

- **One kind of pop-up for everything the app has to tell you.** New mail, a message that wasn't sent, a failed action, an expired session, encryption problems and the connection dropping all use the same pop-ups, in one stack at the top right *under* the header - so it never covers the account menu, the header's buttons or a compose window. At most three show at once (the rest wait their turn); errors and anything with buttons stay until you dismiss or resolve them, everything else goes by itself after a few seconds (they pause while you hover or focus them, and while the tab is hidden); the same problem happening again is one pop-up with a count ("x3"), never a stack; errors are read out at once, the rest politely; Escape dismisses the one that has focus; and with reduced motion on nothing animates. An error's technical details are one click away, monospace, with a Copy button.
- **"Recent notifications" in the account menu.** The last 30 pop-ups (kept for the session), with a red count and a dot on the menu button while errors nobody has looked at are in it - so an error that expired while you were elsewhere isn't lost.
- **Send doesn't make you wait.** Press Send (or Ctrl+Enter) and the compose window closes at once: the message is checked, saved, signed or encrypted if that applies and handed to the server in the background, and it appears in the Outbox with its count. Nothing you do waits for the network. If anything fails - preparing the message, encrypting it, the request, or the server's own delivery - you get a pop-up "This message wasn't sent" with the reason, the technical details, and **Retry** and **Open draft** (which re-opens the compose window with everything as you left it); the message is never lost. A retry that the server already has is not sent twice. A message the server retries says so once ("Retrying to send..."), and one that goes out gets a short "Message sent". Send later works the same way. If you leave the page while a message is still being prepared, the browser asks first; once the server has it, leaving is safe. An attachment that is still uploading when you press Send is waited for, with a note in the window.
- **The Outbox shows how many messages are on their way.** Its count is a small pill next to the name: it counts a message the moment you press Send, animates while anything is going out, turns red while a message failed and is waiting for you, and is read out as "2 messages sending" / "3 messages, 1 failed".
- **"Something went wrong", once.** An unexpected error anywhere in the page shows one pop-up with the details (never a flood), and a request the server refuses because your session ended says "Your session expired" with a Sign in button - from any request, background refreshes included. A lost live connection says so, subtly, after ten seconds, and the pop-up goes when it is back.
- **Every message is a card, and the subject has a card of its own.** The reading pane is a header card with the subject (and "N messages") pinned at the top, and under it one rounded, bordered card per message: the sender's initials, `Name <address>`, To/Cc/Bcc, the time and the actions in its header, the body, and Reply and Forward at the foot of a single message and of the newest open one in a conversation. A slim bar says "You replied to this message." / "You forwarded this message." An older message of a conversation is a collapsed card (sender, date, first line) that opens on click or Enter, as before; the pane scrolls as a whole, the subject card stays put, and on a phone the actions wrap under the sender. The pane draws its frame - header card and a skeleton card per message - at once, before the messages or their bodies arrive.
- **Each message is exactly as tall as its content.** The body is no longer a full-height white box with a scrollbar of its own: it is measured and shown at its natural height, follows images loading and the window being resized, and a table or picture wider than the card scrolls inside the card instead of widening the pane. Printing a message prints all of it.
- **Mail takes your theme.** Plain-text mail and HTML mail with no colours of its own (a typed reply) are drawn on the app's surface in its text and link colours, in light and dark. Where the HTML does set a colour, it is respected: text on the theme's surface stays if it reads and is adapted if it doesn't (authored black text becomes white in a dark theme, a low-contrast navy is lightened just enough), and anything on an authored background - a white table, a banner, a gradient - is shown exactly as its author made it, with text nobody coloured turned black or white to suit that background. A message with its own dark styles gets them when the theme is dark. Your custom Appearance colours are followed, and the body always sits on an opaque surface, so mail stays readable on a background photo.
- **"View original" for one message.** A button in the message's header (a sun; a moon puts it back) shows that message exactly as its author wrote it - white page, their colours - for the rest of the session. It appears only where adapting to the theme changes something.
- **Message bodies are sanitized a second time in the browser and isolated.** The server's sanitizer stays the first layer; the browser now also sanitizes what the server sends (and what it decrypts or verifies itself), removes forms, frames, media, plug-ins and SVG's active elements, keeps only `http(s)`, `mailto` and `tel` links (each opening in a new tab without an opener), and shows the result in an iframe that can run no script, behind a Content-Security-Policy that allows no script, object, frame, form or fetch. Remote images are still never loaded. A message too large to show inline (over 1.5 MB of markup or 20,000 elements) is offered on its own page.
- **Inline images show.** An image a message carries inline (`cid:`) is shown for a message you decrypted or verified here (from the part inside it) and for one the server kept the image of (from its attachment).
- **An encrypted message you have not unlocked says so, with an Unlock button.** Opening one used to show the single word "Encrypted" in plain black serif on a white slab. It is now a themed panel in the message card: a lock, "This message is encrypted", "Unlock your keys to read it" and an **Unlock** button. Unlocking - with the button or from anywhere else, such as the compose window or another message - opens the message in place, and the focus moves to it. A message that cannot be decrypted (not addressed to you, damaged) says "This message can’t be decrypted" with the reason and no button, since unlocking would not help. The subject shows as "Encrypted message" instead of the server's placeholder "[...]", and the encrypted badge has a lock.
- **Encrypted messages are recognisable in the lists.** A message or conversation whose text the server cannot preview shows a small lock and "Encrypted message" on its preview line - in the message list, in an expanded conversation and on its collapsed cards in the reading pane - instead of an empty line. Once decrypted, its own preview replaces it.
- **The keyboard shortcuts work with the focus in a message body.** Ctrl+R, Delete and the rest used to reach the browser once you had clicked into a message; the body now hands the key to the app.
- **A custom header is the top of the app.** When the Branding page has a header, it replaces the app's own title bar and the icon at the top of the icon rail: the rail starts with the app icons, the header stays at the top of the window in every app, and the account menu (Account, Settings, Sign Out, notifications, keyboard shortcuts, Admin Console) moves into it. The frame is the right shape from the first paint - it uses the branding the server rendered the page with - instead of showing a title bar for a moment first.
- **`{USER_MENU}` and `{APP_TITLE}` in the header and footer HTML.** Write `{USER_MENU}` where the account menu should go and `{APP_TITLE}` where the name of the app on screen (Mail, Calendar, ...) should show; it follows you between apps without a page load. `{USER_MENU}` is replaced once (the header's, else the footer's, else the menu sits in a small cell at the right end of the header, so it is never lost), further copies are removed, and neither variable is touched inside attributes, scripts or links. The menu opens over the page whatever the header's own `overflow` or `z-index`, and fits a phone. The Branding page explains both, with a snippet to copy; the README has the rules.
- **The rail's icon sits flush with the top of the window.** With no custom header the icon is at the very top-left, exactly the title bar's height (its bottom border continues under it), instead of 18 px down; the picture's own empty margin is measured and trimmed at run time.
- **Appearance: your own colour scheme, theme colours and background.** Settings > Appearance lets each user pick System, Light or Dark, four theme colours (primary, accent, surface and text - a picker, a hex field and a Reset each, with a warning under 4.5:1 contrast) and a background: none, a colour, or a picture (PNG, JPEG, WebP or AVIF up to 8 MB, checked before it uploads, by drag and drop or from a file chooser) with dim, blur and fit. Every change shows in the real app at once - the page you are on is the preview - and saves in the background; if saving fails the change is put back and you are told why. "Reset all" returns everything to the defaults.
- **A background photo covers the whole app, and the panels stay readable.** The picture sits behind the icon rail, header, lists and panes, which become translucent panels in the scheme's own colours (menus, dialogs, drawers and pop-ups stay solid). How see-through they are is worked out from the picture - measured in your browser - so text and muted text keep at least 4.5:1 contrast even over a bright or busy photo; a plainer photo or a higher dim lets more of it through. With no background nothing looks different.
- **Your theme is there from the first paint, and follows you.** The server renders it into the page, this browser remembers the last one it applied (per account, cleared on sign-out) and applies it before anything paints, another tab or device's change arrives live, and the newest copy wins over a page the server cached for a minute. A user's colours override the deployment's branding stylesheet's colours; that stylesheet's own rules still apply to what they style.
- **`useResolvedTheme()` and `useAppearance()`.** `shared/appearance/resolvedTheme.js`: `useResolvedTheme()` is `"light"` or `"dark"`, live, needing no provider (for anything that must match the app's scheme without reading CSS); `useAppearance()` gives the preferences with `setPrefs()`, `uploadBackground()`, `removeBackground()` and `reset()`.

### Fixes

- **Assigning a mailbox's owner or an escrow scope's key holder no longer takes a raw user id you'd have to already know.** The admin console's new-mailbox form and the escrow scope editor's holder list now
  let you type a person's address, username, alias or user id, look them up, and confirm the exact person shown before it's saved - the same resolve-then-confirm picker mailbox sharing already used. Nothing
  searches or lists users by partial name; you still have to know who you're looking for, just not their raw id.
- **The Domain DNS setup checklist now covers Autodiscover.** Two new rows recommend the `autodiscover.<domain>` and `_autodiscover._tcp.<domain>` records a real EAS/Outlook client needs to find this server
  automatically, shown only when the Autodiscover plugin is installed.
- **A hiccup in the encryption settings no longer stops drafts from saving or blocks Send.** Composed messages showed "your encryption settings couldn't be checked, so this draft isn't being saved" whenever the mailbox, the encryption policy or a recipient lookup failed or was slow, and refused to save, close or send until "Retry" worked. A message is now treated as unencrypted - its draft saves, Close and Send work and nothing about encryption is shown - unless encryption is actually in play: you turned it on (or replied to an encrypted message), or the encryption policy was loaded and encrypts for every recipient. A user with no encryption key, or a policy that is optional or prohibited, never sees an encryption message. The checks retry quietly in the background. If a later answer shows the message must be encrypted, saving stops, a plaintext copy already saved is replaced by an empty draft, Close asks the usual question and Send encrypts - it never goes out unencrypted once that is known; a message you explicitly asked to encrypt still refuses to send unencrypted without your say-so.
- **A failed message action tells you why in a pop-up instead of a banner above the list.** Marking, moving, archiving, deleting, flagging and labelling (including the keyboard shortcuts), saving or deleting contacts, events and tasks, creating calendars and task lists, saving settings (auto-reply, read receipts, filters, signatures, exports and imports, sharing, removing an unlock method) now show the server's own message as an error pop-up with details. Field validation, errors that replace a whole page and errors on a form you are still filling in stay where they were.
- **The new-mail pop-up no longer covers the account menu.** It sat over the account menu button for its eight seconds; the pop-up stack now starts below the header - the standard title bar or a custom branded header of any height - stays just below it as the page scrolls, and is kept clear of an open compose window and the open account menu. Pop-ups stay solid over a background picture.
- **Sending twice is not possible.** A double click, a held shortcut or a retry while a send is under way sends the message once.
- **A message no longer shows as a huge white block with the subject and toolbars above it.** The white background is gone: the message sits in a card in the app's own colours (or, where it is designed with its own background, in a framed panel of that colour), so dark mode no longer has a slab of white in it.
- **Opening a message never waits on the body.** The card's header, the subject card and a skeleton are on screen at once and the body fills in; a body that can't be loaded says why, with a "Try again" button, in place of the message; and a body fetched once is kept for the session, so collapsing and re-opening a message in a conversation doesn't ask the server again. The mobile message page shows the same frame while its message loads instead of "Loading...".
- **The focus stays on a message's header when it is collapsed or expanded** in a conversation, from the keyboard or the pointer.
- **Uninstalling a plugin can delete its data.** The admin Plugins dialog has an unchecked **Also delete all data this plugin stored** box that lists what would be deleted (the plugin's database collections and tables, its saved settings, its cached package and pages, and whatever else it cleans up itself) and says **This can't be undone**. Ticking it turns the button into a red **Uninstall and delete data**, asks for the plugin's name before it enables, and explains that nothing is deleted until every server has restarted without the plugin (adding the plugin again before then cancels it). An uninstalled plugin whose data is on its way out stays in the list: **Uninstalled - data will be deleted after servers restart** (with how many servers still run it), **Data deleted <date>**, or **Data deletion failed: <reason>** with the failed steps and a **Retry** button; the page keeps reading the status while a deletion is waiting and raises a pop-up when one that was under way finishes or fails, and a warning when adding a plugin cancels one. Needs `@rapidmx/react-shared`'s next release (`removePlugin(uid, { purgeData })`, `retryPluginPurge()`, `PluginStatus.purges`) and the server's `purgeData` support; an older server ignores the box's request and only uninstalls.

## v0.10.0

Needs `@rapidmx/server`'s next release for the `trustedRoles` page prop (without it the Admin Console lookup asks for `admin`, which is the server's own default). Folder counts are exact only with the `@rapidmx/restapi` release that derives `unreadCount`/`totalCount` and publishes a `Folder` update event after every change; the badges cope with an older one, but a stored count that was never decremented comes back after each refresh.

### Features

- **Unread mail is easy to tell apart from read mail.** An unread row (message list, conversation list and its messages, a message's header in a thread) has an accent bar down its left edge, a faint accent tint, a bold sender and subject and its date in the accent colour, and says "Unread" to screen readers, so it never depends on colour alone. A read row is normal weight with a muted sender. The open row, a hovered row and a keyboard-focused row each look different from unread ones, in light and dark mode. A conversation with several messages keeps its "N unread" count.
- **Folder badges show the right thing, and follow what you do at once.** The Inbox, Archive and your own folders show their unread count when it is above zero (and their name in bold); Drafts and Outbox show how many messages they hold; Sent Items, Deleted Items and Junk Email show nothing. The All Mailboxes entries follow the same rules. Reading a message, marking it unread, moving, archiving or deleting it changes the row and the badges immediately - before the server has answered - and puts them back if the server refuses. New mail bumps its folder's badge as it arrives. The real counts are read back after every change and from the server's folder events, and win over what the page worked out, so a badge cannot stay wrong.
- **One place changes read state.** Opening a message, expanding one in a thread, and Mark read/unread on a selection all go through the same code, which updates the list row, the conversation row's unread count and the folder badge together. A message you open is marked read once per opening: if you mark it unread while it stays open it stays unread.
- **The browser tab shows the unread count.** `(3) Acme: Mail` while the Inboxes hold three unread messages, so new mail is visible from another tab.
- **A pop-up for new mail.** When a message arrives in an Inbox (not Drafts, Sent Items, Outbox, Deleted Items, Junk Email or quarantine, not mail you sent, not mail Focused Inbox put under Other, not old mail imported in bulk, and never on page load or after a reconnect), a notice appears at the top right with the sender's name and address, the subject and about 140 characters of the body, as plain text. At most three show at once; each goes after about eight seconds, unless the pointer or keyboard focus is on it or the tab is in the background; it has a dismiss button and opens the message when clicked. It is announced politely to screen readers and does not animate for people who have asked for reduced motion. An encrypted message shows its sender and subject and "Encrypted message" instead of a preview.
- **Desktop notifications, on request.** With permission, and while the tab is in the background or another window has focus, the same content is shown as a desktop notification (one per message however many events name it, at most five in half a minute); clicking it focuses the tab and opens the message. The browser is never asked on page load: the first pop-up offers "Turn on desktop notifications" and "Not now", and the account menu has the same item. What you answer is remembered in this browser, and a browser that has denied notifications is left alone.
- **New mail pop-ups can be turned off.** The account menu has a "New mail pop-ups" switch (on by default, remembered per browser).
- **An "Admin Console" item in the account menu for administrators whose session isn't elevated.** auth-server strips the administrator role from a token that hasn't been elevated, so an administrator with an ordinary sign-in never saw the link. The menu now asks auth-server for the signed-in user's own record (`GET /api/users/me`, once per half hour per browser tab, remembered in `sessionStorage`) and shows an item with an icon and the text "Admin Console" above "Sign Out" when it holds one of the server's trusted roles (`trusted_roles`, default `admin`). It only navigates: `/admin` still checks the role and sends the browser to auth-server to elevate. Hidden for everyone else, while impersonating and when the lookup fails. It replaces the old "Admin" item, which needed an elevated token.
- **Outlook-style keyboard shortcuts in every view.** One keyboard layer in the persistent app frame, so they work in Mail, Calendar, Contacts, Tasks and Settings alike. Everywhere: `Ctrl+Shift+A` Account (auth-server's account page, when one is configured), `S` Settings, `B` Contacts, `M` Mail, `C` Calendar, `L` To-Do, and `?` or `Ctrl+/` for help; asking for the page you are on does nothing. Mail: `Alt+N` new message, `Ctrl+R` / `Ctrl+Shift+R` / `Ctrl+Shift+F` reply / reply all / forward, `Ctrl+D` or `Delete` delete, `E` or `Backspace` archive, `Ctrl+Shift+V` move to folder, `Ctrl+Q` / `Ctrl+U` mark read / unread, `Insert` flag, `Down`/`J` and `Up`/`K` next and previous, `Ctrl+.` / `Ctrl+,` next and previous unread, `Enter` open, `Escape` clear the selection, `/` or `Ctrl+E` search. Compose window: `Ctrl+Enter` send, `Ctrl+S` save draft, `Escape` close (the keep-draft question still applies), `Alt+N` another message. Calendar: `Alt+N` new event, `T` today, `Left`/`Right` previous and next period, `Ctrl+Alt+1`-`4` day, work week, week and month. Contacts: `Alt+N` new contact, `/` or `Ctrl+E` search. Tasks: `Alt+N` new task. Cmd replaces Ctrl for the mail, compose and calendar actions on a Mac (`Ctrl+Q` and the navigation set stay Ctrl); in the desktop client `Ctrl+N` also creates and `Ctrl+Shift+T` also goes to Tasks. `Alt+N` and `Ctrl+Shift+L` are used on the web because browsers keep `Ctrl+N` and `Ctrl+T`.
- **The shortcuts do what the buttons do, and only what a view can do.** Reply, Reply all, Forward, Archive and Move to call the reading pane's own handlers; Delete, Mark read/unread and Flag go through the selection bar's bulk-action path (the same optimistic folder badges, rollback and lazily created Deleted Items folder), acting on the ticked rows in select mode, else on the open message or whole open conversation. A shortcut is registered only while it can be used, so there are no dead keys (no Reply with nothing selected, no Archive in Drafts or Outbox), and after deleting or archiving from the keyboard the next `Down`/`J` carries on from where the message was. A failure of a keyboard action is shown above the list. Typing is never taken: bare keys do nothing in a text field or the editor, Copy/Cut/Paste/Select all/Undo/Redo/Find are never bound, a modal dialog silences everything but itself, and what a menu or the editor already handled is left alone.
- **A "Keyboard shortcuts" dialog.** Opened by `?`, `Ctrl+/` or the account menu; lists the global shortcuts and those of the view on screen (and of an open compose window) in groups, with the platform's key names (Ctrl or Cmd, Alt or Option) and, in the desktop client, its extra keys; focus is trapped, Escape closes it. Reply, Reply All, Forward, Archive, Move to, Compose, Send, Close, Mark read/unread, Flag, Delete, New event, Today, Previous/Next, the view buttons, New contact and Add a task carry `aria-keyshortcuts` and a tooltip such as "Reply (Ctrl+R)" (their accessible names are unchanged).
- **Mark unread stays unread.** Marking a message that was already read as unread while it is open (single message or inside a thread) would have been read straight back by the automatic mark-as-read; each opening is now asked about once whatever its state.
- **New-mail pop-ups, folder counts and the tab title's unread count work in every app.** The mailbox list, folder tree, counters, the one push connection, the poll, the pop-ups and desktop notifications and the `(3) Acme: Mail` title now live in the app frame instead of the Mail page, so a message arriving while Calendar, Contacts, Tasks or Settings is showing gets its pop-up, moving between apps opens no second socket (the server allows ten per user) and coming back to Mail shows the folder tree at once instead of loading it again. Mail's behaviour is unchanged (same eligibility rules, de-duplication, six-hour cut-off and permission handling); the folder count overlay moved with the socket because it is fed by the same events. A Mail page rendered outside the frame (a test, a plugin page) still runs its own connection.

### Performance

Needs `@rapidmx/react-shared`'s next release for the full saving (without it the inbox page still starts with about 1.05 MB of JavaScript instead of
about 0.47 MB) and `@rapidmx/server`'s next release for the stable `react` and `icons` chunks (without them the chunks are still split, just not named or
cached separately).

- **Moving between Mail, Calendar, Contacts, Tasks and Settings, and between folders, no longer reloads the page.** The pages render a small client-side
  router: one app frame (icon rail, header, user menu, impersonation banner, compose windows, unlock prompt) stays mounted and only the page inside it is
  replaced. Links stay ordinary links - a click on one is taken over, so middle-click, ctrl/cmd-click, "open in a new tab" and copy link keep working and
  the address bar always holds the real, shareable URL (`/?mailboxUid=...&folderUid=...`); back and forward work. A page's code is fetched when the
  pointer, keyboard focus or a press reaches a link to it, and the four app pages when the browser is idle after load (not with data saving on). Focus
  moves to the content after a change, the window scrolls to the top, the tab title follows the page ("Acme Mail: Calendar") and a screen reader is told
  what page it is on. The admin and escrow consoles, plugin pages and external links still load normally, and so does any page whose code can't be
  fetched (offline, or replaced by a deploy).
- **Going back to a folder you just looked at is instant.** Each folder's list (its rows, what was selected and how far it was scrolled) is kept for
  five minutes and shown on the click's own frame while it is refreshed behind it; a folder that wasn't shown shows a skeleton instead of "Loading...".
  Live updates keep running across all of it.
- **A quarter of the JavaScript to start with, and no more 1 MB shared chunk.** An inbox load now fetches 25 chunks / 467 KB (135 KB brotli) instead of
  17 chunks / 2,014 KB (438 KB brotli). The compose window (TipTap/ProseMirror, the emoji list), the reading pane, the S/MIME and X.509 code and each
  page load when they are first needed, or when the browser is idle after load; React is a chunk of its own that a returning visitor keeps across
  releases.
- **The compose window appears on the click.** Reply, Reply All and Forward open the window at once with the recipients and subject already in it, and the
  editor can be typed into straight away; the quoted original is fetched meanwhile and added under the signature when it arrives (what you typed above
  stays, To/Cc you haven't touched are corrected for Reply All, and an untouched reply is still not saved as a draft). Fetching the original used to
  come first - one or two sequential requests with no time limit - so a slow one held the window back for as long as it took (6.5 s with two 3 s
  requests, 15 ms now). The original is now fetched with a 10 s limit (the reply then quotes the preview), and its code and body are fetched when the
  pointer or keyboard reaches Compose, Reply, Reply All or Forward. `performance.mark/measure` entries (`compose:click->shell|editor|body|draft`) show
  the phases in development, or in production after `window.__RAPIDMX_PERF__ = true`.
- **Measured** (Edge, local server, warm cache): folder switch 140 -> 38 ms, back to a folder 155 -> 19 ms, app switch about 140 -> 28 ms; with a 4x
  slower CPU and a 40 ms round trip: first list 1795 -> 1398 ms, folder switch 1518 -> 173 ms, app switch about 1400 -> 100-270 ms, Reply window 155 -> 57 ms.
- **`useNavigate()` and `useLocation()` for code that decides where to go** (`shared/navigation/AppRouter.js`): `navigate("/contacts")` changes the page
  without a load when the URL is a page of the app and is an ordinary navigation otherwise. Documented in the README.

### Fixes

- **Ctrl/Cmd+Enter did not send from the compose body.** The rich-text editor bound it to a hard break, and a key the editor handles never reached the window's Send shortcut, so it added a line and sent nothing. Shift+Enter is still the line break.
- **Enter on a message-list row could not open the message after a click or j/k in conversation mode,** because the thread pane took the focus; it now leaves it on the row when a key press opened the thread.
- **Expanding a failed send's Technical details pushed Send out of the compose window.** The banner now scrolls inside the window (at most 45% of its height).
- **The full-window screens (Choose your mailbox address, No mailbox, Protect your mailbox) sat at the left edge** instead of centred, once they were inside the shared app frame.
- **DNS record names in the domain checklist wrapped one letter per line** beside a long DKIM key; the name column has a minimum width.
- **The Inbox badge did not go down when you read a message and showed the wrong count.** The sidebar showed the folder's stored count, which nothing decremented. It now shows the count the server derives, adjusted as you work and read back after each change (see above).
- **A message you opened stayed bold until the server answered, and a refresh could put it back.** The row changes at once, and a list refresh that started before the change no longer reverts it.
- **Two conversation rows could look identical whether or not they held unread mail** (only the weight of the text differed). See the unread styling above.

## v0.9.0

Needs `@rapidmx/react-shared` with `components/buttons/CopyButton.js`, `auth/profileApi.js`'s `getMyUsername()`,
`mail/pushClient.js`, `mail/mailAddress.js`, `mail/sendFailure.js` and `ApiRequestError.details` (all unreleased), and an
auth-server with its `/auth/elevate` page. The live inbox needs the server's push route (`/push`, already part of
`@rapidmx/server`) reachable from the browser as a WebSocket; without it Mail still updates, on a timer.

### Features

- **New mail appears without reloading the page.** Mail now listens to the server's push channel for every folder of every
  mailbox you can open, so a message delivered to any of them shows up at once: in the open folder's list (in place, at the
  top, without moving your selection, scroll position or the message you are reading, and without marking anything read), in
  a conversation list, in the merged All Mailboxes views, and in the unread badges of every folder in the sidebar. A folder
  another device creates appears in the sidebar too. A safety-net refresh runs every 45 seconds while the tab is visible, and
  straight away when you come back to the tab, focus the window or the network returns - because push messages are never
  replayed for a socket that was down. If the socket can't connect at all (a proxy that blocks WebSockets, say) that refresh
  is all there is, silently. The connection is one per tab, reconnects by itself with a growing, jittered delay, and closes
  when you sign out. A search's results, a list still loading and a page being loaded further down are left alone.
- **Every sender and recipient shows their real address.** A name alone no longer stands in for who a message is from: list
  rows, conversation rows, a message's own header in a thread and the reading pane show `Name <address@domain>` (the bare
  address when there is no name). In a row the name is shortened first, then the start of the address - the `@domain` is
  kept to the end - and the full text is the tooltip. The reading pane lists To, Cc and Bcc separately with every recipient's
  name and address, folding a long list behind "and N more". A name that is itself a different address
  (`"ceo@bank.com" <evil@example.net>`) is quoted, with the real address still last, and the existing "looks like an email
  address" warning still applies. A forward's quoted header now shows the To recipients' addresses too.
- **A failed send says why, with the details.** When sending (or scheduling) fails, the compose window stays open with your
  message as it was and shows the server's message in a banner, with a collapsed "Technical details" block under it - one
  monospace line per fact the server gave, such as each recipient's SMTP code, enhanced status and the remote server's reply,
  and any transport error - and a button that copies all of it to send to whoever runs the server. A response with nothing
  beyond its message shows just the message. Closing a window whose last send failed asks first, since closing keeps the
  draft and would otherwise say nothing about it not having been sent; a minimized window says "Not sent" on its bar.

- **The admin console asks an administrator to confirm their identity instead of refusing them.** The console's
  endpoints require an elevated session, which an administrator's normal sign-in is not, so opening it used to show "You
  do not have administrator access." Now the browser is sent to auth-server's `/auth/elevate` page and comes back to the
  page you were opening once you have confirmed your identity (or lands on your auth-server account page if you cancel).
  Someone who is elevated but not an administrator still sees "You do not have administrator access." If the confirmation
  doesn't take effect - it is attempted at most once every two minutes per tab, so a session cookie that never reaches
  this site can't bounce the browser back and forth - the console says so and offers "Try again".
- **Copy buttons on the DNS setup checklist.** Every value you type into your DNS provider now has its own Copy button:
  each record's name (host) and value, the ownership TXT record's name and value, and for MX the priority and the mail
  server separately, as a provider's form asks for them. The checklist also shows each record's type and name now, which
  it never did, and says "Copied" beside the button you used - or "Couldn't copy" if the browser refuses, in which case the
  value is still on screen to select. Copying works on an `http:` page or with clipboard permission denied too, through
  the older copy command.
- **An Account item in the user menu**, first in the list, that opens your auth-server account page in the same tab. It
  appears in every app (mail, calendar, contacts, tasks, the admin console and the escrow console) and is left out when the
  server has no auth-server URL configured.

### Fixes

- **The admin console no longer shows the custom branding header.** It sat above the console's own header. The footer is
  still shown, and the webmail keeps both. (The Branding page's text now says which is shown where.)
- **"No mailbox available" says why.** When automatic mailbox creation is refused on purpose - not enabled, or no username
  registered for your account - the server's own reason is shown above "Ask an administrator to create one for you." A
  server error or a failed request shows no reason (its message is internals, not advice). A 502, the identity service
  being unreachable, now offers "Retry" the way a 503 does, saying it couldn't reach the identity service.
- **The user menu shows your name, not your uid.** The name still comes from your auth-server profile, but when that has no
  name - or can't be read: some accounts have no profile at all - it falls back to your username (your first verified
  auth-server name alias), then to the uid; the initials badge follows the same order. The username is only asked for
  when the profile gave no name, and neither lookup ever shows an error.

## v0.8.0

### Features

- **Reset a mailbox setting to the server's config value:** on the Mailbox Policy page (and the same section of the setup
  wizard), a field that differs from what the server's config says now shows "Reset to server default (5 GB)" - for the
  default quota, whether people may create their own mailbox, and the quota for those. This is how an administrator takes
  a newly deployed default after having saved the policy, without typing the value in. The reset fills the field in and is
  saved with the rest of the form (nothing is written until Save), and the button disappears once the field is back on
  the config value. Needs `@rapidmx/react-shared` with `getMailboxPolicy()`'s `defaults` and `@rapidmx/restapi`'s
  `/system/mailbox-policy` `defaults` (both unreleased); against an older server no reset is offered.

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
