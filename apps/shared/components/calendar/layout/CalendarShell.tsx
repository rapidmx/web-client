///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, PropsWithChildren, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { accentColorForMailbox, colorForFolder } from "@rapidmx/react-shared/calendar/calendarColors.js";
import { Folder, Mailbox, listFolders, listMailboxes } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Skeleton, { SkeletonList } from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import AppShell, { AppShellProps } from "../../layout/AppShell.js";
import { useLocation } from "../../../navigation/index.js";
import MailboxProvisioning from "../../layout/MailboxProvisioning.js";
import { orderMailboxes, primaryMailboxUid } from "../../../mail/primaryMailbox.js";

export type CalendarShellProps = Omit<AppShellProps, "active">;

/** One mailbox's own `calendar`-type folders. `error` is set (and `calendarFolders` left empty) when that
 * mailbox's own `listFolders()` failed - one mailbox's failure never hides every other mailbox's calendars. */
export interface MailboxCalendars {
    mailbox: Mailbox;
    calendarFolders: Folder[];
    error?: string;
}

export interface CalendarShellContextValue {
    /** The default mailbox for "+ New event" (`?mailboxUid=` if accessible, else the caller's own mailbox,
     * else the first accessible one) - every accessible mailbox's calendars are shown regardless. */
    mailboxUid?: string;
    /** `mailboxUid`'s first `calendar`-type folder - the default target for "+ New event". */
    folderUid?: string;
    /** Every accessible mailbox's `calendar`-type folders, flattened - the set of calendars that can be
     * checked/shown (see `CalendarListSidebar`). Each folder's own `mailboxUid` says which mailbox it's in. */
    calendarFolders: Folder[];
    /** The same folders, grouped per mailbox, for the sidebar's per-mailbox sections. */
    mailboxCalendars: MailboxCalendars[];
    mailboxes: Mailbox[];
    /** Re-fetches every mailbox's folders (e.g. after creating a new calendar) without a full reload. */
    reloadFolders: () => void;
    /** The display color for a calendar folder: its own `color`, else the default for the caller's own
     * mailbox, else its mailbox's `accentColorForMailbox()` - so a shared mailbox's calendar is visually
     * distinct from the caller's own even when neither has a color set. */
    colorFor: (folder: Folder) => string;
}

const CalendarShellContext = createContext<CalendarShellContextValue>({
    calendarFolders: [],
    mailboxCalendars: [],
    mailboxes: [],
    reloadFolders: () => undefined,
    colorFor: (folder) => colorForFolder(folder),
});

/** Reads the calendars the Calendar is currently showing, as resolved by the enclosing `CalendarShell`. */
export function useCalendarShell(): CalendarShellContextValue {
    return useContext(CalendarShellContext);
}

type Status = "checking" | "error" | "ready";

/**
 * The Calendar app's shell. Fetches every accessible mailbox's calendar folders in parallel so shared
 * mailboxes' calendars show alongside the caller's own, each mailbox color-coded (see `colorFor`) - there
 * is no mailbox switcher. The actual view being looked at (month/week/day, and which one) is *not* shell
 * state — it lives in `apps/www/calendar/index.tsx`'s own local state, since navigating between
 * views/dates must be instant (no full page reload) and this framework has no client-side router.
 */
export default function CalendarShell({
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    trustedRoles,
    pluginNav,
    children,
}: PropsWithChildren<CalendarShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [mailboxCalendars, setMailboxCalendars] = useState<MailboxCalendars[]>([]);
    const [requestedMailboxUid, setRequestedMailboxUid] = useState<string | null>(null);
    const [folderRefreshToken, setFolderRefreshToken] = useState(0);

    // Read from the router's location, so a mailbox change (a link, or `navigate()`) takes effect without a page load - and in an
    // effect, not during render, so the server render and the hydrating render agree.
    const { search } = useLocation();
    useEffect(() => {
        setRequestedMailboxUid(new URLSearchParams(search).get("mailboxUid"));
    }, [search]);

    useEffect(() => {
        if (!userUid) {
            return;
        }
        listMailboxes({ limit: 100 })
            .then((result) => {
                setMailboxes(orderMailboxes(result, userUid));
                setStatus("ready");
            })
            .catch((err) => {
                setError(err instanceof ApiRequestError ? err.message : "Could not load your mailboxes.");
                setStatus("error");
            });
    }, [userUid]);

    const ownMailboxUid = primaryMailboxUid(mailboxes, userUid);
    const mailboxUid: string | undefined =
        (requestedMailboxUid && mailboxes.some((mb) => mb.uid === requestedMailboxUid) ? requestedMailboxUid : undefined) ??
        ownMailboxUid;

    useEffect(() => {
        if (mailboxes.length === 0) {
            setMailboxCalendars([]);
            return;
        }
        let cancelled = false;
        void Promise.all(
            mailboxes.map((mailbox) =>
                listFolders(mailbox.uid)
                    .then((folders): MailboxCalendars => ({ mailbox, calendarFolders: folders.filter((f) => f.type === "calendar") }))
                    .catch(
                        (err): MailboxCalendars => ({
                            mailbox,
                            calendarFolders: [],
                            error: err instanceof ApiRequestError ? err.message : "Could not load this mailbox's calendar folder.",
                        }),
                    ),
            ),
        ).then((result) => {
            if (!cancelled) {
                setMailboxCalendars(result);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [mailboxes, folderRefreshToken]);

    const calendarFolders = useMemo(() => mailboxCalendars.flatMap((mc) => mc.calendarFolders), [mailboxCalendars]);
    const folderUid: string | undefined = calendarFolders.find((f) => f.mailboxUid === mailboxUid)?.uid;

    const colorFor = useCallback(
        (folder: Folder) => colorForFolder(folder, folder.mailboxUid === ownMailboxUid ? undefined : accentColorForMailbox(folder.mailboxUid)),
        [ownMailboxUid],
    );
    const reloadFolders = useCallback(() => setFolderRefreshToken((t) => t + 1), []);

    const contextValue = useMemo<CalendarShellContextValue>(
        () => ({ mailboxUid, folderUid, calendarFolders, mailboxCalendars, mailboxes, reloadFolders, colorFor }),
        [mailboxUid, folderUid, calendarFolders, mailboxCalendars, mailboxes, reloadFolders, colorFor],
    );

    // A full-screen takeover, not nested inside the rest of the app's chrome — there's nothing else
    // for a mailbox-less caller to do here yet, so the icon rail/header don't render at all.
    if (userUid && status === "ready" && mailboxes.length === 0) {
        return <MailboxProvisioning />;
    }

    let inner: ReactNode = null;
    if (userUid && status === "checking") {
        // Renders immediately (no network round trip needed) so switching into Calendar never shows a
        // blank pane while `listMailboxes()` is in flight — mimics the rough shape of the real sidebar
        // (mini date-picker + calendar list) that `apps/www/calendar/index.tsx` renders.
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
        inner = (
            <div className="flex-1 min-w-0 flex flex-col">
                <CalendarShellContext.Provider value={contextValue}>{children}</CalendarShellContext.Provider>
            </div>
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
            trustedRoles={trustedRoles}
            pluginNav={pluginNav}
        >
            {inner}
        </AppShell>
    );
}
