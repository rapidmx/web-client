///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, PropsWithChildren, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { HiOutlineBars3, HiOutlinePencilSquare } from "react-icons/hi2";
import Drawer from "@rapidmx/react-shared/components/overlays/Drawer.js";
import { Folder, Mailbox, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Skeleton, { SkeletonList } from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import AppShell, { AppShellProps } from "../../layout/AppShell.js";
import { useLocationSearch, useNavigate } from "../../../navigation/AppRouter.js";
import KeyEnrollmentGate from "../../layout/KeyEnrollmentGate.js";
import MailboxProvisioning from "../../layout/MailboxProvisioning.js";
import { prefetchComposeWindow, useCompose } from "../compose/ComposeContext.js";
import LocalIndexLifecycle from "../../../search/LocalIndexLifecycle.js";
import { LiveUpdates, NO_LIVE_UPDATES } from "../../../mail/useMailLiveUpdates.js";
import { MAILBOX_LIST_LIMIT, MailConnectionContext, useMailConnection } from "../../../mail/useMailConnection.js";
import { folderRows } from "../../../mail/folderTree.js";
import {
    CountTracker,
    FolderBadge,
    FolderCount,
    badgeFor,
    badgeLabel,
    countOfFolder,
    inboxUnreadTotal,
} from "../../../mail/folderCounts.js";
import { useUnreadTitle } from "../../../mail/useUnreadTitle.js";
import { pendingCountFor, usePendingSends } from "../../../mail/outbox/pendingSends.js";
import OutboxBadge from "../OutboxBadge.js";
import { ariaKeyShortcuts, withHint } from "../../../keyboard/format.js";
import { SHORTCUTS } from "../../../keyboard/keymap.js";
import { useKeyEnvironment } from "../../../keyboard/ShortcutProvider.js";
import { useShortcut } from "../../../keyboard/useShortcut.js";

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
    /**
     * Adds a folder a page has just created (the Move to prompt's "New folder") to the tree this shell
     * already fetched, so it appears in the sidebar and in every folder picker without a reload - this
     * framework has no client-side router, so a reload is a whole page load.
     *
     * A no-op on the default context value, which is only ever read outside a real shell.
     */
    onFolderCreated: (folder: Folder) => void;
    /** Says which folders the messages on screen live in: one the sidebar does not know is looked for (see `MailConnection.noteFolderUids`). A no-op on the default context value. */
    noteFolderUids: (folderUids: Iterable<string>) => void;
    /**
     * Bumped whenever new mail (or another change to a message) may have arrived - a push event, a reconnect or the safety-net
     * poll - so the list on screen can quietly refetch its first page. See `useMailLiveUpdates()`. Never changes on the default
     * context value, which is only ever read outside a real shell.
     */
    live: LiveUpdates;
    /**
     * Applies a change to a message (`previous` to `next`; `next` absent when it was deleted) to the folder badges at once, and
     * hands back what to call when the server has answered: `settle()` keeps it, `revert()` takes it back. Every place that
     * reads, moves or deletes a message goes through this (see `setReadState()`), so the badges follow. A no-op on the default
     * context value, which is only ever read outside a real shell.
     */
    trackMessageChange: (previous: Message, next: Message | null) => CountTracker;
    /**
     * The phone layout's header row beside the folders button, for the page to put its search box in (`createPortal()`): the shell
     * owns the row, the page owns the search state. `null` until the row has rendered, and on the default context value.
     */
    mobileSearchSlot: HTMLElement | null;
}

const NO_TRACKER: CountTracker = { settle: () => undefined, revert: () => undefined };

const MailShellContext = createContext<MailShellContextValue>({
    mailboxes: [],
    mailboxFolders: [],
    onFolderCreated: () => undefined,
    noteFolderUids: () => undefined,
    live: NO_LIVE_UPDATES,
    trackMessageChange: () => NO_TRACKER,
    mobileSearchSlot: null,
});

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

/** The badge an "All Mailboxes" entry shows: the folders of that type, summed across every mailbox, under the same rules as a single folder's. */
function aggregateBadge(mailboxFolders: MailboxFolders[], type: AggregateFolderType, counts: Record<string, FolderCount>): FolderBadge | undefined {
    const sum = mailboxFolders.reduce(
        (total, mf) => {
            const folder = mf.folders.find((f) => f.type === type);
            const count = folder ? countOfFolder(folder, counts) : { unread: 0, total: 0 };
            return { unread: total.unread + count.unread, total: total.total + count.total };
        },
        { unread: 0, total: 0 },
    );
    return badgeFor(type, sum);
}

/** A folder's badge: an accent pill with the unread count, or - for the folders that show how many they hold - plain muted text. */
function FolderBadgeChip({ badge }: { badge: FolderBadge }) {
    return (
        <span
            className={[
                "text-xs rounded-pill py-0.5 px-1.5",
                badge.kind === "unread" ? "font-bold bg-primary/15 text-primary-dark" : "font-medium text-text-muted",
            ].join(" ")}
        >
            <span aria-hidden="true">{badge.value}</span>
            <span className="sr-only"> {badgeLabel(badge)}</span>
        </span>
    );
}

