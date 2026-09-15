///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, PropsWithChildren, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { HiOutlineBars3 } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Drawer from "@rapidmx/react-shared/components/overlays/Drawer.js";
import { Folder, Mailbox, listFolders, listMailboxes } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Skeleton, { SkeletonList } from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import AppShell, { AppShellProps } from "../../layout/AppShell.js";
import KeyEnrollmentGate from "../../layout/KeyEnrollmentGate.js";
import MailboxProvisioning from "../../layout/MailboxProvisioning.js";
import { useCompose } from "../compose/ComposeContext.js";
import LocalIndexLifecycle from "../../../search/LocalIndexLifecycle.js";

export type MailShellProps = Omit<AppShellProps, "active">;

/** One mailbox's own mail folders (already filtered to `MAIL_FOLDER_TYPES` and unsorted) - one entry per
 * mailbox in `mailboxes`, fetched in parallel so every accessible mailbox's folder tree can render
 * simultaneously (see `MailShell`'s own doc comment on why this replaced the old single-mailbox `folders`
 * field). `error` is set (and `folders` left empty) for a mailbox whose own `listFolders()` call failed -
 * one mailbox's fetch failure must never blank out every other mailbox's section. */
export interface MailboxFolders {
    mailbox: Mailbox;
    folders: Folder[];
    error?: string;
}

/** The well-known mail folder types an "aggregate" pseudo-folder can merge across every accessible
 * mailbox - a fixed, small set: `outbox` is deliberately excluded (transient per-mailbox send-queue
 * state, not a "merge across mailboxes" concept), and there's no aggregate concept for `calendar`/
 * `contacts`/`tasks`/`notes`/`user` folders (Mail's own sidebar already excludes those - see
 * `MAIL_FOLDER_TYPES`). */
export const AGGREGATE_FOLDER_TYPES = ["inbox", "sent_items", "drafts", "deleted_items", "junk"] as const;
export type AggregateFolderType = (typeof AGGREGATE_FOLDER_TYPES)[number];

function isAggregateFolderType(value: string | null): value is AggregateFolderType {
    return !!value && (AGGREGATE_FOLDER_TYPES as readonly string[]).includes(value);
}

export interface MailShellContextValue {
    /** The mailbox currently selected (`?mailboxUid=`) - `undefined` while an aggregate pseudo-folder is
     * active instead (`aggregateFolderType` set), since there's no single mailbox to speak of then. */
    mailboxUid?: string;
    /** The folder currently selected (`?folderUid=`, or the selected mailbox's Inbox) - `undefined` in
     * aggregate mode, for the same reason. */
    folderUid?: string;
    /** Set only when an aggregate pseudo-folder (`?aggregate=inbox` etc.) is selected instead of a real,
     * single mailbox+folder - mutually exclusive with `mailboxUid`/`folderUid` above. */
    aggregateFolderType?: AggregateFolderType;
    mailboxes: Mailbox[];
    /** Every accessible mailbox's own mail folders - replaces the old single-mailbox `folders: Folder[]`
     * now that every mailbox's tree renders at once (see `MailboxFolders`'s own doc comment). */
    mailboxFolders: MailboxFolders[];
}

const MailShellContext = createContext<MailShellContextValue>({ mailboxes: [], mailboxFolders: [] });

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
    archive: "Archive",
    deleted_items: "Deleted Items",
};

/** Well-known folders sort first, in Gmail/Outlook's conventional order; anything else (incl. `user`) sorts after, alphabetically. */
const FOLDER_ORDER = ["inbox", "drafts", "outbox", "sent_items", "junk", "archive", "deleted_items"];

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

function sortedFoldersOf(folders: Folder[]): Folder[] {
    return [...folders].sort((a, b) => folderSortKey(a) - folderSortKey(b) || a.name.localeCompare(b.name));
}

function aggregateUnreadCount(mailboxFolders: MailboxFolders[], type: AggregateFolderType): number {
    return mailboxFolders.reduce((total, mf) => total + (mf.folders.find((f) => f.type === type)?.unreadCount ?? 0), 0);
}

