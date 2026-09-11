///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import {
    Contact,
    createContact,
    deleteContact,
    listContacts,
    listDeletedContacts,
    setContactFavorite,
    updateContact,
} from "@rapidmx/react-shared/contactsApi.js";
import { contactsToVCardFile, contactToVCard, parseVCards } from "@rapidmx/react-shared/vcard.js";
import useIsMobile from "@rapidmx/react-shared/useIsMobile.js";
import { useCompose } from "../../shared/components/mail/compose/ComposeContext.js";
import ContactsShell, { ContactsShellProps, useContactsShell } from "../../shared/components/contacts/layout/ContactsShell.js";
import ContactsSidebar, { ContactsView } from "../../shared/components/contacts/ContactsSidebar.js";
import ContactsToolbar from "../../shared/components/contacts/ContactsToolbar.js";
import ContactAvatar from "../../shared/components/contacts/ContactAvatar.js";
import ContactDetailPane from "../../shared/components/contacts/ContactDetailPane.js";
import ContactForm from "../../shared/components/contacts/ContactForm.js";
import Alert from "../../shared/components/feedback/Alert.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function ContactsPage(props: ContactsShellProps) {
    return (
        <ContactsShell {...props}>
            <ContactsContent />
        </ContactsShell>
    );
}

type Mode = "view" | "edit" | "new";
type SortColumn = "name" | "info";

function primaryInfo(contact: Contact): string {
    return contact.emails[0]?.address ?? contact.phones[0]?.phoneNumber ?? "";
}

