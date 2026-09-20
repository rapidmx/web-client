///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import { formatProfileName, getMyProfile, getMyUsername, Profile, profileInitials } from "@rapidmx/react-shared/auth/profileApi.js";

export interface UserMenuProps {
    userUid: string;
    /** auth-server's base URL — where the caller's own profile (name/avatar) and username are fetched from, and what
     * the "Account" item links into, if configured. Without it the menu shows the bare uid and has no "Account" item. */
    authServerUrl?: string;
    onSignOut: () => void;
    /** Shows an "Admin" item linking to `/admin`, above "Sign Out" — pass only for a trusted-role caller. */
    showAdminLink?: boolean;
    /** Shows a "Settings" item, above "Admin"/"Sign Out" — an account-scoped surface (like "Admin"), not
     * a content-scoped one, so it lives here rather than as a 5th `AppShell` rail icon. Links straight to
     * `/settings/auto-reply`, the only settings section that exists today; repoint this at a real
     * `/settings` landing page once a second section (Mail Filters, Signatures) makes one worth building. */
    showSettingsLink?: boolean;
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
 * an optional "Settings" and "Admin" link, and "Sign Out". This service has no local user directory (see
 * `.claude/NOTES.md`), so the name and avatar come from auth-server, and the displayed name (and the initials badge)
 * falls back down a chain: the profile's name (`GET /api/profiles/me`), else the caller's username - their first
 * verified `name` alias (`GET /api/aliases?type=name`, asked for only when the profile gave no name) - else the bare
 * uid. Either lookup can fail (auth-server's CORS list not including this origin, or no profile document at all - a
 * 404 for some accounts) and neither ever surfaces as an error. The avatar image comes from the profile alone.
 */
export default function UserMenu({ userUid, authServerUrl, onSignOut, showAdminLink, showSettingsLink }: UserMenuProps) {
    const [open, setOpen] = useState(false);
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
    // Tolerates a configured URL with a trailing slash, which would otherwise produce `//account`.
    const accountUrl = authServerUrl ? `${authServerUrl.replace(/\/+$/, "")}/account` : undefined;

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
                            href="/settings/auto-reply"
                            className="block px-3.5 py-2 text-sm text-text hover:bg-surface-alt"
                        >
                            Settings
                        </a>
                    )}
                    {showAdminLink && (
                        <a
                            role="menuitem"
                            href="/admin"
                            className="block px-3.5 py-2 text-sm text-text hover:bg-surface-alt"
                        >
                            Admin
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
