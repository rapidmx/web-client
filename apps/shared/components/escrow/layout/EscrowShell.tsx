///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "../../../styles/app.css";
import React, { PropsWithChildren, ReactNode, useEffect, useState } from "react";
import { HiOutlineClipboardDocumentList, HiOutlineFolderOpen } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { listMatters } from "@rapidmx/react-shared/admin/mattersApi.js";
import { useRedirectIfUnauthenticated } from "@rapidmx/react-shared/auth/session.js";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import BottomTabBar, { NavItem } from "@rapidmx/react-shared/components/navigation/BottomTabBar.js";
import { BrandingFooter, BrandingHeader } from "../../layout/BrandingChrome.js";
import UserMenu from "../../layout/UserMenu.js";

export type EscrowSection = "matters" | "auditLog";

export interface EscrowShellProps {
    active: EscrowSection;
    userUid?: string;
    authServerUrl?: string;
}

type Status = "checking" | "error" | "authorized";

const NAV_ITEMS: NavItem[] = [
    { id: "matters", href: "/escrow", label: "Matters", icon: HiOutlineFolderOpen },
    { id: "auditLog", href: "/escrow/audit-log", label: "Audit Log", icon: HiOutlineClipboardDocumentList },
];

/**
 * Gates every `apps/escrow` page behind "is this an authenticated caller at all" — deliberately **not**
 * the same "does a canary endpoint 403 me" pattern `AdminShell` uses for the trusted `admin` role.
 * `specs/end-to-end_encryption.md`'s "Separation of duties" makes holder-ness a per-`EscrowScope` grant
 * (`EscrowScope.holderUserUids`), checked directly against `holderUserUids` in every restapi route that
 * needs it (`requireEscrowHolder()`) — never a role, and never global. There is no canary endpoint a
 * non-holder gets a clean 403 from: `GET /escrow/matters` (`BaseMatterRoute.find()`) returns `200 []` for
 * *any* authenticated caller who holds no scope at all, the same as it would for a holder of zero matters
 * — so unlike `AdminShell`, this shell cannot distinguish "holds nothing" from "holds no scope at all" up
 * front, and does not try to. It only confirms the caller is signed in and the API is reachable; every
 * actual holder-gated action (create a Matter, approve/deny a request, read material) is enforced
 * server-side and surfaces its own 403 `ApiRequestError` on the specific page that attempted it, same as
 * any other gated action elsewhere in this codebase. A non-holder who reaches `/escrow` simply sees an
 * empty Matters list and gets a real error if they try to act on something they don't hold — this is a
 * deliberate, documented scope trim rather than an oversight (see this session's own report on it).
 */
export default function EscrowShell({ active, userUid, authServerUrl, children }: PropsWithChildren<EscrowShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const { branding, iconSrc } = useBranding();

    useRedirectIfUnauthenticated(userUid, authServerUrl);

    useEffect(() => {
        if (!userUid) {
            return;
        }
        // limit=1 - this call exists only to confirm the API is reachable for this signed-in caller, not
        // to read any real data (every page below fetches its own data itself).
        listMatters({ limit: 1 })
            .then(() => setStatus("authorized"))
            .catch((err) => {
                setError(err instanceof ApiRequestError ? err.message : "Could not verify escrow console access.");
                setStatus("error");
            });
    }, [userUid]);

    function handleSignOut() {
        window.location.href = authServerUrl ?? "/";
    }

    let content: ReactNode;
    if (!userUid || status === "checking") {
        content = <div className="min-h-screen" />;
    } else if (status === "error") {
        content = (
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="w-full max-w-md">
                    <Alert>{error}</Alert>
                </div>
            </div>
        );
    } else {
        const activeItem = NAV_ITEMS.find((item) => item.id === active);
        content = (
            <div className="min-h-screen flex flex-col bg-surface-alt">
                <div className="flex-1 flex min-h-0">
                    <nav
                        aria-label="Escrow sections"
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