type Status = "checking" | "error" | "ready";

/** Page size of the one `listMailboxes()` call this shell makes. */
export const MAILBOX_LIST_LIMIT = 100;

/**
 * A separate component (not inlined into `MailShell`'s own render) so `useCompose()` resolves against
 * `ComposeProvider` correctly: that provider is rendered *inside* the `AppShell` that `MailShell` itself
 * returns, i.e. a descendant of `MailShell`, not an ancestor — a hook call made directly in `MailShell`'s
 * own function body would see only whatever context exists *above* `MailShell`, never a provider one of
 * its own descendants creates. This button, rendered as part of `AppShell`'s `children`, sits correctly
 * inside that subtree.
 *
 * Opens with no mailbox: a fresh message defaults to the caller's own mailbox, and the compose window's
 * own From field is where the sender is chosen.
 */
function ComposeButton() {
    const { openCompose } = useCompose();
    return (
        <button
            type="button"
            onClick={() => openCompose({})}
            className="block text-center w-full py-2.5 px-4 rounded-sm font-semibold text-sm bg-primary text-white hover:bg-primary-dark"
        >
            Compose
        </button>
    );
}

/**
 * Mail's own contextual sidebar (every accessible mailbox's own folder tree, plus a merged "All Mailboxes"
 * aggregate section) + content area, rendered inside the shared `AppShell` chrome (icon rail, header,
 * impersonation banner — see that component). There is no client-side router in this framework (see
 * `ReactRoute`'s file-convention resolver) — the selected mailbox/folder (or aggregate pseudo-folder) live
 * in the URL's `?mailboxUid=`/`?folderUid=`/`?aggregate=` query params, read once on mount (never during
 * the initial render itself, matching every other query-param reader in this codebase — e.g.
 * `apps/admin/quarantine`'s `readMailboxUid()` — so the server-rendered and just-hydrated client markup
 * match).
 *
 * Every accessible mailbox's folder tree renders at once - there is no "switch mailbox" affordance
 * anymore (the mailbox `<select>` this shell used to have is gone) - so a single-mailbox user sees zero
 * behavior change from before this, and a multi-mailbox user sees every mailbox's folders (and the new
 * aggregate section) simultaneously, matching the shared-mailbox feature's own "display as a separate set
 * of folders" requirement.
 */
