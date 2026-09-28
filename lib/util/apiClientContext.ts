///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Lets a deeply-nested component reach "the active account's `ApiClient`" without prop-drilling it through
 * every layer in between — the missing piece `createApiClient()` (see `api.ts`) left open: that function
 * gives a host app (e.g. the native, multi-account `tauri-client`) a way to *build* a per-account client, but
 * nothing let a component *read* one back out short of threading it through every prop list by hand.
 *
 * Same shape as `overlays/overlayStack.ts`'s `OverlayDepthContext` — a bare `createContext()` plus a `useX()`
 * reader, no dedicated `<Provider>` wrapper component, so a host app wraps its tree in `ApiClientContext.Provider`
 * directly (e.g. `<ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>`) exactly the
 * way `Modal.tsx`/`Drawer.tsx` already do for `OverlayDepthContext`.
 *
 * The default value is `undefined`, meaning "no override" — every existing consumer (the SSR web/admin apps,
 * the Electron client) renders with no `ApiClientContext.Provider` anywhere above it, so `useApiClient()` there
 * always returns `undefined`, which is exactly what every converted REST function's own `client?: ApiClient`
 * parameter already treats as "use the default global cookie-based `apiFetch()` path" (see `withClient()`'s doc
 * comment in `api.ts`). A component under a `tauri-client`-style provider instead gets that account's own
 * `ApiClient` back, and can pass it straight through as the trailing `client` argument of any converted
 * function with no adapter needed: `const client = useApiClient(); await listMessages(params, client);`.
 */
import { createContext, useContext } from "react";
import { ApiClient } from "./api.js";

/** The active account's `ApiClient`, or `undefined` when nothing above the caller provided one — see this
 * file's own doc comment. */
export const ApiClientContext = createContext<ApiClient | undefined>(undefined);

/** The nearest `ApiClientContext.Provider`'s value, or `undefined` when there is none — the same `client`
 * every converted REST function's own optional trailing parameter accepts. */
export function useApiClient(): ApiClient | undefined {
    return useContext(ApiClientContext);
}
