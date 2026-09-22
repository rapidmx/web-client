///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../_routedPage.js";
import { useNavigate } from "../../shared/navigation/AppRouter.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    Contact,
    createContact,
    deleteContact,
    listContacts,
    listDeletedContacts,
    setContactFavorite,
    updateContact,
} from "@rapidmx/react-shared/contacts/contactsApi.js";
import { contactsToVCardFile, contactToVCard, parseVCards } from "@rapidmx/react-shared/contacts/vcard.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import { useCompose } from "../../shared/components/mail/compose/ComposeContext.js";
import ContactsShell, { ContactsShellProps, useContactsShell } from "../../shared/components/contacts/layout/ContactsShell.js";
import ContactsSidebar, { ContactsView } from "../../shared/components/contacts/ContactsSidebar.js";
import ContactsToolbar from "../../shared/components/contacts/ContactsToolbar.js";
import ContactAvatar from "@rapidmx/react-shared/components/avatar/ContactAvatar.js";
import ContactDetailPane from "../../shared/components/contacts/ContactDetailPane.js";
import ContactForm from "../../shared/components/contacts/ContactForm.js";
import { useWritableMailboxes } from "../../shared/components/mail/writableMailboxes.js";
import { getMyMailboxAccess } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import { LIST_PAGE_SIZE, MAX_LIST_PAGES, listAllPages } from "../../shared/mail/listAllPages.js";
import { clearPinnedSignerCache } from "../../shared/components/mail/pinnedSigners.js";
import { SHORTCUTS } from "../../shared/keyboard/keymap.js";
import { useShortcut } from "../../shared/keyboard/useShortcut.js";
import { notifyApiError } from "../../shared/notifications/apiErrors.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

function ContactsPage(props: ContactsShellProps) {
    return (
        <ContactsShell {...props}>
            <ContactsContent userUid={props.userUid} />
        </ContactsShell>
    );
}

type Mode = "view" | "edit" | "new";
type SortColumn = "name" | "info";

/** Shown in the Deleted view when the server answered `?deleted=true` with live contacts (see `canViewDeleted`). */
const DELETED_NOT_PERMITTED_MESSAGE = "You don't have permission to view deleted contacts in this folder.";

function primaryInfo(contact: Contact): string {
    return contact.emails[0]?.address ?? contact.phones[0]?.phoneNumber ?? "";
}

/** How long an export's object URL is kept alive after the click - some browsers are still reading the
 * blob after `click()` returns, so revoking it synchronously can cancel the download. */
const VCARD_DOWNLOAD_URL_LIFETIME_MS = 60_000;

function downloadTextFile(filename: string, content: string): void {
    const blob = new Blob([content], { type: "text/vcard" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), VCARD_DOWNLOAD_URL_LIFETIME_MS);
}

