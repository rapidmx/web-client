///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "../../../styles/app.css";
import React, { PropsWithChildren, ReactNode, useEffect, useState } from "react";
import {
    HiOutlineClipboardDocumentList,
    HiOutlineClock,
    HiOutlineDocumentArrowDown,
    HiOutlineDocumentCheck,
    HiOutlineGlobeAlt,
    HiOutlineInboxStack,
    HiOutlineKey,
    HiOutlineLockClosed,
    HiOutlinePaintBrush,
    HiOutlinePuzzlePiece,
    HiOutlineQueueList,
    HiOutlineRocketLaunch,
    HiOutlineShieldCheck,
    HiOutlineShieldExclamation,
    HiOutlineUserGroup,
    HiOutlineWrenchScrewdriver,
    HiOutlineBars3,
} from "react-icons/hi2";
import { apiFetch, ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { getSetupStatus } from "@rapidmx/react-shared/admin/setupApi.js";
import { useRedirectIfUnauthenticated } from "@rapidmx/react-shared/auth/session.js";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Drawer from "@rapidmx/react-shared/components/overlays/Drawer.js";
import type { NavItem } from "@rapidmx/react-shared/components/navigation/BottomTabBar.js";
import { FrameBrandingFooter, useBrandingHtml } from "../../layout/BrandingChrome.js";
import RailIcon from "../../layout/RailIcon.js";
import AppearanceProvider from "../../../appearance/AppearanceProvider.js";
import UserMenu from "../../layout/UserMenu.js";
import {
    clearElevationAttempt,
    elevationAttemptedRecently,
    elevationUrl,
    isElevationRequired,
    recordElevationAttempt,
} from "../elevation.js";
import { signOutOfConsole } from "../signOut.js";
import { mergePluginNavItems, PluginNav, PluginNavProps } from "../../../plugins/pluginNav.js";

export type AdminSection =
    | "mailboxes"
    | "quarantine"
    | "ingestQueue"
    | "domains"
    | "auditLog"
    | "distributionLists"
    | "transportRules"
    | "escrowScopes"
    | "retentionPolicy"
    | "encryptionPolicy"
    | "mailboxPolicy"
    | "setup"
    | "dataRequests"
    | "plugins"
    | "branding"
    | "signingCertificates";

/** A core `AdminSection`, or a plugin's `adminNav` item id (see `PluginNav`). */
export type AdminShellActive = AdminSection | (string & {});

export interface AdminShellProps extends PluginNavProps {
    /** Which icon in the rail is highlighted as the current section - a plugin admin page passes its own
     * `adminNav` item id. */
    active: AdminShellActive;
    /** Populated automatically by the framework from an authenticated request (e.g. a valid `jwt` cookie). */
    userUid?: string;
    /** auth-server's base URL, injected via the route's `fetchProps` — see `src/mongo/routes/AdminConsoleRoute.ts`. */
    authServerUrl?: string;
    /**
     * Where `mailApi.ts`'s `impersonateUser()`/`stopImpersonating()` should call: the real auth-server in
     * production, or `""` under `yarn dev` to call this app's own local dev-only impersonation endpoint
     * instead — see `AdminConsoleRoute`'s `fetchProps` and `src/dev/DevImpersonationRoute.ts`.
     */
    impersonationBaseUrl?: string;
}

/** `elevating`: the browser is being sent to auth-server to confirm the user's identity. `elevationFailed`: it was
 * sent a moment ago and the console still isn't elevated - see `elevation.ts`. */
type Status = "checking" | "denied" | "elevating" | "elevationFailed" | "error" | "authorized";

/** Sections shown in the persistent icon rail / mobile tab bar — every admin area reachable from
 * anywhere in the console. Deliberately excludes `quarantine`/`ingestQueue`: those are scoped to a
 * single mailbox and only ever reached via links on that mailbox's own detail page (see
 * `apps/admin/mailboxes/[uid].tsx`), not global navigation destinations. */
const NAV_ITEMS: NavItem[] = [
    { id: "mailboxes", href: "/admin", label: "Mailboxes", icon: HiOutlineInboxStack },
    { id: "domains", href: "/admin/domains", label: "Domains", icon: HiOutlineGlobeAlt },
    { id: "auditLog", href: "/admin/audit-log", label: "Audit Log", icon: HiOutlineClipboardDocumentList },
    {
        id: "distributionLists",
        href: "/admin/distribution-lists",
        label: "Distribution Lists",
        icon: HiOutlineUserGroup,
    },
    {
        id: "transportRules",
        href: "/admin/transport-rules",
        label: "Transport Rules",
        icon: HiOutlineShieldCheck,
    },
    {
        id: "escrowScopes",
        href: "/admin/escrow-scopes",
        label: "Escrow Scopes",
        icon: HiOutlineKey,
    },
    {
        id: "encryptionPolicy",
        href: "/admin/encryption-policy",
        label: "Encryption Policy",
        icon: HiOutlineLockClosed,
    },
    {
        id: "mailboxPolicy",
        href: "/admin/mailbox-policy",
        label: "Mailbox Policy",
        icon: HiOutlineWrenchScrewdriver,
    },
    {
        id: "retentionPolicy",
        href: "/admin/retention-policy",
        label: "Retention Policy",
        icon: HiOutlineClock,
    },
    {
        id: "dataRequests",
        href: "/admin/data-requests",
        label: "Data Requests",
        icon: HiOutlineDocumentArrowDown,
    },
    {
        id: "signingCertificates",
        href: "/admin/signing-certificates",
        label: "Signing Certificates",
        icon: HiOutlineDocumentCheck,
    },
    { id: "plugins", href: "/admin/plugins", label: "Plugins", icon: HiOutlinePuzzlePiece },
    { id: "branding", href: "/admin/branding", label: "Branding", icon: HiOutlinePaintBrush },
];

/** Mailbox-scoped sections — not part of the global nav rail/tab bar (see `NAV_ITEMS` above), but
 * still need an entry here so the header can resolve a label for them when they're the active page. */
const MAILBOX_SCOPED_ITEMS: NavItem[] = [
    { id: "quarantine", href: "/admin/quarantine", label: "Quarantine", icon: HiOutlineShieldExclamation },
    { id: "ingestQueue", href: "/admin/ingest-queue", label: "Ingest Queue", icon: HiOutlineQueueList },
];

/** The setup wizard - reached by redirect or from the Mailboxes page, not from the rail. */
const SETUP_ITEM: NavItem = { id: "setup", href: "/admin/setup", label: "Setup", icon: HiOutlineRocketLaunch };

const OFF_RAIL_ITEMS: NavItem[] = [...MAILBOX_SCOPED_ITEMS, SETUP_ITEM];

/** `NAV_ITEMS` followed by the plugins' `adminNav` items (generic icon). Core ids win, including the
 * off-rail sections' - see `mergePluginNavItems`. */
export function adminNavItems(pluginNav?: PluginNav): NavItem[] {
    return mergePluginNavItems<NavItem>(
        NAV_ITEMS,
        pluginNav?.adminNav,
        ({ id, href, label }) => ({ id, href, label, icon: HiOutlinePuzzlePiece }),
        OFF_RAIL_ITEMS.map((item) => item.id),
    );
}

/**
 * Gates every `apps/admin` page behind the `admin` trusted role, and behind an elevated session. Uses
 * `GET /api/admin/release-notes` (any `BaseAdminRoute` endpoint works — this one is side-effect-free) purely as a
 * canary. The endpoint is class-level `@RequiresElevation()`, checked *before* the trusted-role check, so a 200 means the
 * caller's JWT is elevated and carries a trusted role: show the console. Otherwise:
 *
 * 403 `api-104` means the JWT isn't elevated (an administrator's normal sign-in). There is no local step-up form; the
 * browser is sent to auth-server's `/auth/elevate?return_to=<this page>`, which returns it here once the user has
 * confirmed their identity (or to its own account page if they cancel). Sent at most once per
 * `ELEVATION_RETRY_WINDOW_MS`, so an elevated cookie that never reaches this origin can't bounce the browser back
 * and forth - see `elevation.ts`, and the "didn't take effect" alert with its own "Try again" below.
 *
 * 403 `api-103` (elevated, but not an administrator), any other 403, and 401 mean "no administrator access".
 */
export default function AdminShell({ active, userUid, authServerUrl, pluginNav, children }: PropsWithChildren<AdminShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    // `branding` only feeds the footer below: the admin-configured header is for the webmail and public pages, not the
    // console. `useBranding()` is still what injects the custom stylesheet and supplies the rail's icon.
    const { branding, iconSrc } = useBranding();
    const footer = useBrandingHtml(branding?.footerHtml);

    useRedirectIfUnauthenticated(userUid, authServerUrl);

    useEffect(() => {
        if (!userUid) {
            return;
        }
        apiFetch("/admin/release-notes")
            .then(async () => {
                // Elevated (or elevation isn't needed): a later expiry of the elevation may send the user round again.
                clearElevationAttempt();
                // Until first-run setup is finished, every other admin page sends the admin to the wizard. A failed
                // check never blocks the console - the admin can still reach setup from the Mailboxes page.
                if (active !== "setup") {
                    try {
                        if ((await getSetupStatus()).required) {
                            window.location.href = SETUP_ITEM.href;
                            return;
                        }
                    } catch {
                        // Fall through to the page.
                    }
                }
                setStatus("authorized");
            })
            .catch((err) => {
                if (isElevationRequired(err)) {
                    // Without auth-server's URL there is nowhere to send the browser to elevate.
                    if (!authServerUrl) {
                        setStatus("denied");
                    } else if (elevationAttemptedRecently()) {
                        setStatus("elevationFailed");
                    } else {
                        startElevation(authServerUrl);
                    }
                    return;
                }
                if (err instanceof ApiRequestError && (err.status === 403 || err.status === 401)) {
                    setStatus("denied");
                    return;
                }
                setError(err instanceof ApiRequestError ? err.message : "Could not verify administrator access.");
                setStatus("error");
            });
    }, [userUid]);

    /** Remembers the attempt, then sends the browser to auth-server to confirm the user's identity. */
    function startElevation(authServer: string) {
        recordElevationAttempt();
        setStatus("elevating");
        window.location.href = elevationUrl(authServer, window.location.href);
    }

    function handleRetryElevation() {
        clearElevationAttempt();
        startElevation(authServerUrl!);
    }

    function handleSignOut() {
        // Ends the auth-server session and tells other tabs, not just navigates - see `signOutOfConsole()`.
        void signOutOfConsole(authServerUrl);
    }

    let content: ReactNode;
    if (!userUid || status === "checking") {
        content = <div className="min-h-screen" />;
    } else if (status === "elevating") {
        content = (
            <div className="min-h-screen flex items-center justify-center p-8">
                <p role="status" className="text-sm text-text-muted">
                    Redirecting to confirm your identity&hellip;
                </p>
            </div>
        );
    } else if (status === "elevationFailed") {
        content = (
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="w-full max-w-md flex flex-col items-start">
                    <Alert>
                        Confirming your identity didn&rsquo;t take effect, so the administrator console is still locked. Try again,
                        and if this keeps happening, sign out and sign back in.
                    </Alert>
                    <Button type="button" className="!w-auto" onClick={handleRetryElevation}>
                        Try again
                    </Button>
                </div>
            </div>
        );
    } else if (status === "denied") {
        content = (
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="w-full max-w-md">
                    <Alert>You do not have administrator access.</Alert>
                </div>
            </div>
        );
    } else if (status === "error") {
        content = (
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="w-full max-w-md">
                    <Alert>{error}</Alert>
                </div>
            </div>
        );
    } else {
        const navItems = adminNavItems(pluginNav);
        const activeItem = [...navItems, ...OFF_RAIL_ITEMS].find((item) => item.id === active);
        content = (
            <div className="rr-frame-bg min-h-screen flex flex-col">
                <div className="flex-1 flex min-h-0">
                    <nav
                        aria-label="Admin sections"
                        className="hidden md:flex w-16 shrink-0 bg-surface border-r border-border flex-col items-center pb-3 gap-1"
                    >
                        <RailIcon src={iconSrc} />
                        {navItems.map(({ id, href, label, icon: Icon }) => (
                            <a
                                key={id}
                                href={href}
                                aria-label={label}
                                aria-current={id === active ? "page" : undefined}
                                title={label}
                                className={[
                                    "w-10 h-10 flex items-center justify-center rounded-sm",
                                    id === active
                                        ? "bg-primary/10 text-primary-dark"
                                        : "text-text-muted hover:bg-surface-alt hover:text-text",
                                ].join(" ")}
                            >
                                <Icon size={20} aria-hidden="true" />
                            </a>
                        ))}
                    </nav>
                    {/* Below `md` the sections are a menu that slides in from the left: ten or so of them don't fit a bar along the bottom. */}
                    <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Admin">
                        <nav aria-label="Admin menu" className="flex flex-col gap-1 -mx-2">
                            {navItems.map(({ id, href, label, icon: Icon }) => (
                                <a
                                    key={id}
                                    href={href}
                                    aria-current={id === active ? "page" : undefined}
                                    onClick={() => setMenuOpen(false)}
                                    className={[
                                        "flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm font-medium",
                                        id === active ? "bg-primary/10 text-primary-dark" : "text-text hover:bg-surface-alt",
                                    ].join(" ")}
                                >
                                    <Icon size={20} aria-hidden="true" />
                                    {label}
                                </a>
                            ))}
                        </nav>
                    </Drawer>
                    <div className="flex-1 flex flex-col min-w-0">
                        <header className="rr-solid sticky top-0 z-30 h-16 shrink-0 bg-surface border-b border-border flex items-center justify-between gap-4 px-4 md:px-6">
                            <div className="flex items-center gap-2 min-w-0">
                                <button
                                    type="button"
                                    className="md:hidden shrink-0 w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
                                    aria-label="Open menu"
                                    onClick={() => setMenuOpen(true)}
                                >
                                    <HiOutlineBars3 size={20} aria-hidden="true" />
                                </button>
                                <span className="font-display font-bold text-lg uppercase tracking-wide truncate">{activeItem?.label}</span>
                            </div>
                            <UserMenu userUid={userUid} authServerUrl={authServerUrl} onSignOut={handleSignOut} showMailLink />
                        </header>
                        <div id="app-content" className="flex-1">
                            <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // The user's own colours and background (`AppearanceProvider`), from what the last webmail page cached in this browser: the console never asks the server.
    return (
        <AppearanceProvider userUid={userUid} lookUp={false}>
            {content}
            <FrameBrandingFooter parsed={footer} appTitle={[...adminNavItems(pluginNav), ...OFF_RAIL_ITEMS].find((item) => item.id === active)?.label} />
        </AppearanceProvider>
    );
}