export default function MailShell({
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    pluginNav,
    children,
}: PropsWithChildren<MailShellProps>) {
    const [status, setStatus] = useState<Status>("checking");
    const [error, setError] = useState<string | null>(null);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [mailboxFolders, setMailboxFolders] = useState<MailboxFolders[]>([]);
    const [foldersLoading, setFoldersLoading] = useState(true);
    const [requestedMailboxUid, setRequestedMailboxUid] = useState<string | null>(null);
    const [requestedFolderUid, setRequestedFolderUid] = useState<string | null>(null);
    const [requestedAggregateType, setRequestedAggregateType] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setRequestedMailboxUid(params.get("mailboxUid"));
        setRequestedFolderUid(params.get("folderUid"));
        setRequestedAggregateType(params.get("aggregate"));
    }, []);

    useEffect(() => {
        if (!userUid) {
            return;
        }
        listMailboxes({ limit: MAILBOX_LIST_LIMIT })
            .then((result) => {
                setMailboxes(result);
                setStatus("ready");
            })
            .catch((err) => {
                setError(err instanceof ApiRequestError ? err.message : "Could not load your mailboxes.");
                setStatus("error");
            });
    }, [userUid]);

    const aggregateFolderType: AggregateFolderType | undefined = isAggregateFolderType(requestedAggregateType)
        ? requestedAggregateType
        : undefined;

    const mailboxUid: string | undefined = aggregateFolderType
        ? undefined
        : (requestedMailboxUid && mailboxes.some((mb) => mb.uid === requestedMailboxUid) ? requestedMailboxUid : undefined) ??
          mailboxes[0]?.uid;

    // Fans out one listFolders() call per accessible mailbox in parallel - each call catches its own
    // failure into an MailboxFolders.error rather than letting Promise.all reject, so one mailbox's fetch
    // failure renders that section's own inline Alert instead of blanking out every other mailbox's
    // folder tree.
    useEffect(() => {
        if (mailboxes.length === 0) {
            // Deliberately leaves foldersLoading as-is: this also runs once before listMailboxes() has
            // resolved, and clearing it here would briefly render an empty sidebar the moment mailboxes
            // arrive, before their folders do. A genuinely mailbox-less caller gets MailboxProvisioning.
            setMailboxFolders([]);
            return;
        }
        setFoldersLoading(true);
        void Promise.all(
            mailboxes.map((mailbox) =>
                listFolders(mailbox.uid)
                    .then((result): MailboxFolders => ({ mailbox, folders: result.filter((f) => MAIL_FOLDER_TYPES.has(f.type)) }))
                    .catch(
                        (err): MailboxFolders => ({
                            mailbox,
                            folders: [],
                            error: err instanceof ApiRequestError ? err.message : "Could not load folders.",
                        }),
                    ),
            ),
        )
            .then(setMailboxFolders)
            .finally(() => setFoldersLoading(false));
    }, [mailboxes]);

    const selectedMailboxFolders = mailboxFolders.find((mf) => mf.mailbox.uid === mailboxUid)?.folders ?? [];
    const folderUid: string | undefined = aggregateFolderType
        ? undefined
        : (requestedFolderUid && selectedMailboxFolders.some((f) => f.uid === requestedFolderUid) ? requestedFolderUid : undefined) ??
          selectedMailboxFolders.find((f) => f.type === "inbox")?.uid;

    // The mailbox `KeyEnrollmentGate`/`LocalIndexLifecycle`/`ComposeButton` treat as "the" mailbox when
    // there's no single selected one to use (aggregate mode) - the caller's own owned mailbox if they
    // have one, else whichever accessible mailbox happens to be first. See MailShell's own doc comment on
    // this being an accepted limitation: an aggregate-view message from a *different*, not-yet-visited
    // mailbox may still need that mailbox's own folder view opened directly to unlock/decrypt it.
    const defaultMailboxUid = mailboxes.find((mb) => mb.ownerUserUid === userUid)?.uid ?? mailboxes[0]?.uid;
    const activeMailboxUid = mailboxUid ?? defaultMailboxUid;

    const contextValue = useMemo<MailShellContextValue>(
        () => ({ mailboxUid, folderUid, aggregateFolderType, mailboxes, mailboxFolders }),
        [mailboxUid, folderUid, aggregateFolderType, mailboxes, mailboxFolders],
    );

    // A full-screen takeover, not nested inside the rest of the app's chrome — there's nothing else for a
    // mailbox-less caller to do here yet, so the icon rail/header/folder tree don't render at all. Checks
    // `mailboxes.length` directly (not `!mailboxUid`) since `mailboxUid` is legitimately undefined in
    // aggregate mode even with mailboxes present.
    if (userUid && status === "ready" && mailboxes.length === 0) {
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
        // unmounted).
        const sidebarContent = () => (
            <>
                <div className="p-3">
                    <ComposeButton />
                </div>
                {foldersLoading ? (
                    <div className="flex-1 overflow-y-auto px-3 pb-3">
                        <SkeletonList count={6} className="pt-1" />
                    </div>
                ) : (
                    <nav className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-3">
                        {mailboxes.length > 1 && (
                            <div>
                                <div className="text-xs font-bold uppercase tracking-wide text-text-muted mb-1 px-2.5">
                                    All Mailboxes
                                </div>
                                <div className="flex flex-col gap-0.5">
                                    {AGGREGATE_FOLDER_TYPES.map((type) => {
                                        const unread = aggregateUnreadCount(mailboxFolders, type);
                                        return (
                                            <a
                                                key={type}
                                                href={`/?aggregate=${encodeURIComponent(type)}`}
                                                className={[
                                                    "flex items-center justify-between text-sm rounded-sm py-1.5 px-2.5",
                                                    aggregateFolderType === type
                                                        ? "bg-primary/10 text-primary-dark font-semibold"
                                                        : "text-text hover:bg-surface-alt",
                                                ].join(" ")}
                                            >
                                                <span>{FOLDER_LABELS[type]}</span>
                                                {unread > 0 && (
                                                    <span className="text-xs font-bold rounded-pill py-0.5 px-1.5 bg-surface-alt text-text-muted">
                                                        {unread}
                                                    </span>
                                                )}
                                            </a>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {mailboxFolders.map(({ mailbox, folders, error: mailboxError }) => (
                            <div key={mailbox.uid}>
                                <div className="text-xs font-bold uppercase tracking-wide text-text-muted mb-1 px-2.5 truncate">
                                    {mailbox.displayName}
                                    {mailbox.ownerUserUid ? "" : " (shared)"}
                                </div>
                                {mailboxError && (
                                    <div className="px-2.5 pb-1">
                                        <Alert>{mailboxError}</Alert>
                                    </div>
                                )}
                                <div className="flex flex-col gap-0.5">
                                    {sortedFoldersOf(folders).map((folder) => (
                                        <a
                                            key={folder.uid}
                                            href={`/?mailboxUid=${encodeURIComponent(mailbox.uid)}&folderUid=${encodeURIComponent(folder.uid)}`}
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
                                    ))}
                                </div>
                            </div>
                        ))}
                    </nav>
                )}
            </>
        );

        inner = (
            <>
                <aside className="hidden md:flex w-64 shrink-0 bg-surface border-r border-border flex-col">{sidebarContent()}</aside>
                <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Folders">
                    <div className="flex flex-col">{sidebarContent()}</div>
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

    // Wraps AppShell unconditionally, at a stable tree position regardless of whether mailboxUid has
    // resolved yet - KeyEnrollmentGate itself passes `children` through untouched until a real
    // mailboxUid is supplied (see its own doc comment). Wrapping only once ready (a conditional tree
    // position) would make AppShell itself remount the moment mailboxUid resolves, tearing down
    // whatever state/effects it had already started (confirmed by direct reproduction: the
    // impersonation banner's own internal state was lost exactly at that transition).
    const activeMailbox = mailboxes.find((mb) => mb.uid === activeMailboxUid);
    return (
        <KeyEnrollmentGate
            mailboxUid={activeMailboxUid}
            mailboxAddress={activeMailbox?.primarySmtpAddress}
            mailboxKeys={activeMailbox?.keys}
            // Unlocking is only actually required to sign/encrypt a compose, read an already-encrypted
            // message, or change encryption settings - not merely to open Mail. Those specific call sites
            // (ComposeWindow, MessageDetailPane) request an unlock on demand via useUnlockPrompt() instead.
            // First-time provisioning (a mailbox with no vault at all yet) still always blocks - see this
            // prop's own doc comment on KeyEnrollmentGateProps.
            blocking={false}
            // A shared/delegated mailbox the caller doesn't own is never provisioned from here - its keys
            // belong to its owner (or its admins), not to whoever happens to open it first - and neither is
            // the impersonated user's own mailbox: an administrator must never choose its password/recovery codes.
            canProvision={!impersonating && activeMailbox?.ownerUserUid === userUid}
        >
            <LocalIndexLifecycle
                mailboxUid={activeMailboxUid}
                mailboxKeys={activeMailbox?.keys}
                folders={mailboxFolders.find((mf) => mf.mailbox.uid === activeMailboxUid)?.folders ?? []}
                // A full page may be truncated - pruning against it would delete indexes of accessible mailboxes
                // beyond the limit, so it's only trusted as the complete list when it came back short.
                accessibleMailboxUids={status === "ready" && mailboxes.length < MAILBOX_LIST_LIMIT ? mailboxes.map((mb) => mb.uid) : undefined}
            />
            <AppShell
                active="mail"
                userUid={userUid}
                authServerUrl={authServerUrl}
                impersonating={impersonating}
                impersonationBaseUrl={impersonationBaseUrl}
                trusted={trusted}
                pluginNav={pluginNav}
            >
                {inner}
            </AppShell>
        </KeyEnrollmentGate>
    );
}
