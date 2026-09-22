# RapidMX: Web Client

[![npm version](https://img.shields.io/npm/v/@rapidmx/web-client)](https://www.npmjs.com/package/@rapidmx/web-client)

RapidMX's webmail (`apps/www`), admin console (`apps/admin`) and escrow console (`apps/escrow`) React UI. The pages are
served and hydrated by [`rapidmx/server`](https://github.com/RapidMX/server) through `@rapidrest/react`'s file-convention
routes, and `@rapidmx/electron-client` reuses the same components. Platform-agnostic API clients, hooks and generic UI
primitives live in [`@rapidmx/react-shared`](https://github.com/RapidMX/react-shared).

## Package layout

The package ships the TSX sources (`apps/`) and a compiled mirror (`dist/apps/`, JavaScript plus `.d.ts` declarations).
There is no root export. Every module is its own subpath, mapped by `package.json`'s `exports` from
`@rapidmx/web-client/<path>.js` to `dist/apps/<path>.js`:

```ts
import SettingsShell from "@rapidmx/web-client/shared/components/settings/layout/SettingsShell.js";
```

`@rapidmx/web-client/shared/styles/app.css` is the Tailwind entry point and design tokens.

## Navigation without page loads

`@rapidrest/react` has no router: every page is a server-rendered document that hydrates only its own page component. The
`www` pages (Mail, Calendar, Contacts, Tasks, Settings and their subpages) therefore render a small client-side router
themselves, and go between one another - and between the folders of Mail - without a page load:

- each `apps/www` page's default export is `routedPage("/its/route", Page)` (`apps/www/_routedPage.tsx`). The server
  renders and the browser hydrates exactly what it did before; the first load is unchanged. `apps/www/_routes.ts` lists the
  pages, each with a dynamic `import()` so it is a chunk of its own (a test keeps it in step with the files);
- one `AppShell` chrome (the app rail, header, user menu, impersonation banner, compose windows in progress, the unlock
  prompt and the idle-key timer) stays mounted, and only the page inside it is replaced. A page's own shell
  (`MailShell`, `CalendarShell`, ...) still renders `AppShell`; inside the router that is only its children;
- **links stay ordinary links.** Every same-origin `<a href>` to a route in the table is taken over - plain left clicks
  only, so ctrl/cmd/shift/middle click, `target`, `download`, `#hash` links and links marked `data-full-reload` keep
  the browser's behaviour, and pages that are not in the table (the admin and escrow consoles, plugin pages, other sites) are
  reached with a page load. The address bar always holds the real, shareable URL (`/?mailboxUid=&folderUid=`), and back and
  forward work;
- a page's code is fetched when the pointer, focus or a press reaches a link to it, and for the app rail's pages when the
  browser is idle after load (not with data saving on); if it can't be loaded the router falls back to a page load;
- after a page change focus moves to the content region (`#app-content`), the window scrolls to the top, `document.title`
  follows the page and a polite live region announces it.

Code that decides where to go uses the two hooks in `shared/navigation/AppRouter.js`:

```tsx
import { useLocation, useNavigate } from "@rapidmx/web-client/shared/navigation/AppRouter.js";

const navigate = useNavigate(); // navigate("/contacts"), navigate("/?mailboxUid=a&folderUid=b", { replace: true })
const { pathname, search, hash } = useLocation(); // empty until read after the first render, so server and browser agree
```

`navigate()` changes the page without a load when the URL is a route of the app and is an ordinary navigation otherwise
(outside the router too, where it is `window.location.href = ...`). Page props are the same for every `www` page except
`params`, which the router recomputes from the URL. Plugin pages are not part of the router (they render their own
`AppShell` chrome) and are opened with a page load.

The compose window, the reading pane, S/MIME and the emoji list are also chunks of their own, loaded on demand or fetched
when the browser is idle, so a page's first JavaScript is React and what the first screen draws.

## Keyboard shortcuts

One keyboard layer, `shared/keyboard/`, lives in the persistent app frame (`AppChrome`), so the shortcuts work in every view -
Mail, Calendar, Contacts, Tasks and Settings - and a page change only changes which of them are registered. `?` (or `Ctrl+/`)
opens a "Keyboard shortcuts" dialog, also reached from the account menu, that lists what is available *here* - the global
shortcuts plus those of the view on screen (and of an open compose window) - with the platform's own key names. `mod` below is
**Ctrl** on Windows and Linux and **Cmd** on a Mac; the navigation set is Ctrl+Shift on every platform (Cmd+Shift collides with the
browsers' own, so it is not offered).

| Where | Key | Does |
| --- | --- | --- |
| Everywhere | `Ctrl+Shift+A` | Account (auth-server's account page; only offered when one is configured) |
| | `Ctrl+Shift+S` / `B` / `M` / `C` / `L` | Settings / Contacts / Mail / Calendar / To-Do |
| | `?` or `Ctrl+/` | Keyboard shortcuts |
| Mail | `Alt+N` | New message |
| | `mod+R` / `mod+Shift+R` / `mod+Shift+F` | Reply / Reply all / Forward the selected message |
| | `mod+D` or `Delete` | Delete the selected message or conversation (moves it to Deleted Items) |
| | `E` or `Backspace` | Archive |
| | `mod+Shift+V` | Move to folder |
| | `Ctrl+Q` / `mod+U` | Mark as read / unread (`Ctrl+Q` on a Mac too: `Cmd+Q` quits) |
| | `Insert` | Flag or unflag |
| | `Down` or `J` / `Up` or `K` | Next / previous message (conversation) |
| | `Ctrl+.` / `Ctrl+,` | Next / previous unread |
| | `Enter` / `Escape` | Open the selected message on its own page / clear the selection (leave select mode, clear the search) |
| | `/` or `mod+E` | Search |
| Compose window | `mod+Enter` | Send |
| | `mod+S` | Save draft |
| | `Escape` | Close, keeping the draft (the existing "keep draft / discard" question still applies) |
| | `Alt+N` | Another new message |
| Calendar | `Alt+N` | New event |
| | `T` | Today |
| | `Left` / `Right` (or `mod+Left` / `mod+Right`) | Previous / next period |
| | `Ctrl+Alt+1` / `2` / `3` / `4` | Day / work week / week / month |
| Contacts | `Alt+N` | New contact |
| | `/` or `mod+E` | Search |
| Tasks | `Alt+N` | New task (moves to the "Add a task" field) |

In the desktop client (`@rapidmx/electron-client`, which exposes `window.rapidmx`) `Ctrl+N` (`Cmd+N` on a Mac) also creates - a new
message, event, contact or task in the current view - and `Ctrl+Shift+T` also goes to Tasks; browsers keep both for themselves, which is
why the web client uses `Alt+N` and `Ctrl+Shift+L`.

How it behaves:

- **Views register only what they can do.** A view claims a shortcut with `useShortcut(SHORTCUTS.mail.reply, handler, { enabled })`
  for as long as it is mounted and able to do it (Reply exists only while a message is selected, Archive not for Drafts or Outbox),
  so there are no dead keys and the help dialog is always accurate. `SHORTCUTS` in `shared/keyboard/keymap.js` is the one key map;
  handlers are looked up when the key is pressed. A handler that returns `false` declines the key.
- **Scopes.** `global`, the view's own (`mail`, `calendar`, `contacts`, `tasks`), `compose` (while focus is inside a compose window; it
  beats the view behind it) and `dialog`: while a modal dialog (`aria-modal`) is open only its own shortcuts and its own Escape work.
- **Typing is never taken.** Bare keys (`J`, `E`, `?`, `Delete`) do nothing while focus is in a text field, select or the rich-text
  editor, and caret keys with a modifier (word jumps) stay the field's. Chords with Ctrl/Alt/Cmd work from a field, except Option on
  a Mac and Ctrl+Alt (AltGr) elsewhere, which type characters. Copy, Cut, Paste, Select all, Undo, Redo and Find are never
  bound. Enter and Space are left to a focused button or link, and an open menu keeps its own keys. Events already
  `defaultPrevented` (the editor's own bindings, a menu), IME composition and held-key repeats of one-shot actions are ignored, and
  the browser's default is prevented only when a handler actually ran.
- **Layouts.** A key is matched on `event.key` (so it follows AZERTY or Dvorak) with `event.code` as the fallback when `event.key` is
  not a Latin character - macOS Option+N, or a Cyrillic layout.
- **Hints.** Buttons that a shortcut also does carry `aria-keyshortcuts` and a tooltip such as "Reply (Ctrl+R)"; their accessible
  names are unchanged (`useShortcutProps()` gives a control both).

Known limits: a browser keeps a few keys for itself (`Ctrl+N`, `Ctrl+T`, `Ctrl+W` are never delivered to a page, and some browsers claim
`Ctrl+Shift+A/B/C/M/S`); a message body is shown in a frame of its own, which hands the keys pressed in it on to the layer, so they work there too. In the compose body the editor's own bindings win over `Ctrl+Shift+S`, `B`
and `L` (strike-through, quote, align left).

## The reading pane

`shared/components/mail/` draws a message as a **card** and a conversation as a stack of them, under a **subject card** that stays pinned at the top
while the cards scroll (`MessageDetailPane`, `ConversationThreadPane`, and `reading/` for the pieces):

- **Subject card** - the conversation's (or the message's) subject as the page's `h1`, "N messages", a note when a very long thread was cut. In a
  thread it is on screen at once, from what the list row already knows, with a skeleton card per message (up to three) until the messages arrive.
- **Message card** - rounded, bordered and lifted, in the app's own tokens (`bg-surface`, `text-text`, `border-border`), so it follows the theme, a
  branding palette and the Appearance colours. A header row with the sender's initials, `Name <address>`, To/Cc/Bcc, the time and the actions (Reply,
  Reply All, Forward, Archive, Move to, Labels, and "View original" when it applies); the security badge and every notice (signature, key change,
  receipts, Outbox state); attachments; the body; a slim "You replied to this message." bar; and, on a single message and on the newest open one in a
  thread, Reply and Forward at its foot. An older message of a thread is a collapsed card (sender, date, first line) that expands on click or Enter
  (`aria-expanded`, `aria-controls`; the focus stays on the message's header button as it swaps between the two states).
- **Each card is exactly as tall as its message.** The body is shown at its natural height - no inner scrollbar, no dead space, no fixed height - and
  follows it as images load and the width changes. A table or image wider than the card scrolls **inside** the card and never widens the pane. The
  pane scrolls as a whole. Everything is on screen before the body: the header card, the message card's header and a skeleton where the body will be.

- **Encrypted messages** are themed card content in the same place as the body, never a frame: while the security state is being worked out, a skeleton;
  locked (no unlocked keys on this device), a lock, "This message is encrypted", "Unlock your keys to read it" and an **Unlock** button that asks for the unlock
  prompt and, once unlocked - by it or from anywhere - decrypts the message in place and moves the focus to it; unreadable with the keys in hand (not a recipient,
  damaged), "This message can’t be decrypted" with the reason and no button; decrypted, the message like any other. The placeholder subject `[...]` reads
  "Encrypted message", and list rows and collapsed cards with no preview say "Encrypted message" with a small lock.

**How a body is shown.** The server sanitizes a message's HTML when it ingests it (`GET /mail/messages/:id/content`); the client then treats what it
receives - and everything it recovers by decrypting or verifying, which the server never saw - as hostile. It is sanitized again with DOMPurify (scripts,
event handlers, `javascript:` URLs, every remote resource), stripped of forms, frames, media, plug-ins, SVG's active elements and every link that is not
`http(s)`/`mailto`/`tel`, and shown in a **sandboxed iframe without `allow-scripts`**, behind a Content-Security-Policy that allows no script, object, frame,
form or fetch (images are `data:` URIs and this server's own attachment URLs for inline `cid:` images; **remote images are never loaded**). `allow-same-origin`
is what lets the app measure the frame and adapt its colours, and it is safe only because nothing can run there: any one of the four layers (server
sanitizer, client sanitizer, CSP, sandbox) stops a script on its own - see `.claude/NOTES.md`, 2026-09-21, for the threat model and the hostile-mail corpus it
was tried against. Every link opens in a new tab without an opener. A message over 1.5 MB of markup or 20,000 elements is offered on its own page instead.

**Mail takes the theme.** A message follows the app's scheme wherever its author left the colours to the reader, and is shown as authored where the
author chose them. Plain-text mail and HTML with no colours at all (a typed reply) are drawn in the theme's surface and text colours, links in its link
colour. Where the HTML sets a colour: text on the theme's surface is kept if it reads (4.5:1) and adapted if it doesn't (black becomes white in a dark
theme, white becomes dark in a light one, a low-contrast navy is only lightened as far as it takes); anything on an authored, opaque background - a white table,
a banner, a gradient - is shown exactly as authored, except text nobody coloured, which gets black or white by contrast with that background, never the theme's
colour. A message that declares its own dark styles (a `color-scheme` meta or property, or a `prefers-color-scheme: dark` block) gets them when the theme is
dark. "View original" (the sun, in the card's header; the moon then goes back) shows just that message exactly as authored for the rest of the session; it is
offered only where adapting changes something. Known limits: a dark logo or PNG with a transparent background on a dark theme, text baked into images,
`mix-blend-mode` and SVG paint are left as they are.

Printing puts a message back to the colours it was written with for the print and adapts it again afterwards; the actions and the footer are not printed.

## Notifications, sending and the Outbox

**One pop-up system** (`shared/notifications/`). `AppChrome` mounts `NotificationCenter` once, right under the header row (a zero-height `sticky`
line that sticks just below the header - the title bar's or a branding header's height, published as `--rr-header-h` - so the stack starts below the
account menu and never covers it, the header's buttons or a compose window's title bar and Send button; its height is capped by `--rr-compose-top`), and
everything the app has to say goes through the framework-free store:

```ts
import { notify, update, dismiss } from "@rapidmx/web-client/shared/notifications/store.js";
import { notifyApiError } from "@rapidmx/web-client/shared/notifications/apiErrors.js";

const id = notify({ kind: "error", title: "Couldn't archive the message", message: "The server said no.",
                    details: ["Status: 502 (api-1)"], actions: [{ label: "Retry", onClick: retry }], dedupeKey: "archive" });
update(id, { kind: "success", title: "Archived", actions: [] });   // resolve it
try { await archive(); } catch (err) { notifyApiError(err, "Couldn't archive the message"); }
```

`kind` is `mail`, `info`, `success`, `warning` or `error`. At most three show at once (the rest queue); errors and anything with `actions` are sticky
until dismissed or resolved by `update()`/`dismiss()`, the others go after 5 to 10 seconds - clocks pause on hover, focus and a hidden tab; a repeated
`dedupeKey` is one pop-up with a count; errors are announced assertively (`role="alert"` inside an `aria-live="assertive"` region), the rest politely;
`details` is an expandable, monospace, copyable block. The last 30 (not new-mail ones) are kept in memory and `sessionStorage` and listed by "Recent
notifications" in the account menu. `notifyApiError()` turns an `ApiRequestError` into an error pop-up with the server's message (a `401` becomes
"Your session expired" with a Sign in button, anywhere in the app: the frame registers `setApiUnauthorizedObserver()`). The frame also catches unhandled
errors and rejections as one "Something went wrong", and says so, subtly, when the live connection has been down for more than ten seconds.

**Sending does not wait** (`shared/mail/outbox/`). Send validates what it can from what the window knows (a recipient, keys that must be unlocked, an
attachment that can't be signed - shown inline, the window stays open; an attachment still uploading is waited for), then closes the window at once and
hands a snapshot to `startSend()`: save, sign or encrypt in the browser if that applies, then `POST /mail/messages/:id/send` with `{ "background": true }`,
which answers `202 { status: "queued", message }` and relays in the background. Failures at any stage are a sticky "This message wasn't sent" with the
reason, technical details, **Retry** and **Open draft**; the server's later outcome arrives as `send-succeeded` / `send-retrying` / `send-failed` push
events. The Outbox row in the folder list is a pill with the count (optimistic at the click, then the server's), animated while anything is on its way and
red while one failed; rows in the Outbox list say what each message is doing.

**Encryption fails open.** A message is treated as unencrypted - its draft saves, Close and Send work, nothing about encryption is shown - unless you turned
encryption on (or replied to an encrypted message) or the encryption policy *was loaded* and encrypts for every recipient; a request that failed, is slow or
is pending never blocks anything (`compose/encryptionRequirement.ts`).

## The header, the footer and their variables

The admin console's Branding page sets a **header** and a **footer** as HTML. The server sanitizes them when they are saved and this client
sanitizes them again when it shows them: no scripts, styles, forms, inputs or SVG, no `on*` handlers, only `http`, `https` and `mailto` links.

**A custom header is the top of the app.** When one is set it replaces the app's own title bar (the app's name and the account menu) and the icon
at the top of the icon rail: the rail then starts with the app icons, and the header stays at the top of the window while a page scrolls. The
account menu moves into it. Two variables can be written in the *text* of the header or the footer:

| Variable | Replaced with |
| --- | --- |
| `{USER_MENU}` | The account menu: the avatar button and its drop-down (Account, Settings, notifications, keyboard shortcuts, Admin Console, Sign Out). |
| `{APP_TITLE}` | The name of the app on screen ("Mail", "Calendar", "Contacts", "Tasks", "Settings"), kept current as you move between apps without a page load. |

```html
<div style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem 1rem">
    <span>{APP_TITLE}</span>
    <span>{USER_MENU}</span>
</div>
```

- A variable is matched exactly - upper case, in braces, no spaces - and only in text. One in an attribute (`title="{USER_MENU}"`), a comment,
  a `<script>` or `<style>` is left as written or gone with them, and the author can't write the placeholders React fills in (`data-rr-slot` is
  stripped).
- `{USER_MENU}` is replaced **once**, where it first appears in the header; if the header has none, at its first place in the footer (the menu then
  opens upward); if neither has one, the menu sits in a small cell at the right end of the header, so the account menu, Sign Out and the shortcuts
  help are never lost. A second or third copy is removed (two menus would mean duplicate ids and focus targets), and so is one inside a link or in
  text that can't hold an element (`<title>`, `<textarea>`).
- `{APP_TITLE}` is replaced **everywhere** it appears, as text (never markup). It changes on client-side navigation, and works in the footer too.
- The menu is drawn into `<body>` with `position: fixed`, so a header with `overflow: hidden`, its own `z-index` or a stacking context can neither
  clip it nor hide it behind the page. It follows its button when the window resizes or scrolls, and fits a 390 px window.
- Put `{USER_MENU}` where your CSS doesn't hide it: a header whose stylesheet hides its `<nav>` on phones should keep the variable outside the nav.
- Focus order is document order: the menu button is reached after the text before it and before what follows it.
- Pages that don't use a shell (the booking pages) render `BrandingHeader` and `BrandingFooter`, which have no menu: `{USER_MENU}` renders nothing
  there and `{APP_TITLE}` is the `appTitle` prop, if any. The variable names are `USER_MENU_VARIABLE` and `APP_TITLE_VARIABLE` in
  `shared/components/layout/BrandingChrome.js`.

The frame draws the header from the `branding` prop the server rendered the page with (`useBranding()`'s own fetch takes over when it answers), so
the frame is the right shape - no title bar, no rail icon - from the first paint, and the icon of a frame without a custom header sits flush with the
top of the window (`RailIcon`: it is measured on a canvas and raised by whatever empty margin the image file has above its artwork).

## Appearance

**Settings > Appearance** (`/settings/appearance`) lets each user choose the colour scheme (System, Light or Dark), four theme colours (primary,
accent, surface and text - each a colour picker with a hex field and its own "Reset"), and a background (none, a colour, or an uploaded picture with
dim 0-80%, blur 0-20 px and fit cover, contain or tile). Every change is applied to the real app in the same frame - the page you are on is the preview -
and saved in the background (coalesced, only what changed); a save that fails puts the change back and says so. A picture is checked before it is
uploaded (PNG, JPEG, WebP or AVIF, up to 8 MB). Text on the surface, and text on an accent button, under 4.5:1 contrast gets a warning, never a block.
"Reset all" returns everything to the defaults and removes the picture.

**How it reaches the app.** `AppearanceProvider` (mounted by `AppChrome`, `AdminShell` and `EscrowShell`) owns the preferences and writes one
`<style id="rr-appearance">` into `<head>` (`appearance/theme.js`), sets `<html data-theme="light|dark">` (for System, the operating system's scheme,
live) and remembers the result in `localStorage` (`rapidmx-appearance`). The server's `_layout.tsx` renders the same stylesheet from the `appearance`
page prop and a tiny inline script (`APPEARANCE_BOOT_SCRIPT`) applies the browser's copy before the first paint, so there is no flash on a load and none
on a client-side navigation. The server caches a rendered page for up to a minute, so whichever copy - the page's or the browser's - was changed last wins,
and the server is asked once the page is up.

- **Precedence:** the app's defaults < the deployment's branding stylesheet < the user's choices. A user's colours are `--rr-color-*` custom properties
  declared `!important` on `<html>`, so no branding rule can beat them; the branding stylesheet's own rules (say a header's background) still decide their
  own elements, exactly as before. Only the colours a user chose are set: primary and accent get their full scales (darker and lighter steps mixed from the
  one colour) and readable text colours, surface and text get their alt, border and muted derivatives.
- **The background** is two fixed pseudo-elements of `<html>` (`::before` the picture or colour, `::after` the dim, the scheme's surface colour at the
  chosen opacity), behind everything, with no markup, no layout shift and nothing to repaint while a list scrolls. With a background set the icon rail, the
  header and the content region become translucent panels (`--color-surface` and `--color-surface-alt` are the surface colour at an alpha, chosen so text
  and muted text stay at least 4.5:1 against the worst place the picture can be - the picture's lightest and darkest twentieth, measured on a canvas -
  more see-through for a plain photo or a high dim, more opaque for a busy one); menus, dialogs, drawers and pop-ups take the opaque colours back. Without a
  background nothing changes.
- **Hooks:** `useResolvedTheme()` (`appearance/resolvedTheme.js`) is `"light"` or `"dark"`, live, needing no provider; `useAppearance()` gives
  `{ prefs, resolved, setPrefs(patch), uploadBackground(file), removeBackground(), reset(), saving, error, ... }`.
- **API** (`@rapidmx/react-shared/appearance/preferencesApi.js`): `GET/PUT /mail/preferences/appearance` (a merge), `POST/DELETE
  /mail/preferences/appearance/background`, `GET .../background/:version`; a change is also pushed as `AppearancePreferences...` `update` events on
  the user's own uid channel.

## Toolbars, folders and the signing certificate

**Toolbars that fit (`components/layout/ResponsiveToolbar.tsx`).** A bar measures its own width (`ResizeObserver`) and lays itself out from a table of actions (`ToolbarAction`: label,
icon, group, `rank` - the lowest goes into "More" first - and `essential`): captions under the icons while everything fits; else icons only (each keeps a tooltip and, for New contact, its
shortcut's `title` and `aria-keyshortcuts`); else as many icons as fit and the rest in a portalled `role="menu"` behind a **More** button. `layoutToolbar(actions, width)` is the pure
function behind it (`width === undefined` - server render, no ResizeObserver - shows everything), and the bar is `overflow-x-clip` so it can never paint over the pane beside it. Contacts
uses it; the panes around it follow one rule: a list column of `clamp(16rem, 32vw, 26rem)`, a detail pane that keeps the rest, each column scrolling by itself (`md:h-[calc(100dvh - var(--rr-header-h))]` on the
page root - the frame's own height is open-ended), the side menu a drawer below `lg`, and no empty shell column for a single mailbox.

**The folder tree (`mail/folderTree.ts`).** `FOLDER_ORDER` (Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk, Archive, then custom), `upsertFolder()`, `removeFolder()` and
`reconcileFolders()` return the same array when nothing changed (everything that reads the tree starts over when it is a new one), never touch the counts (the overlay in `folderCounts.ts`
owns them) and never remove on a listing (deletions arrive as events). `useMailConnection()` files what `Folder` create / update / delete events say and what every counts read-back lists
(`useFolderCounts(mailboxes, folders, onFoldersListed)`), so a folder is found by an event, a message in it, a send outcome, the poll, a focus or a reconnect, whichever comes first. `folderRows()`
is the one place a folder that has not arrived is drawn - a muted Outbox / Sent Items placeholder while a message is on its way - so it can never be drawn twice. Push channels are ordered inboxes,
mailbox uids, then the other folders in sidebar order (`pushChannelsFor()`).

**The signing certificate (`signing/`).** `enrollmentTracker.ts` follows one enrollment per mailbox for everybody who wants to show or react to it: a first read, then 15 s, 30 s and every 60 s
while pending - only while the page is visible (a hidden tab asks nothing; coming back or a focus asks at once and restarts the backoff), stopping when it ends; `checkEnrollmentNow()` is the
"Check status" (a 10 s cooldown, the server's 429 honoured, a plain read on a server without the check endpoint); a pending enrollment stays followed after the page that started it is left.
`useSigningEnrollmentWatcher()` (in `AppChrome`) seeds it for the mailboxes you own and raises the "issued" / "failed" pop-up. `enrollmentView.ts` holds the wording, the steps, the percentage
and the expiry maths; `SigningCertificateCard` draws them. The account menu's **Theme** row is `ThemeSwitch`, over `useAppearance().setPrefs({ mode })`.

## Plugin UI surface

Server plugins can ship their own pages (see the plugin manifest's `ui` field in `@rapidmx/restapi`). The server builds
them together with this package, so they share one React, one `@rapidmx/react-shared` state and one stylesheet. The
modules below are the **supported surface for plugin pages**. Anything else under `apps/` is internal and may change in
any release.

### Shells

| Import | Use |
| --- | --- |
| `shared/components/layout/AppShell.js` | Chrome for webmail apps: app rail, header, user menu, impersonation banner, compose and unlock providers. `active` is a core app or the plugin's `appRail` item id. The user menu shows an "Admin Console" item to an administrator even when their session isn't elevated (it asks auth-server for the user's own roles, using the `trustedRoles` page prop) and, in Mail, the new-mail pop-up switch. |
| `shared/components/settings/layout/SettingsShell.js` | Settings chrome with the section list and mailbox switcher. `active` is the plugin's `settingsSections` item id. `useSettingsShell()` gives the selected `mailboxUid` and the accessible `mailboxes`. |
| `shared/components/admin/layout/AdminShell.js` | Admin console chrome, gated on administrator access - an administrator whose session isn't elevated is sent to auth-server's `/auth/elevate` page and returned. `active` is the plugin's `adminNav` item id. |
| `shared/components/layout/BrandingChrome.js` | `BrandingHeader` and `BrandingFooter`, for pages that don't use a shell, such as public pages. |
| `shared/plugins/pluginNav.js` | The `PluginNav`, `PluginUiNavItem` and `PluginNavProps` types. |

Every www and admin page receives a `pluginNav` prop from the server. It lists the settings sections, admin sections and
app rail entries of every enabled plugin whose UI built. The shells append those entries after their own, with a generic
icon. An entry whose id matches a core entry is skipped, and so is one whose `href` isn't a same-origin path. Pass the
page props straight to the shell so the navigation shows:

```tsx
import React from "react";
import SettingsShell, {
    SettingsShellProps,
    useSettingsShell,
} from "@rapidmx/web-client/shared/components/settings/layout/SettingsShell.js";

export default function RemindersSettingsPage(props: Omit<SettingsShellProps, "active">) {
    return (
        <SettingsShell {...props} active="reminders">
            <RemindersSettings />
        </SettingsShell>
    );
}

function RemindersSettings() {
    const { mailboxUid } = useSettingsShell();
    return <p>Settings for {mailboxUid}</p>;
}
```

Public and escrow pages get no `pluginNav`.

### From `@rapidmx/react-shared`

Plugin pages import these directly from `@rapidmx/react-shared`, which the server resolves to the same copy the shells
use:

- `branding/useBranding.js`: `useBranding()`, for the branding and icon of pages outside a shell;
- `auth/session.js`: `useRedirectIfUnauthenticated()`, already called by every shell;
- `util/api.js`: `apiFetch()` and `ApiRequestError`, for calling the plugin's own API routes;
- `mail/mailApi.js`: mailboxes and folders, such as `listMailboxes()` and `listFolders()`;
- `components/buttons/Button.js`, `components/feedback/Alert.js` and `components/feedback/Skeleton.js`;
- `components/forms/FormField.js`;
- `components/overlays/Modal.js` and `components/overlays/Drawer.js`;
- `components/pickers/MiniDatePicker.js`.

## Uninstalling a plugin with its data

The admin console's Plugins page (`PluginsManager`, also embedded in the setup wizard) uninstalls a plugin through a dialog with an unchecked **Also delete all data this plugin stored** box. Ticking it lists what will be deleted (collections and tables, saved settings, cached package and pages, whatever the plugin cleans up itself), says **This can't be undone**, turns the confirm button into the red **Uninstall and delete data** and keeps it disabled until the plugin's display name is typed (case and surrounding spaces ignored). The dialog is a `Modal` (focus moves in and stays in, Escape closes, the checkbox is described by the list) and a `<form>`, so Enter in the name field confirms once it matches; at 390 px it keeps the modal's 20 px gutters and the list wraps.

The request is `removePlugin(uid, { purgeData: true })` (`@rapidmx/react-shared/admin/pluginsApi.js`); the server accepts it only from an elevated administrator, and an `api-104` answer is shown as a request to reload or sign in again. Deletion happens on the servers after the last copy stops running the plugin, so `GET /api/system/plugins/status` carries each deletion as `purges` and the page lists the uninstalled plugin with its state - *Uninstalled - data will be deleted after servers restart* (and how many servers still run it), *Data deleted <date>*, or *Data deletion failed: <reason>* with the failed steps and a Retry button. It reads the status every 5 seconds while a deletion is waiting or running, and raises an `apps/shared/notifications` pop-up when one that was under way is deleted or fails, and a warning when adding a plugin cancels one. A plugin that is installed is never shown as uninstalled, whatever the server still lists about an earlier deletion.

## Development

```sh
yarn install
yarn test        # vitest with coverage gates
yarn lint
yarn build       # tsc into dist/apps
```
