///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import { formatProfileName, getMyProfile, Profile, profileInitials } from "@rapidmx/react-shared/profileApi.js";

export interface UserMenuProps {
    userUid: string;
    /** auth-server's base URL — where the caller's own profile (name/avatar) is fetched from, if configured. */
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
 * The top-right "who am I" menu shared by `MailShell` and `AdminShell`: an avatar-button trigger that opens a
 * dropdown showing the caller's avatar/name, an optional "Admin" link (trusted-role callers only), and
 * "Sign Out". Name/avatar come from auth-server's own profile endpoint (`GET /api/profiles/me`) — this
 * service has no local user directory (see `.claude/NOTES.md`) — and fall back to the bare uid/its first
 * letter when unset or unreachable, which is a fully valid, expected state for most password-registered
 * accounts (only OIDC sign-in currently populates a real avatar).
 */
export default function UserMenu({ userUid, authServerUrl, onSignOut, showAdminLink, showSettingsLink }: UserMenuProps) {
    const [open, setOpen] = useState(false);
    const [profile, setProfile] = useState<Profile | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!authServerUrl) {
            return;
        }
        getMyProfile(authServerUrl)
            .then(setProfile)
            .catch(() => undefined);
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

    const name = formatProfileName(profile) ?? userUid;
    const initials = profileInitials(profile, userUid);

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
