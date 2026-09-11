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

export type TasksShellProps = Omit<AppShellProps, "active">;

export interface TasksShellContextValue {
    /** The mailbox currently selected (`?mailboxUid=`, or the caller's first accessible mailbox). */
    mailboxUid?: string;
    /** The selected mailbox's single `tasks`-type folder. */
    folderUid?: string;
    mailboxes: Mailbox[];
    /** The caller's own uid — exposed here (rather than only as `AppShell`'s prop) so the page content
     * can compute "assigned to me" without needing it threaded through separately. */
    userUid?: string;
}

const TasksShellContext = createContext<TasksShellContextValue>({ mailboxes: [] });

/** Reads the mailbox/folder Tasks is currently showing, as resolved by the enclosing `TasksShell`. */
export function useTasksShell(): TasksShellContextValue {
    return useContext(TasksShellContext);
}

type Status = "checking" | "error" | "ready";

/**
 * The Tasks app's shell — structurally identical to `ContactsShell` (a mailbox has exactly one
 * well-known `tasks` folder, guaranteed to exist by `BaseMailboxRoute.create()`'s eager provisioning
 * in `@rapidmx/restapi`), just bound to a different folder type. Kept as its own small component
 * (rather than a single generic "SingleFolderShell" parameterized by type) so each app's sidebar can
 * grow its own app-specific controls later without threading extra props through a shared one.
 */
export default function TasksShell({
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    children,
}: PropsWithChildren<TasksShellProps>) {
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

    useEffect(() => {
        if (!mailboxUid) {
            setFolders([]);
            return;
        }
        setFolderError(null);
        listFolders(mailboxUid)
            .then(setFolders)
            .catch((err) => setFolderError(err instanceof ApiRequestError ? err.message : "Could not load this mailbox's tasks folder."));
    }, [mailboxUid]);

    const folderUid: string | undefined = folders.find((f) => f.type === "tasks")?.uid;

    const contextValue = useMemo<TasksShellContextValue>(
        () => ({ mailboxUid, folderUid, mailboxes, userUid }),
        [mailboxUid, folderUid, mailboxes, userUid],
    );

    // A full-screen takeover, not nested inside the rest of the app's chrome — there's nothing else
    // for a mailbox-less caller to do here yet, so the icon rail/header don't render at all.
    if (userUid && status === "ready" && !mailboxUid) {
        return <MailboxProvisioning />;
    }

    let inner: ReactNode = null;
    if (userUid && status === "checking") {
        // Renders immediately (no network round trip needed) so switching into Tasks never shows a
        // blank pane while `listMailboxes()` is in flight — the real sidebar (My Day/Important/Planned/
        // lists) lives in `apps/www/tasks/index.tsx`'s own content, so this mimics its rough shape rather
        // than the (minimal, mailbox-switcher-only) shape of this shell's own sidebar.
        inner = (
            <aside className="w-56 shrink-0 bg-surface border-r border-border flex flex-col p-3 gap-4">
                <Skeleton height="h-9" />
                <SkeletonList count={5} />
            </aside>
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
        // A function, not a plain JSX constant — see MailShell/ContactsShell/CalendarShell's identical
        // comment: it's rendered twice (desktop `<aside>` + mobile `Drawer`), possibly simultaneously
        // mounted, so the `<select>`'s `id`/its `<label>`'s `htmlFor` need a distinct value per instance.
        const sidebarContent = (idPrefix: string) => (
            <>
                {mailboxes.length > 1 && (
                    <div>
                        <label
                            className="block text-xs font-bold uppercase tracking-wide text-text-muted mb-1"
                            htmlFor={`${idPrefix}-tasks-mailbox-switcher`}
                        >
                            Mailbox
                        </label>
                        <select
                            id={`${idPrefix}-tasks-mailbox-switcher`}
                            className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                            value={mailboxUid}
                            onChange={(e) => {
                                window.location.href = `/tasks?mailboxUid=${encodeURIComponent(e.target.value)}`;
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
                {folderError && <Alert>{folderError}</Alert>}
            </>
        );

        inner = (
            <>
                <aside className="hidden md:flex w-56 shrink-0 bg-surface border-r border-border flex-col p-3 gap-3">
                    {sidebarContent("desktop")}
                </aside>
                <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Mailbox">
                    <div className="flex flex-col gap-3">{sidebarContent("mobile")}</div>
                </Drawer>
                <main className="flex-1 min-w-0 flex flex-col">
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
                    <TasksShellContext.Provider value={contextValue}>{children}</TasksShellContext.Provider>
                </main>
            </>
        );
    }

    return (
        <AppShell
            active="tasks"
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
