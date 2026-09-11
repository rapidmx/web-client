///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, PropsWithChildren, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { HiOutlineBars3 } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import Drawer from "@rapidmx/react-shared/Drawer.js";
import { Folder, Mailbox, listFolders, listMailboxes } from "@rapidmx/react-shared/mailApi.js";
import Alert from "../../feedback/Alert.js";
import Skeleton, { SkeletonList } from "../../feedback/Skeleton.js";
import AppShell, { AppShellProps } from "../../layout/AppShell.js";
import MailboxProvisioning from "../../layout/MailboxProvisioning.js";

export type CalendarShellProps = Omit<AppShellProps, "active">;

export interface CalendarShellContextValue {
    /** The mailbox currently selected (`?mailboxUid=`, or the caller's first accessible mailbox). */
    mailboxUid?: string;
    /** The selected mailbox's first `calendar`-type folder — kept for callers that only care about a
     * single calendar (e.g. as the default target for "+ New event"). */
    folderUid?: string;
    /** Every `calendar`-type folder for the selected mailbox — usually just one, but a mailbox can have
     * several (see `CalendarListSidebar`). */
    calendarFolders: Folder[];
    mailboxes: Mailbox[];
    /** Re-fetches this mailbox's folders (e.g. after creating a new calendar) without a full mailbox reload. */
    reloadFolders: () => void;
}

const CalendarShellContext = createContext<CalendarShellContextValue>({ calendarFolders: [], mailboxes: [], reloadFolders: () => undefined });

/** Reads the mailbox/folder the Calendar is currently showing, as resolved by the enclosing `CalendarShell`. */
export function useCalendarShell(): CalendarShellContextValue {
    return useContext(CalendarShellContext);
}

type Status = "checking" | "error" | "ready";

/**
 * The Calendar app's shell — structurally identical to `ContactsShell`/`TasksShell` (a mailbox has
 * exactly one well-known `calendar` folder, guaranteed to exist by `BaseMailboxRoute.create()`'s
 * eager provisioning in `@rapidmx/restapi`), just bound to a different folder type. Unlike Contacts/
 * Tasks, the actual view being looked at (month/week/day, and which one) is *not* shell state — it
 * lives in `apps/www/calendar/index.tsx`'s own local state, since navigating between views/dates must
 * be instant (no full page reload) and this framework has no client-side router to make a URL-driven
 * approach for that free.
 */
export default function CalendarShell({
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    children,
}: PropsWithChildren<CalendarShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [folderError, setFolderError] = useState<string | null>(null);
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

    const [folderRefreshToken, setFolderRefreshToken] = useState(0);

    useEffect(() => {
        if (!mailboxUid) {
            setFolders([]);
            return;
        }
        setFolderError(null);
        listFolders(mailboxUid)
            .then(setFolders)
            .catch((err) => setFolderError(err instanceof ApiRequestError ? err.message : "Could not load this mailbox's calendar folder."));
    }, [mailboxUid, folderRefreshToken]);

    const calendarFolders: Folder[] = useMemo(() => folders.filter((f) => f.type === "calendar"), [folders]);
    const folderUid: string | undefined = calendarFolders[0]?.uid;

    const contextValue = useMemo<CalendarShellContextValue>(
        () => ({ mailboxUid, folderUid, calendarFolders, mailboxes, reloadFolders: () => setFolderRefreshToken((t) => t + 1) }),
        [mailboxUid, folderUid, calendarFolders, mailboxes],
    );

    // A full-screen takeover, not nested inside the rest of the app's chrome — there's nothing else
    // for a mailbox-less caller to do here yet, so the icon rail/header don't render at all.
    if (userUid && status === "ready" && !mailboxUid) {
        return <MailboxProvisioning />;
    }

    let inner: ReactNode = null;
    if (userUid && status === "checking") {
        // Renders immediately (no network round trip needed) so switching into Calendar never shows a
        // blank pane while `listMailboxes()` is in flight — the actual sidebar (mini date-picker +
        // calendar list) lives in `apps/www/calendar/index.tsx`'s own content, so this mimics its rough
        // shape rather than the (minimal, mailbox-switcher-only) shape of this shell's own sidebar.
        inner = (
            <div className="w-56 shrink-0 bg-surface border-r border-border p-3 flex flex-col gap-4">
                <Skeleton height="h-40" className="rounded-md" />
                <SkeletonList count={4} />
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
        // A function, not a plain JSX constant — see MailShell/ContactsShell's identical comment: it's
        // rendered twice (desktop `<aside>` + mobile `Drawer`), possibly simultaneously mounted, so the
        // `<select>`'s `id`/its `<label>`'s `htmlFor` need a distinct value per instance.
        const mailboxSwitcher = (idPrefix: string) =>
            mailboxes.length > 1 && (
                <div>
                    <label
                        className="block text-xs font-bold uppercase tracking-wide text-text-muted mb-1"
                        htmlFor={`${idPrefix}-calendar-mailbox-switcher`}
                    >
                        Mailbox
                    </label>
                    <select
                        id={`${idPrefix}-calendar-mailbox-switcher`}
                        className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                        value={mailboxUid}
                        onChange={(e) => {
                            window.location.href = `/calendar?mailboxUid=${encodeURIComponent(e.target.value)}`;
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
            );

        inner = (
            <>
                {mailboxes.length > 1 && (
                    <div className="hidden md:block w-56 shrink-0 bg-surface border-r border-border p-3">{mailboxSwitcher("desktop")}</div>
                )}
                <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Mailbox">
                    <div className="flex flex-col gap-3">
                        {mailboxSwitcher("mobile")}
                        {folderError && <Alert>{folderError}</Alert>}
                    </div>
                </Drawer>
                <div className="flex-1 min-w-0 flex flex-col">
                    {(mailboxes.length > 1 || folderError) && (
                        <button
                            type="button"
                            className="md:hidden m-3 w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
                            aria-label="Open mailbox switcher"
                            onClick={() => setDrawerOpen(true)}
                        >
                            <HiOutlineBars3 size={20} aria-hidden="true" />
                        </button>
                    )}
                    {folderError && (
                        <div className="hidden md:block p-3">
                            <Alert>{folderError}</Alert>
                        </div>
                    )}
                    <CalendarShellContext.Provider value={contextValue}>{children}</CalendarShellContext.Provider>
                </div>
            </>
        );
    }

    return (
        <AppShell
            active="calendar"
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
