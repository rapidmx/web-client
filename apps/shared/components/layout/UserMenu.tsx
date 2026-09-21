///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import { HiOutlineShieldCheck } from "react-icons/hi2";
import { formatProfileName, getMyProfile, getMyUsername, Profile, profileInitials } from "@rapidmx/react-shared/auth/profileApi.js";
import { accountUrlOf } from "../../auth/accountUrl.js";
import { DEFAULT_TRUSTED_ROLES, lookUpAdminAccess } from "../../auth/adminAccess.js";
import { ariaKeyShortcuts } from "../../keyboard/format.js";
import { SHORTCUTS } from "../../keyboard/keymap.js";
import { useKeyEnvironment } from "../../keyboard/ShortcutProvider.js";
import { SETTINGS_HREF } from "../../navigation/appHrefs.js";
import {
    DesktopPermission,
    desktopPermission,
    getNewMailPopupsEnabled,
    requestDesktopPermission,
    setDesktopOfferDismissed,
    setNewMailPopupsEnabled,
} from "../../mail/newMailNotifications.js";

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
    /** Shows the new-mail notification controls, above "Admin Console"/"Sign Out": a "New mail pop-ups" on/off switch and, while
     * the browser hasn't been asked, "Turn on desktop notifications". Both are per browser (see `newMailNotifications.ts`).
     * For the shells that announce new mail (Mail); the consoles have nothing to announce. */
    showNotificationSettings?: boolean;
    /** Shows a "Keyboard shortcuts" item that calls this - opening the help dialog (`?` and Ctrl+/ do too). For the shells that have the
     * keyboard layer (`AppChrome`); the consoles don't offer it. */
    onShowShortcuts?: () => void;
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
 * falls back down a chain: the profile's name (`GET /api/profiles/me`), else the caller's username - their first
 * verified `name` alias (`GET /api/aliases?type=name`, asked for only when the profile gave no name) - else the bare
 * uid. Either lookup can fail (auth-server's CORS list not including this origin, or no profile document at all - a
 * 404 for some accounts) and neither ever surfaces as an error. The avatar image comes from the profile alone.
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
}: UserMenuProps) {
    const env = useKeyEnvironment();
    const [open, setOpen] = useState(false);
    const [detectedAdmin, setDetectedAdmin] = useState(false);
    const [popups, setPopups] = useState(true);
    const [permission, setPermission] = useState<DesktopPermission>("unsupported");
    const [profile, setProfile] = useState<Profile | undefined>(undefined);
    const [username, setUsername] = useState<string | undefined>(undefined);
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
                // Unreachable, blocked, or no profile document (404) - fall through to the username.
            }
            if (cancelled) {
                return;
            }
            setProfile(loaded);
            // The username is only the fallback for a missing name - no second request when the profile has one.
            if (!formatProfileName(loaded)) {
                const alias = await getMyUsername(authServerUrl);
                if (!cancelled) {
                    setUsername(alias);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [authServerUrl]);

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
            setPopups(getNewMailPopupsEnabled());
            setPermission(desktopPermission());
        }
    }, [open, showNotificationSettings]);

    function togglePopups() {
        setNewMailPopupsEnabled(!popups);
        setPopups(!popups);
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
            if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
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

    const name = formatProfileName(profile) ?? username ?? userUid;
    const initials = profileInitials(profile, userUid, username);
    const accountUrl = accountUrlOf(authServerUrl);

    return (
        <div className="relative" ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="true"
                aria-expanded={open}
                aria-label="Account menu"
                className="flex items-center gap-1.5 rounded-pill py-1 pl-1 pr-2 hover:bg-surface-alt"
            >
                <Avatar profile={profile} initials={initials} />
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
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-full mt-2 w-60 bg-surface border border-border rounded-md shadow-modal py-1.5 z-10"
                >
                    <div className="flex items-center gap-3 px-3.5 py-2.5 border-b border-border">
                        <Avatar profile={profile} initials={initials} large />
                        <span className="text-sm font-semibold text-text truncate">{name}</span>
                    </div>
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
                            <span>New mail pop-ups</span>
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
                    {onShowShortcuts && (
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
                </div>
            )}
        </div>
    );
}
