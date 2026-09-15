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

## Plugin UI surface

Server plugins can ship their own pages (see the plugin manifest's `ui` field in `@rapidmx/restapi`). The server builds
them together with this package, so they share one React, one `@rapidmx/react-shared` state and one stylesheet. The
modules below are the **supported surface for plugin pages**. Anything else under `apps/` is internal and may change in
any release.

### Shells

| Import | Use |
| --- | --- |
| `shared/components/layout/AppShell.js` | Chrome for webmail apps: app rail, header, user menu, impersonation banner, compose and unlock providers. `active` is a core app or the plugin's `appRail` item id. |
| `shared/components/settings/layout/SettingsShell.js` | Settings chrome with the section list and mailbox switcher. `active` is the plugin's `settingsSections` item id. `useSettingsShell()` gives the selected `mailboxUid` and the accessible `mailboxes`. |
| `shared/components/admin/layout/AdminShell.js` | Admin console chrome, gated on administrator access. `active` is the plugin's `adminNav` item id. |
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
