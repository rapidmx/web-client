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
import { useCompose } from "../compose/ComposeContext.js";

export type MailShellProps = Omit<AppShellProps, "active">;

export interface MailShellContextValue {
    /** The mailbox currently selected (`?mailboxUid=`, or the caller's first accessible mailbox). */
    mailboxUid?: string;
    /** The folder currently selected (`?folderUid=`, or the selected mailbox's Inbox). */
    folderUid?: string;
    mailboxes: Mailbox[];
    folders: Folder[];
}

const MailShellContext = createContext<MailShellContextValue>({ mailboxes: [], folders: [] });

/** Reads the mailbox/folder a page is currently showing, as resolved by the enclosing `MailShell`. */
export function useMailShell(): MailShellContextValue {
    return useContext(MailShellContext);
}

const FOLDER_LABELS: Record<string, string> = {
    inbox: "Inbox",
    sent_items: "Sent Items",
    drafts: "Drafts",
    outbox: "Outbox",
    junk: "Junk Email",
    deleted_items: "Deleted Items",
};

/** Well-known folders sort first, in Gmail/Outlook's conventional order; anything else (incl. `user`) sorts after, alphabetically. */
const FOLDER_ORDER = ["inbox", "drafts", "outbox", "sent_items", "junk", "deleted_items"];

/**
 * A mailbox's `calendar`/`contacts`/`tasks`/`notes` folders back their own dedicated apps (see
 * `CalendarShell`/`ContactsShell`/`TasksShell`), not Mail — `listFolders()` returns every well-known
 * folder for the mailbox regardless of which app owns it, so Mail's own folder tree must filter down
 * to just the mail ones itself, or those other apps' folders leak into this sidebar.
 */
const MAIL_FOLDER_TYPES = new Set([...FOLDER_ORDER, "user"]);

function folderSortKey(folder: Folder): number {
    const idx = FOLDER_ORDER.indexOf(folder.type);
    return idx === -1 ? FOLDER_ORDER.length : idx;
}

type Status = "checking" | "error" | "ready";

/**
 * A separate component (not inlined into `MailShell`'s own render) so `useCompose()` resolves against
 * `ComposeProvider` correctly: that provider is rendered *inside* the `AppShell` that `MailShell` itself
 * returns, i.e. a descendant of `MailShell`, not an ancestor — a hook call made directly in `MailShell`'s
 * own function body would see only whatever context exists *above* `MailShell`, never a provider one of
 * its own descendants creates. This button, rendered as part of `AppShell`'s `children`, sits correctly
 * inside that subtree.
 */
function ComposeButton({ mailboxUid }: { mailboxUid: string }) {
    const { openCompose } = useCompose();
    return (
        <button
            type="button"
            onClick={() => openCompose({ mailboxUid })}
            className="block text-center w-full py-2.5 px-4 rounded-sm font-semibold text-sm bg-primary text-white hover:bg-primary-dark"
        >
            Compose
        </button>
    );
}

/**
 * Mail's own contextual sidebar (mailbox switcher + folder tree) + content area, rendered inside the shared
 * `AppShell` chrome (icon rail, header, impersonation banner — see that component). There is no client-side
 * router in this framework (see `ReactRoute`'s file-convention resolver) — the selected mailbox/folder live
 * in the URL's `?mailboxUid=`/`?folderUid=` query params, read once on mount (never during the initial
 * render itself, matching every other query-param reader in this codebase — e.g. `apps/admin/quarantine`'s
 * `readMailboxUid()` — so the server-rendered and just-hydrated client markup match).
 */
