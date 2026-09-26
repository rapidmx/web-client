///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RouteDefinition } from "../shared/navigation/routes.js";

/**
 * Every `apps/www` page the client-side router can show without a page load (see `apps/shared/navigation/AppRouter.tsx`), in
 * the order they are matched: literal routes before the parameterized ones that would also match them. Each page loads with a
 * dynamic `import()`, which is what makes it a chunk of its own - only the page a document was rendered for is in its first
 * JavaScript. Keep it in step with the files under `apps/www`; a page missing from here still works, it is just reached with a
 * page load. (The file starts with `_` so `@rapidrest/react` doesn't treat it as a page.)
 *
 * The four app-rail pages are `idlePrefetch`ed: downloaded when the browser is idle after the first page has loaded.
 */
export const wwwRoutes: readonly RouteDefinition[] = [
    { path: "/", active: "mail", load: () => import("./index.js"), idlePrefetch: true },
    { path: "/messages/:uid", active: "mail", load: () => import("./messages/[uid].js") },
    { path: "/calendar", active: "calendar", load: () => import("./calendar/index.js"), idlePrefetch: true },
    { path: "/contacts", active: "contacts", load: () => import("./contacts/index.js"), idlePrefetch: true },
    { path: "/contacts/:uid", active: "contacts", load: () => import("./contacts/[uid].js") },
    { path: "/tasks", active: "tasks", load: () => import("./tasks/index.js"), idlePrefetch: true },
    { path: "/settings/appearance", active: "settings", load: () => import("./settings/appearance/index.js") },
    { path: "/settings/auto-reply", active: "settings", load: () => import("./settings/auto-reply/index.js") },
    { path: "/settings/blocked-senders", active: "settings", load: () => import("./settings/blocked-senders/index.js") },
    { path: "/settings/encryption", active: "settings", load: () => import("./settings/encryption/index.js") },
    { path: "/settings/filters", active: "settings", load: () => import("./settings/filters/index.js") },
    { path: "/settings/filters/new", active: "settings", load: () => import("./settings/filters/new/index.js") },
    { path: "/settings/filters/:uid", active: "settings", load: () => import("./settings/filters/[uid].js") },
    { path: "/settings/labels", active: "settings", load: () => import("./settings/labels/index.js") },
    { path: "/settings/privacy", active: "settings", load: () => import("./settings/privacy/index.js") },
    { path: "/settings/profile", active: "settings", load: () => import("./settings/profile/index.js") },
    { path: "/settings/read-receipts", active: "settings", load: () => import("./settings/read-receipts/index.js") },
    { path: "/settings/sharing", active: "settings", load: () => import("./settings/sharing/index.js") },
    { path: "/settings/signatures", active: "settings", load: () => import("./settings/signatures/index.js") },
    { path: "/settings/signatures/new", active: "settings", load: () => import("./settings/signatures/new/index.js") },
    { path: "/settings/signatures/:uid", active: "settings", load: () => import("./settings/signatures/[uid].js") },
];
