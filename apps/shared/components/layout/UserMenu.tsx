///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import { HiOutlineArrowUturnLeft, HiOutlineShieldCheck } from "react-icons/hi2";
import { formatProfileName, getMyProfile, getMyUsername, Profile, profileInitials } from "@rapidmx/react-shared/auth/profileApi.js";
import { listMailboxes, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { accountUrlOf } from "../../auth/accountUrl.js";
import { DEFAULT_TRUSTED_ROLES, lookUpAdminAccess } from "../../auth/adminAccess.js";
import { ariaKeyShortcuts } from "../../keyboard/format.js";
import { SHORTCUTS } from "../../keyboard/keymap.js";
import { useKeyEnvironment } from "../../keyboard/ShortcutProvider.js";
import { APP_HREFS, SETTINGS_HREF } from "../../navigation/appHrefs.js";
import { MailConnectionContext } from "../../mail/useMailConnection.js";
import { ownMailboxes } from "../../mail/primaryMailbox.js";
import ThemeSwitch from "./ThemeSwitch.js";
import {
    DesktopPermission,
    desktopPermission,
    requestDesktopPermission,
    setDesktopOfferDismissed,
} from "../../mail/newMailNotifications.js";
import { getNotificationsEnabled, setNotificationsEnabled } from "../../notifications/preferences.js";
import { dismissAll } from "../../notifications/store.js";

export interface UserMenuProps {
    userUid: string;
    /** auth-server's base URL — where the caller's own profile (name/avatar) and username are fetched from, and what
     * the "Account" item links into, if configured. Without it the menu shows the bare uid and has no "Account" item. */
    authServerUrl?: string;
    onSignOut: () => void;
    /** Shows an "Admin Console" item linking to `/admin`, above "Sign Out" — pass only for a trusted-role caller
     * (the JWT carries the role, i.e. an elevated session). See `detectAdmin` for everyone else. */
    showAdminLink?: boolean;
    /** Asks auth-server whether the caller holds a trusted role (`GET /api/users/me`, once per sitting - see
     * `lookUpAdminAccess()`) and shows the "Admin Console" item if so. Needed because a token that isn't elevated
     * carries no trusted role, so an administrator with an ordinary session is not `showAdminLink`. Does nothing
     * without `authServerUrl`, and a failed lookup leaves the item hidden. Pass `false` while impersonating. */
    detectAdmin?: boolean;
    /** The role names the server treats as trusted (its `trusted_roles` config) - what `detectAdmin` looks for.
     * Defaults to `["admin"]`, the server's own default. */
    trustedRoles?: readonly string[];
    /** Shows a "Settings" item, above "Admin"/"Sign Out" — an account-scoped surface (like "Admin"), not
     * a content-scoped one, so it lives here rather than as a 5th `AppShell` rail icon. Links straight to
     * `/settings/auto-reply`, the only settings section that exists today; repoint this at a real
     * `/settings` landing page once a second section (Mail Filters, Signatures) makes one worth building. */
    showSettingsLink?: boolean;
    /** Shows the notification controls, above "Admin Console"/"Sign Out": a "Notifications" on/off switch for every pop-up and,
     * while the browser hasn't been asked, "Turn on desktop notifications". Both are per browser (see `notifications/preferences.ts`
     * and `newMailNotifications.ts`). For the shells that draw pop-ups (`AppShell`). */
    showNotificationSettings?: boolean;
    /** Shows a "Keyboard shortcuts" item that calls this - opening the help dialog (`?` and Ctrl+/ do too); not on the phone layout. For the shells that have the
     * keyboard layer (`AppChrome`); the consoles don't offer it. */
    onShowShortcuts?: () => void;
    /** Which way the menu opens from its button: `"down"` (the default; in a header) or `"up"` (in a footer, where there is no room below). */
    placement?: "down" | "up";
    /** Shows a "Recent notifications" item that calls this - opening the history of the last pop-ups (`AppChrome` only). */
    onShowNotifications?: () => void;
    /** Shows a "Back to mail" item, first in the menu, linking to the main application (`/`, on this same host). For the consoles
     * (`AdminShell`), which are a step away from the app; the app itself has no need of it. */
    showMailLink?: boolean;
    /** Errors in that history nobody has looked at yet: a count beside the item, and a dot on the menu button. */
    unseenErrors?: number;
}

function Avatar({ profile, initials, large }: { profile?: Profile; initials: string; large?: boolean }) {
    const sizeClass = large ? "w-10 h-10 text-base" : "w-8 h-8 text-sm";
    if (profile?.avatar) {
        return (
            <img
                src={profile.avatar}
                alt=""
                className={`${sizeClass} rounded-full object-cover shrink-0`}
            />
        );
    }
    return (
        <span
            className={`${sizeClass} rounded-full bg-primary text-white font-semibold flex items-center justify-center shrink-0`}
        >
            {initials}
        </span>
    );
}

/**
 * The top-right "who am I" menu shared by every shell (`AppShell`, `AdminShell`, `EscrowShell`): an avatar-button
 * trigger that opens a dropdown showing the caller's avatar/name, an "Account" link to auth-server's account page,
 * an optional "Settings" and "Admin Console" link, and "Sign Out". This service has no local user directory (see
 * `.claude/NOTES.md`), so the name and avatar come from auth-server, and the displayed name (and the initials badge)
 * falls back down a chain: the profile's name (`GET /api/profiles/me`), else the display name of the mailbox the
 * caller owns (`listMailboxes()`, or the list the app frame already holds; a shared or delegated mailbox does not count), else the caller's username - their first
 * verified `name` alias (`GET /api/aliases?type=name`) - else the bare uid. The mailbox and the username are asked for
 * only when the profile gave no name, and the username only when the mailbox gave none. Every lookup can fail
 * (auth-server's CORS list not including this origin, or no profile document at all - a 404 for some accounts) and none
 * ever surfaces as an error. The avatar image comes from the profile alone.
 */
export default function UserMenu({
    userUid,
    authServerUrl,
    onSignOut,
    showAdminLink,
    detectAdmin,
    trustedRoles = DEFAULT_TRUSTED_ROLES,
    showSettingsLink,
    showNotificationSettings,
    onShowShortcuts,
    placement = "down",
    onShowNotifications,
    showMailLink,
    unseenErrors = 0,
}: UserMenuProps) {
    const env = useKeyEnvironment();
    // A phone has no keyboard to speak of, so the shortcuts list (and the dialog it opens) has nothing to offer there.
    const isMobile = useIsMobile();
    const [open, setOpen] = useState(false);
    // Where the menu sits, in window coordinates: it is drawn through a portal into `<body>` with `position: fixed`, so no ancestor's
    // `overflow`, `z-index` or stacking context - a custom branding header's, say - can clip it or put it behind the page.
    const [anchor, setAnchor] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [detectedAdmin, setDetectedAdmin] = useState(false);
    const [popups, setPopups] = useState(true);
    const [permission, setPermission] = useState<DesktopPermission>("unsupported");
    const [profile, setProfile] = useState<Profile | undefined>(undefined);
    // Whether the profile lookup has answered, with a profile or without: the fallback names are only worth asking for after that.
    const [profileSettled, setProfileSettled] = useState(false);
    const [username, setUsername] = useState<string | undefined>(undefined);
    // The mailboxes this menu listed itself; `null` until it has, or when it has no need to.
    const [ownListing, setOwnListing] = useState<Mailbox[] | null>(null);
    // Inside the app frame the mailboxes are already listed for the whole session (see `useMailConnection()`), so they are reused, not listed again.
    const connection = useContext(MailConnectionContext);
    const framed = connection !== null;
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!authServerUrl) {
            return;
        }
        let cancelled = false;
        void (async () => {
            let loaded: Profile | undefined;
            try {
                loaded = await getMyProfile(authServerUrl);
            } catch {
                // Unreachable, blocked, or no profile document (404) - fall through to the fallback names.
            }
            if (!cancelled) {
                setProfile(loaded);
                setProfileSettled(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [authServerUrl]);

    // The mailbox's display name and then the username are only fallbacks for a missing name - nothing more is asked when the profile has
    // one, and no username is asked for when the mailbox has a name. Without `authServerUrl` the profile never settles, so nothing is.
    const needsFallbackName = profileSettled && !formatProfileName(profile);

    useEffect(() => {
        if (!needsFallbackName || framed) {
            return;
        }
        let cancelled = false;
        // A failure (no mail server, no access) is just "no mailbox name" - the username is asked for next.
        listMailboxes({ limit: 50 }).then(
            (list) => !cancelled && setOwnListing(Array.isArray(list) ? list : []),
            () => !cancelled && setOwnListing([]),
        );
        return () => {
            cancelled = true;
        };
    }, [needsFallbackName, framed]);

    // `null` while the mailboxes are still on their way.
    const listed = framed ? (connection.status === "checking" ? null : connection.mailboxes) : ownListing;
    const mailboxesKnown = listed !== null;
    // Only a mailbox the caller owns counts: a shared or delegated one carries somebody else's name.
    const mailboxName = needsFallbackName ? ownMailboxes(listed ?? [], userUid)[0]?.displayName?.trim() || undefined : undefined;

    useEffect(() => {
        if (!authServerUrl || !needsFallbackName || !mailboxesKnown || mailboxName) {
            return;
        }
        let cancelled = false;
        void getMyUsername(authServerUrl).then((alias) => {
            if (!cancelled) {
                setUsername(alias);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [authServerUrl, needsFallbackName, mailboxesKnown, mailboxName]);

    // Keyed on the joined names, not the array: a caller's fresh `["admin"]` each render must not re-ask.
    const trustedRolesKey = JSON.stringify(trustedRoles);
    useEffect(() => {
        if (!detectAdmin || !authServerUrl || showAdminLink) {
            setDetectedAdmin(false);
            return;
        }
        let cancelled = false;
        void lookUpAdminAccess(authServerUrl, userUid, JSON.parse(trustedRolesKey) as string[]).then((admin) => {
            if (!cancelled) {
                setDetectedAdmin(admin === true);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [detectAdmin, authServerUrl, userUid, showAdminLink, trustedRolesKey]);

    // Read fresh each time the menu opens - another tab may have changed either since - and only on the client.
    useEffect(() => {
        if (open && showNotificationSettings) {
            setPopups(getNotificationsEnabled());
            setPermission(desktopPermission());
        }
    }, [open, showNotificationSettings]);

    function togglePopups() {
        setNotificationsEnabled(!popups);
        setPopups(!popups);
        if (popups) {
            // Turned off: what is on screen goes too (it stays in "Recent notifications").
            dismissAll();
        }
    }

    async function enableDesktopNotifications() {
        // Asked from this click, as browsers require; a "no" (or "yes") answers the first pop-up's offer as well.
        setPermission(await requestDesktopPermission());
        setDesktopOfferDismissed(true);
    }

    useEffect(() => {
        if (!open) {
            return;
        }
        function handlePointerDown(e: MouseEvent) {
            // The menu is portalled out of the container, so it and the button are checked separately.
            if (
                containerRef.current &&
                e.target instanceof Node &&
                !containerRef.current.contains(e.target) &&
                !menuRef.current?.contains(e.target)
            ) {
                setOpen(false);
            }
        }
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [open]);

    // Measured before paint, and again whenever the window resizes or anything scrolls (a footer's button moves with the page).
    useLayoutEffect(() => {
        if (!open) {
            setAnchor(null);
            return;
        }
        function place() {
            const rect = containerRef.current!.getBoundingClientRect();
            const right = Math.max(8, window.innerWidth - rect.right);
            setAnchor(placement === "up" ? { right, bottom: window.innerHeight - rect.top + 8 } : { right, top: rect.bottom + 8 });
        }
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [open, placement]);

    const name = formatProfileName(profile) ?? mailboxName ?? username ?? userUid;
    // The badge takes its letter from whichever fallback name is shown, so it never disagrees with the name beside it.
    const initials = profileInitials(profile, userUid, mailboxName ?? username);
    const accountUrl = accountUrlOf(authServerUrl);

    return (
        <div className="relative" ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="true"
                aria-expanded={open}
                aria-label="Account menu"
                className="relative flex items-center gap-1.5 rounded-pill py-1 pl-1 pr-2 hover:bg-surface-alt"
            >
                <Avatar profile={profile} initials={initials} />
                {unseenErrors > 0 && (
                    <span data-testid="unseen-errors-dot" aria-hidden="true" className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-danger" />
                )}
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 20 20"
                    fill="none"
                    className={`text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
                    aria-hidden="true"
                >
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            {open &&
                anchor &&
                createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    style={{ position: "fixed", right: anchor.right, top: anchor.top, bottom: anchor.bottom }}
                    className="w-60 max-w-[calc(100vw-1rem)] max-h-[calc(100vh-5rem)] overflow-y-auto bg-surface border border-border rounded-md shadow-modal py-1.5 z-[70]"
                >
                    <div className="flex items-center gap-3 px-3.5 py-2.5 border-b border-border">
                        <Avatar profile={profile} initials={initials} large />
                        <span className="text-sm font-semibold text-text truncate">{name}</span>
                    </div>
                    {showMailLink && (
                        <a
                            role="menuitem"
                            href={APP_HREFS.mail}
                            className="flex items-center gap-2 px-3.5 py-2 text-sm text-text hover:bg-surface-alt"
                        >
                            <HiOutlineArrowUturnLeft size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
                            Back to mail
                        </a>
                    )}
                    <ThemeSwitch />
                    {accountUrl && (
                        <a
                            role="menuitem"
                            href={accountUrl}
                            className="block px-3.5 py-2 text-sm text-text hover:bg-surface-alt"
                        >
                            Account
                        </a>
                    )}
                    {showSettingsLink && (
                        <a
                            role="menuitem"
                            href={SETTINGS_HREF}
                            className="block px-3.5 py-2 text-sm text-text hover:bg-surface-alt"
                        >
                            Settings
                        </a>
                    )}
                    {showNotificationSettings && (
                        <button
                            role="menuitemcheckbox"
                            aria-checked={popups}
                            type="button"
                            onClick={togglePopups}
                            className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left text-sm text-text hover:bg-surface-alt"
                        >
                            <span>Notifications</span>
                            <span className="text-xs font-semibold text-text-muted">{popups ? "On" : "Off"}</span>
                        </button>
                    )}
                    {showNotificationSettings && permission === "default" && (
                        <button
                            role="menuitem"
                            type="button"
                            onClick={() => void enableDesktopNotifications()}
                            className="block w-full px-3.5 py-2 text-left text-sm text-text hover:bg-surface-alt"
                        >
                            Turn on desktop notifications
                        </button>
                    )}
                    {onShowNotifications && (
                        <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                                setOpen(false);
                                onShowNotifications();
                            }}
                            className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left text-sm text-text hover:bg-surface-alt"
                        >
                            <span>Recent notifications</span>
                            {unseenErrors > 0 && (
                                <span className="rounded-pill bg-danger px-1.5 text-xs font-bold text-white">
                                    <span aria-hidden="true">{unseenErrors}</span>
                                    <span className="sr-only">{unseenErrors} unseen {unseenErrors === 1 ? "error" : "errors"}</span>
                                </span>
                            )}
                        </button>
                    )}
                    {onShowShortcuts && !isMobile && (
                        <button
                            role="menuitem"
                            type="button"
                            aria-keyshortcuts={ariaKeyShortcuts(SHORTCUTS.global.help, env)}
                            onClick={() => {
                                setOpen(false);
                                onShowShortcuts();
                            }}
                            className="block w-full px-3.5 py-2 text-left text-sm text-text hover:bg-surface-alt"
                        >
                            Keyboard shortcuts
                        </button>
                    )}
                    {(showAdminLink || detectedAdmin) && (
                        <a
                            role="menuitem"
                            href="/admin"
                            className="flex items-center gap-2 px-3.5 py-2 text-sm text-text hover:bg-surface-alt"
                        >
                            <HiOutlineShieldCheck size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
                            Admin Console
                        </a>
                    )}
                    <button
                        role="menuitem"
                        type="button"
                        onClick={onSignOut}
                        className="block w-full text-left px-3.5 py-2 text-sm text-text hover:bg-surface-alt"
                    >
                        Sign Out
                    </button>
                </div>,
                document.body,
            )}
        </div>
    );
}