export default function MailShell({
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    children,
}: PropsWithChildren<MailShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [foldersLoading, setFoldersLoading] = useState(true);
    const [folderError, setFolderError] = useState<string | null>(null);
    const [requestedMailboxUid, setRequestedMailboxUid] = useState<string | null>(null);
    const [requestedFolderUid, setRequestedFolderUid] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setRequestedMailboxUid(params.get("mailboxUid"));
        setRequestedFolderUid(params.get("folderUid"));
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
        setFoldersLoading(true);
        listFolders(mailboxUid)
            .then((result) => setFolders(result.filter((f) => MAIL_FOLDER_TYPES.has(f.type))))
            .catch((err) => setFolderError(err instanceof ApiRequestError ? err.message : "Could not load folders."))
            .finally(() => setFoldersLoading(false));
    }, [mailboxUid]);

    const folderUid: string | undefined =
        (requestedFolderUid && folders.some((f) => f.uid === requestedFolderUid) ? requestedFolderUid : undefined) ??
        folders.find((f) => f.type === "inbox")?.uid;

    const contextValue = useMemo<MailShellContextValue>(
        () => ({ mailboxUid, folderUid, mailboxes, folders }),
        [mailboxUid, folderUid, mailboxes, folders],
    );

    const sortedFolders = useMemo(
        () => [...folders].sort((a, b) => folderSortKey(a) - folderSortKey(b) || a.name.localeCompare(b.name)),
        [folders],
    );

    // A full-screen takeover, not nested inside the rest of the app's chrome — there's nothing else
    // for a mailbox-less caller to do here yet, so the icon rail/header/folder tree don't render at all.
    if (userUid && status === "ready" && !mailboxUid) {
        return <MailboxProvisioning />;
    }

    let inner: ReactNode = null;
    if (userUid && status === "checking") {
        // Renders immediately (no network round trip needed) so switching into Mail never shows a blank
        // pane while `listMailboxes()` is in flight — the outline below mirrors the real sidebar's shape.
        inner = (
            <aside className="w-64 shrink-0 bg-surface border-r border-border flex flex-col p-3 gap-4">
                <Skeleton height="h-9" className="rounded-sm" />
                <SkeletonList count={6} />
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
        // A function, not a plain JSX constant — it's rendered twice (desktop `<aside>` + mobile
        // `Drawer`), possibly *simultaneously* mounted (the aside is only CSS-hidden below `md`, not
        // unmounted), so the mailbox-switcher `<select>`'s `id`/its `<label>`'s `htmlFor` need a distinct
        // value per instance. Two elements sharing one id breaks label association (and is invalid HTML).
        const sidebarContent = (idPrefix: string) => (
            <>
                <div className="p-3">
                    <ComposeButton mailboxUid={mailboxUid} />
                </div>
                {mailboxes.length > 1 && (
                    <div className="px-3 pb-2">
                        <label
                            className="block text-xs font-bold uppercase tracking-wide text-text-muted mb-1"
                            htmlFor={`${idPrefix}-mailbox-switcher`}
                        >
                            Mailbox
                        </label>
                        <select
                            id={`${idPrefix}-mailbox-switcher`}
                            className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                            value={mailboxUid}
                            onChange={(e) => {
                                window.location.href = `/?mailboxUid=${encodeURIComponent(e.target.value)}`;
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
                {folderError && (
                    <div className="px-3 pb-2">
                        <Alert>{folderError}</Alert>
                    </div>
                )}
                <nav className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-0.5">
                    {foldersLoading ? (
                        <SkeletonList count={5} className="pt-1" />
                    ) : (
                        sortedFolders.map((folder) => (
                            <a
                                key={folder.uid}
                                href={`/?mailboxUid=${encodeURIComponent(mailboxUid)}&folderUid=${encodeURIComponent(folder.uid)}`}
                                className={[
                                    "flex items-center justify-between text-sm rounded-sm py-1.5 px-2.5",
                                    folder.uid === folderUid
                                        ? "bg-primary/10 text-primary-dark font-semibold"
                                        : "text-text hover:bg-surface-alt",
                                ].join(" ")}
                            >
                                <span>{FOLDER_LABELS[folder.type] ?? folder.name}</span>
                                {folder.unreadCount > 0 && (
                                    <span className="text-xs font-bold rounded-pill py-0.5 px-1.5 bg-surface-alt text-text-muted">
                                        {folder.unreadCount}
                                    </span>
                                )}
                            </a>
                        ))
                    )}
                </nav>
            </>
        );

        inner = (
            <>
                <aside className="hidden md:flex w-64 shrink-0 bg-surface border-r border-border flex-col">
                    {sidebarContent("desktop")}
                </aside>
                <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Folders">
                    <div className="flex flex-col">{sidebarContent("mobile")}</div>
                </Drawer>
                <main className="flex-1 min-w-0 overflow-y-auto">
                    <button
                        type="button"
                        className="md:hidden m-3 w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
                        aria-label="Open folders"
                        onClick={() => setDrawerOpen(true)}
                    >
                        <HiOutlineBars3 size={20} aria-hidden="true" />
                    </button>
                    <MailShellContext.Provider value={contextValue}>{children}</MailShellContext.Provider>
                </main>
            </>
        );
    }

    return (
        <AppShell
            active="mail"
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
