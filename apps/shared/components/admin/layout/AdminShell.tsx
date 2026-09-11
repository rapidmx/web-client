///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "../../../styles/app.css";
import React, { PropsWithChildren, ReactNode, useEffect, useState } from "react";
import {
    HiOutlineClipboardDocumentList,
    HiOutlineGlobeAlt,
    HiOutlineInboxStack,
    HiOutlinePaintBrush,
    HiOutlineQueueList,
    HiOutlineShieldCheck,
    HiOutlineShieldExclamation,
    HiOutlineUserGroup,
} from "react-icons/hi2";
import { apiFetch, ApiRequestError } from "@rapidmx/react-shared/api.js";
import { useRedirectIfUnauthenticated } from "@rapidmx/react-shared/session.js";
import useBranding from "@rapidmx/react-shared/useBranding.js";
import Alert from "../../feedback/Alert.js";
import BottomTabBar, { NavItem } from "../../layout/BottomTabBar.js";
import { BrandingFooter, BrandingHeader } from "../../layout/BrandingChrome.js";
import UserMenu from "../../layout/UserMenu.js";

export type AdminSection =
    | "mailboxes"
    | "quarantine"
    | "ingestQueue"
    | "domains"
    | "auditLog"
    | "distributionLists"
    | "transportRules"
    | "branding";

export interface AdminShellProps {
    /** Which icon in the rail is highlighted as the current section. */
    active: AdminSection;
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

type Status = "checking" | "denied" | "error" | "authorized";

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
    { id: "branding", href: "/admin/branding", label: "Branding", icon: HiOutlinePaintBrush },
];

/** Mailbox-scoped sections — not part of the global nav rail/tab bar (see `NAV_ITEMS` above), but
 * still need an entry here so the header can resolve a label for them when they're the active page. */
const MAILBOX_SCOPED_ITEMS: NavItem[] = [
    { id: "quarantine", href: "/admin/quarantine", label: "Quarantine", icon: HiOutlineShieldExclamation },
    { id: "ingestQueue", href: "/admin/ingest-queue", label: "Ingest Queue", icon: HiOutlineQueueList },
];

const ALL_ITEMS: NavItem[] = [...NAV_ITEMS, ...MAILBOX_SCOPED_ITEMS];

/**
 * Gates every `apps/admin` page behind the `admin` trusted role. Uses `GET /api/admin/release-notes` (any
 * `BaseAdminRoute` endpoint works — this one is side-effect-free) purely as a canary: a 200 means the
 * caller's JWT carries a trusted role, a 403 means it doesn't. There is no local step-up/elevation flow
 * (that would need a cross-origin call to auth-server's own elevation endpoint — not wired up yet).
 */
export default function AdminShell({ active, userUid, authServerUrl, children }: PropsWithChildren<AdminShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const { branding, iconSrc } = useBranding();

    useRedirectIfUnauthenticated(userUid, authServerUrl);

    useEffect(() => {
        if (!userUid) {
            return;
        }
        apiFetch("/admin/release-notes")
            .then(() => setStatus("authorized"))
            .catch((err) => {
                if (err instanceof ApiRequestError && (err.status === 403 || err.status === 401)) {
                    setStatus("denied");
                    return;
                }
                setError(err instanceof ApiRequestError ? err.message : "Could not verify administrator access.");
                setStatus("error");
            });
    }, [userUid]);

    function handleSignOut() {
        window.location.href = authServerUrl ?? "/";
    }

    let content: ReactNode;
    if (!userUid || status === "checking") {
        content = <div className="min-h-screen" />;
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
        const activeItem = ALL_ITEMS.find((item) => item.id === active);
        content = (
            <div className="min-h-screen flex flex-col bg-surface-alt">
                <div className="flex-1 flex min-h-0">
                    <nav
                        aria-label="Admin sections"
                        className="hidden md:flex w-16 shrink-0 bg-surface border-r border-border flex-col items-center py-3 gap-1"
                    >
                        <img src={iconSrc} width="96" height="96" alt="" className="mb-3" />
                        {NAV_ITEMS.map(({ id, href, label, icon: Icon }) => (
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
                    <BottomTabBar apps={NAV_ITEMS} active={active} />
                    <div className="flex-1 flex flex-col min-w-0">
                        <header className="h-16 shrink-0 bg-surface border-b border-border flex items-center justify-between gap-4 px-6">
                            <span className="font-display font-bold text-lg uppercase tracking-wide">{activeItem?.label}</span>
                            <UserMenu userUid={userUid} authServerUrl={authServerUrl} onSignOut={handleSignOut} />
                        </header>
                        <div className="flex-1 pb-14 md:pb-0">
                            <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <>
            <BrandingHeader branding={branding} />
            {content}
            <BrandingFooter branding={branding} />
        </>
    );
}
