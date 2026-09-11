///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, PropsWithChildren, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { HiOutlineBars3 } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import Drawer from "@rapidmx/react-shared/Drawer.js";
import { Mailbox, listMailboxes } from "@rapidmx/react-shared/mailApi.js";
import Alert from "../../feedback/Alert.js";
import Skeleton, { SkeletonList } from "../../feedback/Skeleton.js";
import AppShell, { AppShellProps } from "../../layout/AppShell.js";
import MailboxProvisioning from "../../layout/MailboxProvisioning.js";

export interface SettingsSectionDef {
    id: string;
    href: string;
    label: string;
}

/** Every settings section with its own sidebar entry. */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
    { id: "auto-reply", href: "/settings/auto-reply", label: "Automatic Replies" },
    { id: "filters", href: "/settings/filters", label: "Mail Filters" },
    { id: "signatures", href: "/settings/signatures", label: "Signatures" },
    { id: "focused-inbox", href: "/settings/focused-inbox", label: "Focused Inbox" },
    { id: "read-receipts", href: "/settings/read-receipts", label: "Read Receipts" },
    { id: "booking-types", href: "/settings/booking-types", label: "Booking Links" },
];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export interface SettingsShellProps extends Omit<AppShellProps, "active"> {
    /** Which entry in `SETTINGS_SECTIONS` is highlighted in this shell's own sidebar — distinct from
     * `AppShell`'s own `active` (always hardcoded to `"settings"` below), since Settings isn't a rail
     * icon (see `AppShell.tsx`'s `AppShellApp` doc comment) but still needs its own section
     * highlighting. Each settings page passes its own section id explicitly, the same "gotcha" this
     * plan already calls out for every shell's `active` prop. */
    active: SettingsSectionId;
}

export interface SettingsShellContextValue {
    /** The mailbox currently selected (`?mailboxUid=`, or the caller's first accessible mailbox) —
     * every settings section so far (Automatic Replies) edits mailbox-scoped fields. */
    mailboxUid?: string;
    mailboxes: Mailbox[];
}

const SettingsShellContext = createContext<SettingsShellContextValue>({ mailboxes: [] });

/** Reads the mailbox Settings is currently scoped to, as resolved by the enclosing `SettingsShell`. */
export function useSettingsShell(): SettingsShellContextValue {
    return useContext(SettingsShellContext);
}

type Status = "checking" | "error" | "ready";

/**
 * The Settings area's shell — reached via a `UserMenu` entry rather than a 5th `AppShell` icon (per
 * this plan's own confirmed decision), so it always passes `active="settings"` to `AppShell` regardless
 * of which section is showing. Unlike `ContactsShell`/`TasksShell` (whose sidebar is just a mailbox
 * switcher, since each has exactly one well-known folder), this shell's sidebar is a real list of
 * settings sections (`SETTINGS_SECTIONS`) — full-page navigation between them, same as the top-level
 * app rail, since this framework has no client-side router.
 */
