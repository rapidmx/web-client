///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** auth-server's account page, or `undefined` when no auth-server is configured. Tolerates a configured URL with a trailing slash. */
export function accountUrlOf(authServerUrl: string | undefined): string | undefined {
    return authServerUrl ? `${authServerUrl.replace(/\/+$/, "")}/account` : undefined;
}