function ContactsContent({ userUid }: { userUid?: string }) {
    const { folderUid, mailboxUid, mailboxes } = useContactsShell();
    // The new-contact form's Mailbox choices - view-only shares are left out (see writableMailboxes.ts).
    const writableMailboxes = useWritableMailboxes(mailboxes, userUid, mailboxUid);
    const { openCompose } = useCompose();
    const isMobile = useIsMobile();
    const navigate = useNavigate();
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [deletedContacts, setDeletedContacts] = useState<Contact[]>([]);
    const [deletedLoading, setDeletedLoading] = useState(false);
    const [deletedError, setDeletedError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Set when `listAllPages()` stopped at its page cap - the list shown isn't every contact.
    const [truncated, setTruncated] = useState(false);
    const [deletedTruncated, setDeletedTruncated] = useState(false);
    const [query, setQuery] = useState("");
    const [view, setView] = useState<ContactsView>({ type: "all" });
    const [sortColumn, setSortColumn] = useState<SortColumn>("name");
    const [sortDesc, setSortDesc] = useState(false);
    const [checkedUids, setCheckedUids] = useState<Set<string>>(new Set());
    const [selectedUid, setSelectedUid] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>("view");
    // Set after a contact is created in a different mailbox than the one this list shows.
    const [savedElsewhere, setSavedElsewhere] = useState<{ mailboxUid: string; displayName: string } | null>(null);
    const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);

    /** Returns a promise so bulk actions (below) can wait for the refreshed list. `error` is only this list's own
     * load failure (cleared first, for a fresh fetch attempt); a failed action is a pop-up instead
     * (`notifyApiError()`), which a reload doesn't touch. */
    function reload(): Promise<void> {
        if (!folderUid) {
            setContacts([]);
            setTruncated(false);
            setLoading(false);
            return Promise.resolve();
        }
        setLoading(true);
        setError(null);
        return listAllPages((page) => listContacts(folderUid, { limit: LIST_PAGE_SIZE, page }))
            .then((result) => {
                setContacts(result.items);
                setTruncated(result.truncated);
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load contacts."))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        void reload();
    }, [folderUid]);

    // restapi only honors `?deleted=true` for a caller with both delete and update rights on the contacts *folder*
    // (its ACL, which inherits the mailbox's but can carry its own records) - anyone else silently gets the *live*
    // contacts back, which the Deleted view would then present as deleted. There is no client API for the caller's
    // access to a folder, so the mailbox-level check below is only a first gate (an owner always passes; anyone else
    // asks the server; unknown - still loading, or the check failed - hides the view), and the Deleted view's own
    // load below detects the server ignoring the filter. `ContactsShell` only renders this with a resolved mailbox,
    // and switching mailboxes is a full page load, so `mailboxUid` never changes under this component.
    const ownsMailbox = mailboxes.some((mb) => mb.uid === mailboxUid && mb.ownerUserUid !== undefined && mb.ownerUserUid === userUid);
    const [delegateCanViewDeleted, setDelegateCanViewDeleted] = useState(false);
    // Resolving a contact's key change needs update rights on the mailbox - `undefined` while unknown.
    const [delegateCanUpdate, setDelegateCanUpdate] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        if (ownsMailbox) {
            return;
        }
        let cancelled = false;
        getMyMailboxAccess(mailboxUid!).then(
            (access) => {
                if (!cancelled) {
                    setDelegateCanViewDeleted(access.canDelete && access.canUpdate);
                    setDelegateCanUpdate(access.canUpdate);
                }
            },
            () => undefined,
        );
        return () => {
            cancelled = true;
        };
    }, [ownsMailbox]);
    const canViewDeleted = ownsMailbox || delegateCanViewDeleted;

    useEffect(() => {
        if (view.type !== "deleted" || !folderUid) {
            return;
        }
        setDeletedLoading(true);
        setDeletedError(null);
        listAllPages((page) => listDeletedContacts(folderUid, { limit: LIST_PAGE_SIZE, page }))
            .then((result) => {
                // A server that dropped the `deleted` filter (no delete+update right on this folder) answers with live
                // contacts, which must never be listed as deleted.
                if (result.items.some((c) => c.deleted !== true)) {
                    setDeletedContacts([]);
                    setDeletedTruncated(false);
                    setDeletedError(DELETED_NOT_PERMITTED_MESSAGE);
                    return;
                }
                setDeletedContacts(result.items);
                setDeletedTruncated(result.truncated);
            })
            .catch((err) => setDeletedError(err instanceof ApiRequestError ? err.message : "Could not load deleted contacts."))
            .finally(() => setDeletedLoading(false));
        // Re-fetches every time the Deleted view is (re-)selected, matching this page's own `reload()`
        // convention elsewhere rather than caching a possibly-stale list across visits.
    }, [view, folderUid]);

    const viewFiltered = useMemo(() => {
        switch (view.type) {
            case "all":
                return contacts;
            case "favorites":
                return contacts.filter((c) => c.favorite);
            case "list":
                return contacts.filter((c) => c.contactListUid === view.uid);
            case "category":
                return contacts.filter((c) => (c.categories ?? []).includes(view.name));
            case "deleted":
                return deletedContacts;
        }
    }, [contacts, deletedContacts, view]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) {
            return viewFiltered;
        }
        return viewFiltered.filter(
            (c) => c.displayName.toLowerCase().includes(q) || c.emails.some((e) => e.address.toLowerCase().includes(q)),
        );
    }, [viewFiltered, query]);

    const sorted = useMemo(() => {
        const arr = [...filtered];
        arr.sort((a, b) => {
            const cmp = (sortColumn === "name" ? a.displayName : primaryInfo(a)).localeCompare(
                sortColumn === "name" ? b.displayName : primaryInfo(b),
            );
            return sortDesc ? -cmp : cmp;
        });
        return arr;
    }, [filtered, sortColumn, sortDesc]);

    const selected = contacts.find((c) => c.uid === selectedUid) ?? null;
    const isDeletedView = view.type === "deleted";
    const checkedContacts = sorted.filter((c) => checkedUids.has(c.uid));
    const allChecked = sorted.length > 0 && sorted.every((c) => checkedUids.has(c.uid));

    function handleSort(column: SortColumn) {
        if (column === sortColumn) {
            setSortDesc((prev) => !prev);
        } else {
            setSortColumn(column);
            setSortDesc(false);
        }
    }

    function toggleChecked(uid: string) {
        setCheckedUids((prev) => {
            const next = new Set(prev);
            if (next.has(uid)) {
                next.delete(uid);
            } else {
                next.add(uid);
            }
            return next;
        });
    }

    function toggleCheckAll() {
        setCheckedUids(allChecked ? new Set() : new Set(sorted.map((c) => c.uid)));
    }

    function handleSelectView(next: ContactsView) {
        setView(next);
        setCheckedUids(new Set());
    }

    function handleSelectRow(contact: Contact) {
        if (isMobile) {
            navigate(`/contacts/${encodeURIComponent(contact.uid)}`);
            return;
        }
        setSelectedUid(contact.uid);
        setMode("view");
    }

    function handleNew() {
        setSelectedUid(null);
        setMode("new");
    }

    // Keyboard shortcuts - the toolbar's New contact and the search box. (A dialog open silences them.)
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    useShortcut(SHORTCUTS.contacts.create, handleNew);
    useShortcut(SHORTCUTS.contacts.search, () => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
    });

    function handleSaved(contact: Contact) {
        setMode("view");
        if (contact.mailboxUid !== mailboxUid) {
            // Created in another mailbox (via the form's Mailbox selector) - it won't be in this list.
            setSelectedUid(null);
            setSavedElsewhere({ mailboxUid: contact.mailboxUid, displayName: contact.displayName });
            return;
        }
        setSavedElsewhere(null);
        setSelectedUid(contact.uid);
        void reload();
    }

    function handleCancel() {
        setMode("view");
    }

    async function handleDelete(contact: Contact) {
        try {
            await deleteContact(contact.uid, contact.version);
            // Trusted signer pins come from contacts - a deleted contact's keys must stop vouching for signatures.
            clearPinnedSignerCache();
            setSelectedUid(null);
            setMode("view");
            void reload();
        } catch (err) {
            notifyApiError(err, "Couldn't delete the contact");
        }
    }

    // The bulk handlers below try every contact and report each failure: the same failure repeated is one pop-up with a count.
    async function handleBulkDelete() {
        setConfirmingBulkDelete(false);
        for (const contact of checkedContacts) {
            try {
                await deleteContact(contact.uid, contact.version);
            } catch (err) {
                notifyApiError(err, "Couldn't delete some of the contacts");
            }
        }
        clearPinnedSignerCache();
        setCheckedUids(new Set());
        await reload();
    }

    // `ContactsToolbar`'s Edit button — the only caller — is itself `disabled` unless exactly one contact
    // is checked, so `checkedContacts[0]` is guaranteed to exist whenever this actually runs; no length
    // guard needed, matching this codebase's established pattern for the same class of "always non-empty
    // by the time it's called" value guaranteed by a disabled control (see `ComposeToolbar.run()`).
    function handleToolbarEdit() {
        setSelectedUid(checkedContacts[0].uid);
        setMode("edit");
    }

    function handleEmail() {
        const addresses = checkedContacts.map((c) => c.emails[0]?.address).filter((a): a is string => Boolean(a));
        // No mailboxUid: a fresh message defaults to the caller's own mailbox, not whichever mailbox's
        // contacts happen to be open - the compose window's From field can still change it.
        openCompose({ to: addresses.join(", ") });
    }

    async function handleToggleFavorite() {
        const allFavorited = checkedContacts.every((c) => c.favorite);
        for (const contact of checkedContacts) {
            try {
                await setContactFavorite(contact, !allFavorited);
            } catch (err) {
                notifyApiError(err, "Couldn't update some of the contacts");
            }
        }
        clearPinnedSignerCache();
        await reload();
    }

    async function handleAddCategory() {
        const category = window.prompt("Category name");
        if (!category?.trim()) {
            return;
        }
        for (const contact of checkedContacts) {
            const categories = Array.from(new Set([...(contact.categories ?? []), category.trim()]));
            try {
                // Only the changed field - sending the whole fetched contact back includes server-managed
                // fields restapi rejects, and would overwrite any concurrent edit to the other fields.
                await updateContact({ uid: contact.uid, version: contact.version, categories });
            } catch (err) {
                notifyApiError(err, "Couldn't update some of the contacts");
            }
        }
        clearPinnedSignerCache();
        await reload();
    }

    function handleExportVCard() {
        downloadTextFile(
            checkedContacts.length === 1 ? `${checkedContacts[0].displayName}.vcf` : "contacts.vcf",
            checkedContacts.length === 1 ? contactToVCard(checkedContacts[0]) : contactsToVCardFile(checkedContacts),
        );
    }

    async function handleImportFile(file: File) {
        if (!mailboxUid || !folderUid) {
            return;
        }
        const text = await file.text();
        const parsed = parseVCards(text);
        for (const input of parsed) {
            try {
                await createContact({ mailboxUid, folderUid, ...input });
            } catch (err) {
                notifyApiError(err, "Couldn't import some of the contacts");
            }
        }
        clearPinnedSignerCache();
        await reload();
    }

    return (
        // From `md` up the page is exactly as tall as the window under the title bar and every column scrolls by itself (the frame's own height is
        // open-ended, so a column's `overflow` would otherwise never apply); on a phone the whole page scrolls, as it always did. Below `lg` the
        // contacts menu is a drawer (a button above the columns), so the list and the detail pane keep a usable width.
        <div className="flex-1 min-w-0 min-h-0 flex flex-col lg:flex-row md:flex-none md:h-[calc(100dvh_-_var(--rr-header-h,4rem))] md:overflow-hidden">
            <ContactsSidebar mailboxUid={mailboxUid} contacts={contacts} active={view} onSelect={handleSelectView} showDeleted={canViewDeleted} />
            <div className="flex-1 min-w-0 min-h-0 flex">
            {/* Hidden on mobile while the "new contact" form (the one form-pane state mobile keeps
                in-place — see the pane's own comment below) is showing, so the two never compete for the
                same row's width. Desktop always shows both side by side. A sensible width for the list - a third of the window, between 16 and
                26 rem - so the detail pane keeps the rest, and its toolbar fits it (`ResponsiveToolbar`). */}
            <div
                className={[
                    "w-full md:w-[clamp(16rem,32vw,26rem)] min-w-0 md:shrink-0 md:border-r border-border md:flex flex-col min-h-0",
                    mode === "new" ? "hidden md:flex" : "flex",
                ].join(" ")}
            >
                <ContactsToolbar
                    selectedCount={checkedContacts.length}
                    allSelectedFavorited={checkedContacts.length > 0 && checkedContacts.every((c) => c.favorite)}
                    onNewContact={handleNew}
                    onEdit={handleToolbarEdit}
                    onDelete={() => setConfirmingBulkDelete(true)}
                    onEmail={handleEmail}
                    onToggleFavorite={handleToggleFavorite}
                    onAddCategory={handleAddCategory}
                    onExportVCard={handleExportVCard}
                    onImportFile={handleImportFile}
                    shortcuts
                />
                <div className="p-3 border-b border-border">
                    <input
                        ref={searchInputRef}
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search contacts"
                        aria-label="Search contacts"
                        className={INPUT_CLASS}
                    />
                </div>
                {error && (
                    <div className="p-3">
                        <Alert>{error}</Alert>
                    </div>
                )}
                {(isDeletedView ? deletedTruncated : truncated) && (
                    <div className="p-3">
                        <Alert>
                            This folder has more contacts than can be shown at once - only the first {LIST_PAGE_SIZE * MAX_LIST_PAGES} are
                            listed.
                        </Alert>
                    </div>
                )}
                {deletedError && isDeletedView && (
                    <div className="p-3">
                        <Alert>{deletedError}</Alert>
                    </div>
                )}
                {(isDeletedView ? deletedLoading : loading) ? (
                    <p className="p-4 text-sm text-text-muted">Loading&hellip;</p>
                ) : sorted.length === 0 ? (
                    <p className="p-4 text-sm text-text-muted">No contacts found.</p>
                ) : (
                    <div className="flex-1 min-h-0 overflow-auto">
                        <table className="w-full table-fixed text-sm">
                            <thead>
                                <tr className="border-b border-border text-left">
                                    {!isDeletedView && (
                                        <th className="w-10 px-3 py-2">
                                            <input
                                                type="checkbox"
                                                aria-label="Select all contacts"
                                                checked={allChecked}
                                                onChange={toggleCheckAll}
                                            />
                                        </th>
                                    )}
                                    <th className="w-[58%] px-3 py-2">
                                        <button
                                            type="button"
                                            onClick={() => handleSort("name")}
                                            className="block max-w-full truncate text-xs font-bold uppercase tracking-wide text-text-muted"
                                        >
                                            Name{sortColumn === "name" ? (sortDesc ? " ▾" : " ▴") : ""}
                                        </button>
                                    </th>
                                    <th className="px-3 py-2">
                                        <button
                                            type="button"
                                            onClick={() => handleSort("info")}
                                            className="block max-w-full truncate text-xs font-bold uppercase tracking-wide text-text-muted"
                                        >
                                            Contact info{sortColumn === "info" ? (sortDesc ? " ▾" : " ▴") : ""}
                                        </button>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {sorted.map((contact) => (
                                    <tr
                                        key={contact.uid}
                                        className={["border-b border-border", contact.uid === selectedUid ? "bg-primary/10" : "hover:bg-surface-alt"].join(
                                            " ",
                                        )}
                                    >
                                        {!isDeletedView && (
                                            <td className="px-3 py-2">
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Select ${contact.displayName}`}
                                                    checked={checkedUids.has(contact.uid)}
                                                    onChange={() => toggleChecked(contact.uid)}
                                                />
                                            </td>
                                        )}
                                        <td className="px-3 py-2">
                                            <button type="button" onClick={() => handleSelectRow(contact)} className="flex w-full min-w-0 items-center gap-2 text-left">
                                                <ContactAvatar displayName={contact.displayName} size={28} />
                                                <span className="min-w-0 truncate font-medium">
                                                    {contact.displayName}
                                                    {contact.favorite && <span aria-label="Favorite"> ★</span>}
                                                </span>
                                            </button>
                                        </td>
                                        <td className="max-w-0 truncate px-3 py-2 text-text-muted">{primaryInfo(contact)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
            {/* On mobile, "selected"/"edit" are unreachable (row taps navigate to /contacts/:uid instead —
                see handleSelectRow), so this pane only needs to show there for "new", which stays in-place
                on every device (an unsaved contact has no uid for a route). Always visible on desktop. */}
            <div className={["flex-1 min-w-0 min-h-0 flex-col md:flex", mode === "new" ? "flex" : "hidden"].join(" ")}>
                {savedElsewhere && mode !== "new" && (
                    <p role="status" className="m-6 mb-0 text-sm py-2 px-3 rounded-sm bg-surface-alt text-text">
                        {savedElsewhere.displayName} was added to{" "}
                        {mailboxes.find((mb) => mb.uid === savedElsewhere.mailboxUid)?.displayName ?? "another mailbox"}.{" "}
                        <a
                            href={`/contacts?mailboxUid=${encodeURIComponent(savedElsewhere.mailboxUid)}`}
                            className="font-medium text-primary-dark hover:underline"
                        >
                            View that mailbox&rsquo;s contacts
                        </a>
                    </p>
                )}
                {mode === "new" && mailboxUid && folderUid ? (
                    <ContactForm
                        mailboxUid={mailboxUid}
                        folderUid={folderUid}
                        mailboxes={writableMailboxes}
                        onSaved={handleSaved}
                        onCancel={handleCancel}
                    />
                ) : mode === "edit" && selected ? (
                    <ContactForm contact={selected} onSaved={handleSaved} onCancel={handleCancel} />
                ) : selected ? (
                    <div className="min-h-0 flex-1 overflow-y-auto p-6">
                        <ContactDetailPane
                            contact={selected}
                            onEdit={() => setMode("edit")}
                            onDelete={() => handleDelete(selected)}
                            onKeysChanged={() => void reload()}
                            canResolveKeys={ownsMailbox || delegateCanUpdate}
                        />
                    </div>
                ) : (
                    <div className="flex flex-1 items-center justify-center p-6 text-center">
                        <p className="text-sm text-text-muted">Select a contact, or create a new one.</p>
                    </div>
                )}
            </div>
            </div>
            <Modal open={confirmingBulkDelete} onClose={() => setConfirmingBulkDelete(false)} title="Delete contacts">
                <p className="text-sm mb-5">
                    Delete {checkedContacts.length} selected {checkedContacts.length === 1 ? "contact" : "contacts"}? They
                    move to Deleted contacts.
                </p>
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingBulkDelete(false)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger" onClick={handleBulkDelete}>
                        Delete
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

export default routedPage("/contacts", ContactsPage);
