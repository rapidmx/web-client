///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "../../styles/app.css";
import React, { PropsWithChildren, useState } from "react";
import type { IconType } from "react-icons";
import { HiOutlineCalendarDays, HiOutlineClipboardDocumentList, HiOutlineEnvelope, HiOutlineUsers } from "react-icons/hi2";
import { useRedirectIfUnauthenticated } from "@rapidmx/react-shared/session.js";
import { stopImpersonating } from "@rapidmx/react-shared/mailApi.js";
import useBranding from "@rapidmx/react-shared/useBranding.js";
import ComposeProvider from "../mail/compose/ComposeContext.js";
import BottomTabBar from "./BottomTabBar.js";
import { BrandingFooter, BrandingHeader } from "./BrandingChrome.js";
import UserMenu from "./UserMenu.js";

export type AppShellApp = "mail" | "calendar" | "contacts" | "tasks";

/** `"settings"` is a valid `active` value but deliberately has no entry in `APPS` below — Settings is
 * reached via a `UserMenu` item, not a 5th rail icon (see `SettingsShell.tsx`), so it highlights no
 * rail/tab icon at all; only the header title (`ACTIVE_LABELS` below) needs to account for it. */
export type AppShellActive = AppShellApp | "settings";

export interface AppShellProps {
    /** Which icon in the rail is highlighted as the current app — `"settings"` highlights none. */
    active: AppShellActive;
    /** Populated automatically by the framework from an authenticated request (e.g. a valid `jwt` cookie). */
    userUid?: string;
    /** auth-server's base URL, injected via the route's `fetchProps`. */
    authServerUrl?: string;
    /**
     * `true` when this session is an admin "log in as user" impersonation (a `jwt_impersonator` cookie is
     * present) — see `MailShell`'s original doc comment, unchanged now that this lives here. Drives the
     * "you are viewing as this user — stop impersonating" banner below.
     */
    impersonating?: boolean;
    /** Where `mailApi.ts`'s `stopImpersonating()` should call — see `MailShell`'s original doc comment. */
    impersonationBaseUrl?: string;
    /** `true` when the caller's JWT carries a trusted role — shows an "Admin" item in the user menu below. */
    trusted?: boolean;
}

export interface AppDef {
    id: AppShellApp;
    href: string;
    label: string;
    icon: IconType;
}

export const APPS: AppDef[] = [
    { id: "mail", href: "/", label: "Mail", icon: HiOutlineEnvelope },
    { id: "calendar", href: "/calendar", label: "Calendar", icon: HiOutlineCalendarDays },
    { id: "contacts", href: "/contacts", label: "Contacts", icon: HiOutlineUsers },
    { id: "tasks", href: "/tasks", label: "Tasks", icon: HiOutlineClipboardDocumentList },
];

/** The header title for every valid `active` value — a superset of `APPS`' own labels since `"settings"`
 * has no rail icon (and so no `AppDef`) but still needs a header title. */
const ACTIVE_LABELS: Record<AppShellActive, string> = {
    mail: "Mail",
    calendar: "Calendar",
    contacts: "Contacts",
    tasks: "Tasks",
    settings: "Settings",
};

/**
 * The persistent chrome shared by every webmail app (Mail, Calendar, Contacts, Tasks): a left icon rail for
 * switching apps (full page loads — see `MailShell`'s original doc comment on this framework having no
 * client-side router), a header with the current app's name and `UserMenu`, and the impersonation banner.
 * Each app's own shell (e.g. `MailShell`) renders its own contextual sidebar + content as `children`, inside
 * the area to the right of the icon rail and below the header.
 */
export default function AppShell({
    active,
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    children,
}: PropsWithChildren<AppShellProps>) {
    const [stoppingImpersonation, setStoppingImpersonation] = useState(false);
    const { branding, iconSrc } = useBranding();

    useRedirectIfUnauthenticated(userUid, authServerUrl);

    function handleSignOut() {
        window.location.href = authServerUrl ?? "/";
    }

    async function handleStopImpersonating() {
        setStoppingImpersonation(true);
        try {
            await stopImpersonating(impersonationBaseUrl ?? "");
        } catch {
            // Navigate either way: a failed call leaves the impersonator cookie (and this banner) exactly as
            // they were, so there's nothing else useful to show — matching this app's other network-error
            // handling, which surfaces via a full reload rather than an inline retry affordance.
        } finally {
            window.location.href = "/admin";
        }
    }

    if (!userUid) {
        return <div className="min-h-screen" />;
    }

    return (
        <ComposeProvider>
            <div className="min-h-screen flex flex-col bg-surface-alt">
                <BrandingHeader branding={branding} />
                {impersonating && (
                    <div className="h-10 shrink-0 bg-warning text-warning-contrast flex items-center justify-center gap-3 text-sm font-medium px-4">
                        <span>
                            You are viewing as <strong>{userUid}</strong>.
                        </span>
                        <button
                            type="button"
                            onClick={handleStopImpersonating}
                            disabled={stoppingImpersonation}
                            className="underline hover:no-underline disabled:opacity-60"
                        >
                            {stoppingImpersonation ? "Returning to admin…" : "Return to admin"}
                        </button>
                    </div>
                )}
                <div className="flex-1 flex min-h-0">
                    <nav
                        aria-label="Apps"
                        className="hidden md:flex w-16 shrink-0 bg-surface border-r border-border flex-col items-center py-3 gap-1"
                    >
                        <img src={iconSrc} width="96" height="96" alt="" className="mb-3" />
                        {APPS.map(({ id, href, label, icon: Icon }) => (
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
                    <BottomTabBar apps={APPS} active={active} />
                    <div className="flex-1 flex flex-col min-w-0">
                        <header className="h-16 shrink-0 bg-surface border-b border-border flex items-center justify-between gap-4 px-6">
                            <span className="font-display font-bold text-lg uppercase tracking-wide">{ACTIVE_LABELS[active]}</span>
                            <UserMenu userUid={userUid} authServerUrl={authServerUrl} onSignOut={handleSignOut} showAdminLink={trusted} showSettingsLink />
                        </header>
                        <div className="flex-1 flex min-h-0 pb-14 md:pb-0">{children}</div>
                    </div>
                </div>
                <BrandingFooter branding={branding} />
            </div>
        </ComposeProvider>
    );
}
