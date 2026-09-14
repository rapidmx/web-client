///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "../../styles/app.css";
import React, { PropsWithChildren, useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { HiOutlineCalendarDays, HiOutlineClipboardDocumentList, HiOutlineEnvelope, HiOutlineUsers } from "react-icons/hi2";
import { useRedirectIfUnauthenticated } from "@rapidmx/react-shared/auth/session.js";
import { getSetupStatus } from "@rapidmx/react-shared/admin/setupApi.js";
import { stopImpersonating } from "@rapidmx/react-shared/mail/mailApi.js";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import { useIdleKeyTimeout } from "@rapidmx/react-shared/crypto/useIdleKeyTimeout.js";
import ComposeProvider from "../mail/compose/ComposeContext.js";
import { flushComposeDrafts, markSigningOut } from "../mail/compose/composeFlushRegistry.js";
import BottomTabBar from "@rapidmx/react-shared/components/navigation/BottomTabBar.js";
import { BrandingFooter, BrandingHeader } from "./BrandingChrome.js";
import UserMenu from "./UserMenu.js";
import { UnlockPromptProvider } from "./UnlockPromptProvider.js";
import { SIGN_OUT_CHANNEL, destroyAllLocalIndexes } from "../../search/localIndexRpcClient.js";
import { authApiFetch } from "@rapidmx/react-shared/util/api.js";
import { destroyUnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";

/** How long sign-out waits for auth-server's logout before navigating anyway. */
export const LOGOUT_TIMEOUT_MS = 3_000;

/**
 * Calls auth-server's logout (`POST /api/auth/logout`, cross-origin with credentials), which clears the auth
 * cookie and invalidates the session's refresh token. Bounded by `LOGOUT_TIMEOUT_MS` and never rejects - a
 * failure (unreachable server, CORS) must not keep the user from leaving.
 */
async function logOutOfAuthServer(authServerUrl: string | undefined): Promise<void> {
    if (!authServerUrl) {
        return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);
    try {
        await authApiFetch(authServerUrl, "/auth/logout", { method: "POST", signal: controller.signal });
    } catch {
        // Navigate anyway - see this function's doc comment.
    } finally {
        clearTimeout(timer);
    }
}

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
    const signingOutRef = useRef(false);
    const { branding, iconSrc } = useBranding();

    useRedirectIfUnauthenticated(userUid, authServerUrl);
    // Mounted here, not scoped to Mail/Settings (the only shells that actually read unlocked keys),
    // specifically so activity in *any* app resets the idle clock - see that hook's own doc comment.
    useIdleKeyTimeout();

    // An administrator on a server that hasn't finished first-run setup is sent to the setup wizard. The status
    // check is admin-only, so it's only made for a trusted caller - everyone else would just get a 403 on every
    // page load. Any failure is ignored.
    useEffect(() => {
        if (!userUid || impersonating || !trusted) {
            return;
        }
        getSetupStatus()
            .then((status) => {
                if (status.required) {
                    window.location.href = "/admin/setup";
                }
            })
            .catch(() => undefined);
    }, [userUid, impersonating, trusted]);

    // Another tab signing out (this app's `handleSignOut`, or the admin/escrow consoles' `signOutOfConsole()`)
    // ended this session too - its auth cookie is gone - so this tab destroys its own unlocked keys and every
    // local search index on the device, then leaves as well. The consoles have no local-index client of their
    // own, so this is what actually removes the indexes after a console sign-out (the console also records a
    // pending deletion, retried on the next mail load, in case no mail tab is open). `destroyAllLocalIndexes()`
    // announces the sign-out on this same channel, which this tab then hears itself, so the ref is set first:
    // each tab reacts once, and the tab that started the sign-out ignores its own announcement.
    useEffect(() => {
        if (!userUid || typeof BroadcastChannel === "undefined") {
            return;
        }
        const channel = new BroadcastChannel(SIGN_OUT_CHANNEL);
        channel.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
            if (event.data?.type !== "sign-out" || signingOutRef.current) {
                return;
            }
            signingOutRef.current = true;
            // Compose windows must not ask "Leave site?" - that would let this forced navigation be cancelled.
            markSigningOut();
            destroyUnlockedKeys();
            // Bounded by its own timeout and never rejects - awaited so navigating doesn't kill the Worker mid-delete.
            void destroyAllLocalIndexes().then(() => {
                window.location.href = authServerUrl ?? "/";
            });
        });
        return () => channel.close();
    }, [userUid, authServerUrl]);

    async function handleSignOut() {
        signingOutRef.current = true;
        // Before flushing and navigating: compose windows then skip their "Leave site?" prompt, which could
        // otherwise cancel the sign-out's own navigation.
        markSigningOut();
        // Unlocked private keys never outlive an explicit sign-out.
        destroyUnlockedKeys();
        // Open compose windows save edits still waiting on their autosave debounce while the session is still
        // valid - logout invalidates it. Bounded the same way as logout itself, and never rejects.
        await flushComposeDrafts(LOGOUT_TIMEOUT_MS);
        // The Tier 2 local index MUST be destroyed on explicit logout, the same as unlocked keys themselves
        // (spec §11). Destroys every index on this device (not only mailboxes opened this page load) and is
        // awaited before navigating - a navigation tears down the Worker mid-delete otherwise.
        // destroyAllLocalIndexes() is bounded by its own timeout and never rejects, so sign-out can't hang.
        // In parallel, auth-server's logout clears the auth cookie and invalidates the session's refresh
        // token - without it, "Sign Out" would only navigate away from a still-valid session.
        await Promise.all([destroyAllLocalIndexes(), logOutOfAuthServer(authServerUrl)]);
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
        // Mounted here, not scoped to Mail/Settings, for the same reason as useIdleKeyTimeout() above -
        // ComposeWindow's sign/encrypt toggles and MessageDetailPane's encrypted-message view (both Mail)
        // are today's only useUnlockPrompt() callers, but this needs to be available to any app shell.
        <UnlockPromptProvider>
            {/* An impersonating admin acts with the impersonated user's access, so their own trusted role
                mustn't skip the per-mailbox checks. */}
            <ComposeProvider userUid={userUid} trusted={!!trusted && !impersonating}>
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
        </UnlockPromptProvider>
    );
}
