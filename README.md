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
`Ctrl+Shift+A/B/C/M/S`); and a message body is shown in a sandboxed iframe, which forwards no key events, so after clicking into a
message body press Tab or click the list before using a shortcut. In the compose body the editor's own bindings win over `Ctrl+Shift+S`, `B`
and `L` (strike-through, quote, align left).

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

## Development

```sh
yarn install
yarn test        # vitest with coverage gates
yarn lint
yarn build       # tsc into dist/apps
```