type Status = "checking" | "error" | "ready";

export { MAILBOX_LIST_LIMIT };

/**
 * A separate component (not inlined into `MailShell`'s own render) so `useCompose()` resolves against
 * `ComposeProvider` correctly: that provider is rendered *inside* the `AppShell` that `MailShell` itself
 * returns, i.e. a descendant of `MailShell`, not an ancestor — a hook call made directly in `MailShell`'s
 * own function body would see only whatever context exists *above* `MailShell`, never a provider one of
 * its own descendants creates. This button, rendered as part of `AppShell`'s `children`, sits correctly
 * inside that subtree.
 *
 * Opens with the caller's own mailbox (the shell has already listed them), so the window can start on its
 * signature, draft and encryption lookups straight away instead of first asking which mailbox that is; the
 * compose window's own From field is where the sender is chosen. Fetches the window's code as the pointer or
 * keyboard reaches the button, so the click finds it already here.
 */
function ComposeButton({ mailboxUid }: { mailboxUid?: string }) {
    const { openCompose } = useCompose();
    const env = useKeyEnvironment();
    return (
        <button
            type="button"
            title={withHint("Compose", SHORTCUTS.mail.create, env)}
            aria-keyshortcuts={ariaKeyShortcuts(SHORTCUTS.mail.create, env)}
            onClick={() => openCompose({ mailboxUid })}
            onPointerEnter={prefetchComposeWindow}
            onFocus={prefetchComposeWindow}
            className="block text-center w-full py-2.5 px-4 rounded-sm font-semibold text-sm bg-primary text-white hover:bg-primary-dark"
        >
            Compose
        </button>
    );
}

/**
 * A small round Compose button floating at the bottom right on a phone, just above the bottom tab bar (which is `h-14`, fixed), for the
 * layout where the sidebar's Compose button is behind the folders drawer. Opens the same window, for the same mailbox, as that button.
 */
function MobileComposeButton({ mailboxUid }: { mailboxUid?: string }) {
    const { openCompose } = useCompose();
    return (
        <button
            type="button"
            aria-label="New message"
            onClick={() => openCompose({ mailboxUid })}
            onPointerEnter={prefetchComposeWindow}
            onFocus={prefetchComposeWindow}
            className="md:hidden fixed right-4 bottom-[4.5rem] z-30 w-12 h-12 flex items-center justify-center rounded-full bg-primary text-white shadow-lg hover:bg-primary-dark"
        >
            <HiOutlinePencilSquare size={22} aria-hidden="true" />
        </button>
    );
}

/**
 * Mail's keyboard shortcuts that don't belong to a list or a message: "New message". A component of its own for the reason `ComposeButton`
 * is - `useCompose()` only resolves below `ComposeProvider`, i.e. inside the `AppShell` this shell renders - and mounted once, whatever number
 * of Compose buttons (the sidebar, the folders drawer) are on screen. Opens the same window, for the same mailbox, as the button.
 */
