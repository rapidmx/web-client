///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, PropsWithChildren, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { HiOutlineBars3 } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Drawer from "@rapidmx/react-shared/components/overlays/Drawer.js";
import { Mailbox, listMailboxes } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Skeleton, { SkeletonList } from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import AppShell, { AppShellProps } from "../../layout/AppShell.js";
import { useLocationSearch, useNavigate } from "../../../navigation/AppRouter.js";
import MailboxProvisioning from "../../layout/MailboxProvisioning.js";
import { mergePluginNavItems, PluginNav } from "../../../plugins/pluginNav.js";

export interface SettingsSectionDef {
    id: string;
    href: string;
    label: string;
}

/** Every settings section with its own sidebar entry. */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
    { id: "profile", href: "/settings/profile", label: "Profile" },
    { id: "appearance", href: "/settings/appearance", label: "Appearance" },
    { id: "auto-reply", href: "/settings/auto-reply", label: "Automatic Replies" },
    { id: "filters", href: "/settings/filters", label: "Mail Filters" },
    { id: "signatures", href: "/settings/signatures", label: "Signatures" },
    { id: "labels", href: "/settings/labels", label: "Labels" },
    { id: "read-receipts", href: "/settings/read-receipts", label: "Read Receipts" },
    { id: "encryption", href: "/settings/encryption", label: "Encryption" },
    { id: "sharing", href: "/settings/sharing", label: "Sharing" },
    { id: "privacy", href: "/settings/privacy", label: "Privacy & Data" },
];

/** A `SETTINGS_SECTIONS` id, or a plugin's `settingsSections` item id (see `PluginNav`). */
export type SettingsSectionId = string;

/** `SETTINGS_SECTIONS` followed by the plugins' `settingsSections` items, core ids winning - see
 * `mergePluginNavItems`. */
export function settingsSections(pluginNav?: PluginNav): SettingsSectionDef[] {
    return mergePluginNavItems<SettingsSectionDef>(SETTINGS_SECTIONS, pluginNav?.settingsSections, ({ id, href, label }) => ({
        id,
        href,
        label,
    }));
}

export interface SettingsShellProps extends Omit<AppShellProps, "active"> {
    /** Which entry in `SETTINGS_SECTIONS` (or plugin `settingsSections` item) is highlighted in this shell's own sidebar — distinct from
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
    trustedRoles,
    pluginNav,
    children,
}: PropsWithChildren<SettingsShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [requestedMailboxUid, setRequestedMailboxUid] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    // Read from the router's location, so a mailbox change (a link, or `navigate()`) takes effect without a page load - and in an
    // effect, not during render, so the server render and the hydrating render agree.
    const search = useLocationSearch();
    const navigate = useNavigate();
    useEffect(() => {
        setRequestedMailboxUid(new URLSearchParams(search).get("mailboxUid"));
    }, [search]);
    // Choosing a folder (or mailbox) changes the URL without a page load now, so the drawer that held the choice - which used to go
    // with the page - is closed here.
    useEffect(() => {
        setDrawerOpen(false);
    }, [search]);

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
        const sections = settingsSections(pluginNav);
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
                                // Every core settings page passes its own section id (see
                                // `SettingsShellProps.active`), but a plugin page's section is missing when the
                                // server didn't send its nav item, so that falls back to the current path.
                                const href = sections.find((s) => s.id === active)?.href ?? window.location.pathname;
                                navigate(`${href}?mailboxUid=${encodeURIComponent(e.target.value)}`);
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
                    {sections.map((section) => (
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
            trustedRoles={trustedRoles}
            pluginNav={pluginNav}
        >
            {inner}
        </AppShell>
    );
}