function downloadTextFile(filename: string, content: string): void {
    const blob = new Blob([content], { type: "text/vcard" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function ContactsContent() {
    const { folderUid, mailboxUid } = useContactsShell();
    const { openCompose } = useCompose();
    const isMobile = useIsMobile();
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [deletedContacts, setDeletedContacts] = useState<Contact[]>([]);
    const [deletedLoading, setDeletedLoading] = useState(false);
    const [deletedError, setDeletedError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [view, setView] = useState<ContactsView>({ type: "all" });
    const [sortColumn, setSortColumn] = useState<SortColumn>("name");
    const [sortDesc, setSortDesc] = useState(false);
    const [checkedUids, setCheckedUids] = useState<Set<string>>(new Set());
    const [selectedUid, setSelectedUid] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>("view");

    /** Returns a promise so bulk actions (below) can wait for the refreshed list before re-asserting their
     * own error message — this always clears `error` first (a legitimate reset for a fresh fetch attempt),
     * which would otherwise silently wipe out a bulk action's own just-set failure message before the user
     * ever saw it, since every bulk handler calls this right after its own error-setting loop. */
    function reload(): Promise<void> {
        if (!folderUid) {
            setContacts([]);
            setLoading(false);
            return Promise.resolve();
        }
        setLoading(true);
        setError(null);
        return listContacts(folderUid, { limit: 500 })
            .then(setContacts)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load contacts."))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        void reload();
    }, [folderUid]);

    useEffect(() => {
        if (view.type !== "deleted" || !folderUid) {
            return;
        }
        setDeletedLoading(true);
        setDeletedError(null);
        listDeletedContacts(folderUid, { limit: 500 })
            .then(setDeletedContacts)
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
            window.location.href = `/contacts/${encodeURIComponent(contact.uid)}`;
            return;
        }
        setSelectedUid(contact.uid);
        setMode("view");
    }

    function handleNew() {
        setSelectedUid(null);
        setMode("new");
    }

    function handleSaved(contact: Contact) {
        setSelectedUid(contact.uid);
        setMode("view");
        void reload();
    }

    function handleCancel() {
        setMode("view");
    }

    async function handleDelete(contact: Contact) {
        try {
            await deleteContact(contact.uid, contact.version);
            setSelectedUid(null);
            setMode("view");
            void reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not delete this contact.");
        }
    }

    async function handleBulkDelete() {
        let bulkError: string | null = null;
        for (const contact of checkedContacts) {
            try {
                await deleteContact(contact.uid, contact.version);
            } catch (err) {
                bulkError = err instanceof ApiRequestError ? err.message : "Could not delete one or more contacts.";
            }
        }
        setCheckedUids(new Set());
        await reload();
        setError(bulkError);
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
        // `ContactsShell` only ever renders this component once `mailboxUid` is resolved (see its own
        // invariant comment) — same non-null pattern as `organizerAddress` in the calendar page.
        openCompose({ mailboxUid: mailboxUid!, to: addresses.join(", ") });
    }

    async function handleToggleFavorite() {
        const allFavorited = checkedContacts.every((c) => c.favorite);
        let bulkError: string | null = null;
        for (const contact of checkedContacts) {
            try {
                await setContactFavorite(contact, !allFavorited);
            } catch (err) {
                bulkError = err instanceof ApiRequestError ? err.message : "Could not update one or more contacts.";
            }
        }
        await reload();
        setError(bulkError);
    }

    async function handleAddCategory() {
        const category = window.prompt("Category name");
        if (!category?.trim()) {
            return;
        }
        let bulkError: string | null = null;
        for (const contact of checkedContacts) {
            const categories = Array.from(new Set([...(contact.categories ?? []), category.trim()]));
            try {
                await updateContact({ ...contact, categories });
            } catch (err) {
                bulkError = err instanceof ApiRequestError ? err.message : "Could not update one or more contacts.";
            }
        }
        await reload();
        setError(bulkError);
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
        let bulkError: string | null = null;
        for (const input of parsed) {
            try {
                await createContact({ mailboxUid, folderUid, ...input });
            } catch (err) {
                bulkError = err instanceof ApiRequestError ? err.message : "Could not import one or more contacts.";
            }
        }
        await reload();
        setError(bulkError);
    }

    return (
        <div className="flex-1 flex min-h-0">
            <ContactsSidebar mailboxUid={mailboxUid} contacts={contacts} active={view} onSelect={handleSelectView} />
            {/* Hidden on mobile while the "new contact" form (the one form-pane state mobile keeps
                in-place — see the pane's own comment below) is showing, so the two never compete for the
                same row's width. Desktop always shows both side by side, unchanged. */}
            <div
                className={[
                    "w-full md:w-96 shrink-0 md:border-r border-border md:flex flex-col min-h-0",
                    mode === "new" ? "hidden md:flex" : "flex",
                ].join(" ")}
            >
                <ContactsToolbar
                    selectedCount={checkedContacts.length}
                    allSelectedFavorited={checkedContacts.length > 0 && checkedContacts.every((c) => c.favorite)}
                    onNewContact={handleNew}
                    onEdit={handleToolbarEdit}
                    onDelete={handleBulkDelete}
                    onEmail={handleEmail}
                    onToggleFavorite={handleToggleFavorite}
                    onAddCategory={handleAddCategory}
                    onExportVCard={handleExportVCard}
                    onImportFile={handleImportFile}
                />
                <div className="p-3 border-b border-border">
                    <input
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
                    <div className="flex-1 overflow-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border text-left">
                                    {!isDeletedView && (
                                        <th className="w-8 px-3 py-2">
                                            <input
                                                type="checkbox"
                                                aria-label="Select all contacts"
                                                checked={allChecked}
                                                onChange={toggleCheckAll}
                                            />
                                        </th>
                                    )}
                                    <th className="px-3 py-2">
                                        <button
                                            type="button"
                                            onClick={() => handleSort("name")}
                                            className="text-xs font-bold uppercase tracking-wide text-text-muted"
                                        >
                                            Name{sortColumn === "name" ? (sortDesc ? " ▾" : " ▴") : ""}
                                        </button>
                                    </th>
                                    <th className="px-3 py-2">
                                        <button
                                            type="button"
                                            onClick={() => handleSort("info")}
                                            className="text-xs font-bold uppercase tracking-wide text-text-muted"
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
                                            <button type="button" onClick={() => handleSelectRow(contact)} className="flex items-center gap-2 text-left">
                                                <ContactAvatar displayName={contact.displayName} size={28} />
                                                <span className="truncate font-medium">
                                                    {contact.displayName}
                                                    {contact.favorite && <span aria-label="Favorite"> ★</span>}
                                                </span>
                                            </button>
                                        </td>
                                        <td className="px-3 py-2 text-text-muted truncate">{primaryInfo(contact)}</td>
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
            <div className={["flex-1 min-w-0 overflow-y-auto p-6 md:block", mode === "new" ? "block" : "hidden"].join(" ")}>
                {mode === "new" && mailboxUid && folderUid ? (
                    <ContactForm mailboxUid={mailboxUid} folderUid={folderUid} onSaved={handleSaved} onCancel={handleCancel} />
                ) : mode === "edit" && selected ? (
                    <ContactForm contact={selected} onSaved={handleSaved} onCancel={handleCancel} />
                ) : selected ? (
                    <ContactDetailPane contact={selected} onEdit={() => setMode("edit")} onDelete={() => handleDelete(selected)} />
                ) : (
                    <p className="text-sm text-text-muted">Select a contact, or create a new one.</p>
                )}
            </div>
        </div>
    );
}