function MailShortcuts({ mailboxUid }: { mailboxUid?: string }) {
    const { openCompose } = useCompose();
    useShortcut(SHORTCUTS.mail.create, () => openCompose({ mailboxUid }));
    return null;
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
    trustedRoles,
    pluginNav,
    children,
}: PropsWithChildren<MailShellProps>) {
    // The mailboxes, their folders and the live connection come from the persistent app frame when there is one (`AppChrome` owns them, so
    // they survive Mail -> Calendar -> Mail and the push socket, pop-ups, counters and tab title work in every app). A page rendered
    // outside the frame - a test, a plugin page - has no frame to ask, so this shell runs the same hook for itself, and renders the pop-ups.
    const navigate = useNavigate();
    const hosted = useContext(MailConnectionContext);
    const own = useMailConnection({ userUid, enabled: !hosted, open: navigate });
    const { status, error, mailboxes, mailboxFolders, foldersLoading, onFolderCreated, noteFolderUids, live, folderCounts, outbox: outboxStatuses } = hosted ?? own;
    // The messages this tab is still handing to the server: the Outbox pill counts them at once.
    const pendingSends = usePendingSends();
    const [requestedMailboxUid, setRequestedMailboxUid] = useState<string | null>(null);
    const [requestedFolderUid, setRequestedFolderUid] = useState<string | null>(null);
    const [requestedAggregateType, setRequestedAggregateType] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    // The selection lives in the URL, and the router (`AppRouter`) changes the URL without a page load when a folder link is
    // clicked - so it is read from the router's location, which updates, rather than once from `window.location`. Still read
    // in an effect, never during the first render, so the server render and the hydrating render agree.
    const search = useLocationSearch();
    useEffect(() => {
        const params = new URLSearchParams(search);
        setRequestedMailboxUid(params.get("mailboxUid"));
        setRequestedFolderUid(params.get("folderUid"));
        setRequestedAggregateType(params.get("aggregate"));
    }, [search]);
    // Choosing a folder (or mailbox) changes the URL without a page load now, so the drawer that held the choice - which used to go
    // with the page - is closed here.
    useEffect(() => {
        setDrawerOpen(false);
    }, [search]);

    const aggregateFolderType: AggregateFolderType | undefined = isAggregateFolderType(requestedAggregateType)
        ? requestedAggregateType
        : undefined;

    const mailboxUid: string | undefined = aggregateFolderType
        ? undefined
        : (requestedMailboxUid && mailboxes.some((mb) => mb.uid === requestedMailboxUid) ? requestedMailboxUid : undefined) ??
          mailboxes[0]?.uid;

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

    const counts = folderCounts.counts;
    const trackMessageChange = folderCounts.track;
    // `(3) Acme: Mail` in the tab strip while there is unread mail in an Inbox - kept by the frame when there is one.
    useUnreadTitle(inboxUnreadTotal(mailboxFolders, counts), { enabled: !hosted });

    // A state rather than a ref: the page reads it during its render, so it has to re-render once the row it names is in the document.
    const [mobileSearchSlot, setMobileSearchSlot] = useState<HTMLElement | null>(null);
    const contextValue = useMemo<MailShellContextValue>(
        () => ({ mailboxUid, folderUid, aggregateFolderType, mailboxes, mailboxFolders, onFolderCreated, noteFolderUids, live, trackMessageChange, mobileSearchSlot }),
        [mailboxUid, folderUid, aggregateFolderType, mailboxes, mailboxFolders, onFolderCreated, noteFolderUids, live, trackMessageChange, mobileSearchSlot],
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
                    <ComposeButton mailboxUid={defaultMailboxUid} />
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
                                        const badge = aggregateBadge(mailboxFolders, type, counts);
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
                                                <span className={badge?.kind === "unread" ? "font-semibold" : undefined}>{FOLDER_LABELS[type]}</span>
                                                {badge && <FolderBadgeChip badge={badge} />}
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
                                    {folderRows(folders, pendingCountFor(mailbox.uid, pendingSends)).map((row) => {
                                        if (row.kind === "placeholder") {
                                            // A folder the server has not made (or told us about) yet - the Outbox and Sent Items are made with the first message
                                            // sent - shown the moment a message is on its way. Nothing to open; the real folder replaces it when it arrives.
                                            const sending = pendingCountFor(mailbox.uid, pendingSends);
                                            return (
                                                <div
                                                    key={`placeholder-${row.type}`}
                                                    data-folder-placeholder={row.type}
                                                    className="flex items-center justify-between text-sm rounded-sm py-1.5 px-2.5 text-text-muted"
                                                >
                                                    <span>{FOLDER_LABELS[row.type]}</span>
                                                    {row.type === "outbox" && <OutboxBadge total={sending} pendingHere={sending} />}
                                                </div>
                                            );
                                        }
                                        const folder = row.folder;
                                        const badge = badgeFor(folder.type, countOfFolder(folder, counts));
                                        return (
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
                                            <span className={badge?.kind === "unread" ? "font-semibold" : undefined}>
                                                {FOLDER_LABELS[folder.type] ?? folder.name}
                                            </span>
                                            {badge &&
                                                (folder.type === "outbox" ? (
                                                    <OutboxBadge
                                                        total={badge.value}
                                                        status={outboxStatuses[folder.uid]}
                                                        pendingHere={pendingCountFor(mailbox.uid, pendingSends)}
                                                    />
                                                ) : (
                                                    <FolderBadgeChip badge={badge} />
                                                ))}
                                        </a>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </nav>
                )}
            </>
        );

        inner = (
            <>
                <MailShortcuts mailboxUid={defaultMailboxUid} />
                <aside className="hidden md:flex w-64 shrink-0 bg-surface border-r border-border flex-col">{sidebarContent()}</aside>
                <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Folders">
                    <div className="flex flex-col">{sidebarContent()}</div>
                </Drawer>
                <main className="flex-1 min-w-0 overflow-y-auto">
                    <div className="md:hidden flex items-center gap-2 p-3">
                        <button
                            type="button"
                            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
                            aria-label="Open folders"
                            onClick={() => setDrawerOpen(true)}
                        >
                            <HiOutlineBars3 size={20} aria-hidden="true" />
                        </button>
                        <div ref={setMobileSearchSlot} className="flex-1 min-w-0" />
                    </div>
                    <MobileComposeButton mailboxUid={defaultMailboxUid} />
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
                trustedRoles={trustedRoles}
                pluginNav={pluginNav}
            >
                {inner}
            </AppShell>
        </KeyEnrollmentGate>
    );
}