export default function SettingsShell({
    active,
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    children,
}: PropsWithChildren<SettingsShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [requestedMailboxUid, setRequestedMailboxUid] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    useEffect(() => {
        setRequestedMailboxUid(new URLSearchParams(window.location.search).get("mailboxUid"));
    }, []);

    useEffect(() => {
        if (!userUid) {
            return;
        }
        listMailboxes({ limit: 100 })
            .then((result) => {
                setMailboxes(result);
                setStatus("ready");
            })
            .catch((err) => {
                setError(err instanceof ApiRequestError ? err.message : "Could not load your mailboxes.");
                setStatus("error");
            });
    }, [userUid]);

    const mailboxUid: string | undefined =
        (requestedMailboxUid && mailboxes.some((mb) => mb.uid === requestedMailboxUid) ? requestedMailboxUid : undefined) ??
        mailboxes[0]?.uid;

    const contextValue = useMemo<SettingsShellContextValue>(() => ({ mailboxUid, mailboxes }), [mailboxUid, mailboxes]);

    // A full-screen takeover, not nested inside the rest of the app's chrome — same as ContactsShell/
    // TasksShell, there's nothing else for a mailbox-less caller to configure here yet.
    if (userUid && status === "ready" && !mailboxUid) {
        return <MailboxProvisioning />;
    }

    let inner: ReactNode = null;
    if (userUid && status === "checking") {
        inner = (
            <div className="w-56 shrink-0 border-r border-border flex flex-col gap-4 p-3">
                <Skeleton height="h-9" />
                <SkeletonList count={3} />
            </div>
        );
    } else if (userUid && status === "error") {
        inner = (
            <div className="flex-1 flex items-center justify-center p-8">
                <div className="w-full max-w-md">
                    <Alert>{error}</Alert>
                </div>
            </div>
        );
    } else if (userUid && status === "ready") {
        // A function, not a plain JSX constant — same reasoning as ContactsShell's identical comment:
        // rendered twice (desktop `<aside>` + mobile `Drawer`), possibly simultaneously mounted, so the
        // `<select>`'s `id`/its `<label>`'s `htmlFor` need a distinct value per instance.
        const sidebarContent = (idPrefix: string) => (
            <>
                {mailboxes.length > 1 && (
                    <div>
                        <label
                            className="block text-xs font-bold uppercase tracking-wide text-text-muted mb-1"
                            htmlFor={`${idPrefix}-settings-mailbox-switcher`}
                        >
                            Mailbox
                        </label>
                        <select
                            id={`${idPrefix}-settings-mailbox-switcher`}
                            className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                            value={mailboxUid}
                            onChange={(e) => {
                                // `active` always names a real entry in `SETTINGS_SECTIONS` — every settings
                                // page passes its own section id explicitly (see `SettingsShellProps.active`'s
                                // own doc comment), so this lookup can't miss.
                                const section = SETTINGS_SECTIONS.find((s) => s.id === active)!;
                                window.location.href = `${section.href}?mailboxUid=${encodeURIComponent(e.target.value)}`;
                            }}
                        >
                            {mailboxes.map((mb) => (
                                <option key={mb.uid} value={mb.uid}>
                                    {mb.displayName}
                                    {mb.ownerUserUid ? "" : " (shared)"}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
                    {SETTINGS_SECTIONS.map((section) => (
                        <a
                            key={section.id}
                            // `inner` (this whole branch) is only ever computed once `status === "ready"`
                            // and `mailboxUid` has already resolved truthy — a falsy `mailboxUid` returns
                            // `<MailboxProvisioning />` above instead (and TypeScript's own narrowing of
                            // this `const` already reflects that, no `!` needed) — so no fallback is
                            // needed here, matching this plan's established "dead guard the UI
                            // structurally can't trigger" removal precedent (e.g.
                            // `DomainDetailContent.handleVerify`).
                            href={`${section.href}?mailboxUid=${encodeURIComponent(mailboxUid)}`}
                            aria-current={section.id === active ? "page" : undefined}
                            className={[
                                "block px-2.5 py-1.5 rounded-sm text-sm",
                                section.id === active ? "bg-primary/10 text-primary-dark font-medium" : "text-text hover:bg-surface-alt",
                            ].join(" ")}
                        >
                            {section.label}
                        </a>
                    ))}
                </nav>
            </>
        );

        inner = (
            <>
                <aside className="hidden md:flex w-56 shrink-0 bg-surface border-r border-border flex-col p-3 gap-3">
                    {sidebarContent("desktop")}
                </aside>
                <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Settings">
                    <div className="flex flex-col gap-3">{sidebarContent("mobile")}</div>
                </Drawer>
                <main className="flex-1 min-w-0 flex flex-col">
                    <button
                        type="button"
                        className="md:hidden m-3 self-start w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
                        aria-label="Open settings menu"
                        onClick={() => setDrawerOpen(true)}
                    >
                        <HiOutlineBars3 size={20} aria-hidden="true" />
                    </button>
                    <SettingsShellContext.Provider value={contextValue}>{children}</SettingsShellContext.Provider>
                </main>
            </>
        );
    }

    return (
        <AppShell
            active="settings"
            userUid={userUid}
            authServerUrl={authServerUrl}
            impersonating={impersonating}
            impersonationBaseUrl={impersonationBaseUrl}
            trusted={trusted}
        >
            {inner}
        </AppShell>
    );
}
