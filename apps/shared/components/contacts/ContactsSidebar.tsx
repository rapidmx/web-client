///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { HiOutlineBars3 } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Contact, ContactList, createContactList, listContactLists } from "@rapidmx/react-shared/contactsApi.js";
import Drawer from "@rapidmx/react-shared/Drawer.js";

export type ContactsView =
    | { type: "all" }
    | { type: "favorites" }
    | { type: "list"; uid: string; name: string }
    | { type: "deleted" }
    | { type: "category"; name: string };

export function contactsViewKey(view: ContactsView): string {
    switch (view.type) {
        case "list":
            return `list:${view.uid}`;
        case "category":
            return `category:${view.name}`;
        default:
            return view.type;
    }
}

/** A fixed palette of colors for category swatches, cycled by name — Outlook's own categories are
 * user-assigned colors, but nothing server-side models a color for a category (it's a plain string label
 * on `Contact.categories`), so this is a deterministic client-side stand-in, same idea as `ContactAvatar`'s
 * per-name color. */
const CATEGORY_PALETTE = ["#dc2626", "#d97706", "#059669", "#2563eb", "#7c3aed", "#db2777"];

function categoryColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) | 0;
    }
    return CATEGORY_PALETTE[Math.abs(hash) % CATEGORY_PALETTE.length];
}

export interface ContactsSidebarProps {
    mailboxUid?: string;
    /** The caller's own (non-deleted) contacts — used to compute counts and the distinct category list.
     * Deliberately not fetched again here; the parent already has this loaded for the main table. */
    contacts: Contact[];
    active: ContactsView;
    onSelect: (view: ContactsView) => void;
    /** Bumped by the parent whenever a contact-list membership changes, so a newly-created/renamed list
     * shows up without a full page reload. */
    refreshToken?: number;
}

function NavItem({
    label,
    count,
    active,
    onClick,
    swatch,
}: {
    label: string;
    count?: number;
    active: boolean;
    onClick: () => void;
    swatch?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? "true" : undefined}
            className={[
                "w-full flex items-center justify-between gap-2 text-sm text-left px-2.5 py-1.5 rounded-sm",
                active ? "bg-primary/10 text-primary-dark font-semibold" : "text-text hover:bg-surface-alt",
            ].join(" ")}
        >
            <span className="flex items-center gap-2 min-w-0">
                {swatch && <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: swatch }} />}
                <span className="truncate">{label}</span>
            </span>
            {count !== undefined && <span className="text-xs text-text-muted shrink-0">{count}</span>}
        </button>
    );
}

/**
 * Contacts' Outlook-style left sidebar: "Your contacts" (all, with count), "Favorites", "Your contact
 * lists" (real `ContactList` records, fetched here), "Deleted", and "Categories" (derived from the
 * distinct `categories` values across the loaded contacts — no separate category registry exists
 * server-side). Owns its own contact-list data-fetching, per this app's convention of keeping
 * `ContactsShellContext` itself minimal (mailbox/folder resolution only).
 */
export default function ContactsSidebar({ mailboxUid, contacts, active, onSelect, refreshToken }: ContactsSidebarProps) {
    const [lists, setLists] = useState<ContactList[]>([]);
    const [listsError, setListsError] = useState<string | null>(null);
    const [addingList, setAddingList] = useState(false);
    const [newListName, setNewListName] = useState("");
    const [drawerOpen, setDrawerOpen] = useState(false);

    useEffect(() => {
        if (!mailboxUid) {
            setLists([]);
            return;
        }
        setListsError(null);
        listContactLists(mailboxUid, { limit: 200 })
            .then(setLists)
            .catch((err) => setListsError(err instanceof ApiRequestError ? err.message : "Could not load contact lists."));
    }, [mailboxUid, refreshToken]);

    const favoriteCount = useMemo(() => contacts.filter((c) => c.favorite).length, [contacts]);
    const listCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const c of contacts) {
            if (c.contactListUid) {
                counts.set(c.contactListUid, (counts.get(c.contactListUid) ?? 0) + 1);
            }
        }
        return counts;
    }, [contacts]);
    const categories = useMemo(() => {
        const names = new Set<string>();
        for (const c of contacts) {
            for (const category of c.categories ?? []) {
                names.add(category);
            }
        }
        return Array.from(names).sort((a, b) => a.localeCompare(b));
    }, [contacts]);

    async function handleAddList(e: FormEvent) {
        e.preventDefault();
        if (!mailboxUid || !newListName.trim()) {
            return;
        }
        try {
            const created = await createContactList({ mailboxUid, name: newListName.trim() });
            setLists((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
            setNewListName("");
            setAddingList(false);
        } catch (err) {
            setListsError(err instanceof ApiRequestError ? err.message : "Could not create this list.");
        }
    }

    function handleSelect(view: ContactsView) {
        onSelect(view);
        setDrawerOpen(false);
    }

    // A function, not a plain JSX constant — rendered both in the desktop `<nav>` and the mobile
    // `Drawer` (see MailShell/ContactsShell for the identical pattern and the duplicate-id reasoning
    // behind the `idPrefix`).
    const navContent = (idPrefix: string) => (
        <>
            <div className="flex flex-col gap-0.5">
                <NavItem label="Your contacts" count={contacts.length} active={active.type === "all"} onClick={() => handleSelect({ type: "all" })} />
                <NavItem label="Favorites" count={favoriteCount} active={active.type === "favorites"} onClick={() => handleSelect({ type: "favorites" })} />
                <NavItem label="Deleted" active={active.type === "deleted"} onClick={() => handleSelect({ type: "deleted" })} />
            </div>

            <div>
                <div className="flex items-center justify-between px-2.5 mb-1">
                    <h2 className="text-xs font-bold uppercase tracking-wide text-text-muted">Your contact lists</h2>
                    <button
                        type="button"
                        onClick={() => setAddingList(true)}
                        aria-label="New contact list"
                        className="text-xs font-bold text-primary-dark hover:underline"
                    >
                        +
                    </button>
                </div>
                {listsError && <p className="px-2.5 text-xs text-danger">{listsError}</p>}
                <div className="flex flex-col gap-0.5">
                    {lists.map((list) => (
                        <NavItem
                            key={list.uid}
                            label={list.name}
                            count={listCounts.get(list.uid) ?? 0}
                            active={active.type === "list" && active.uid === list.uid}
                            onClick={() => handleSelect({ type: "list", uid: list.uid, name: list.name })}
                        />
                    ))}
                </div>
                {addingList && (
                    <form onSubmit={handleAddList} className="flex items-center gap-1 px-2.5 mt-1">
                        <input
                            type="text"
                            autoFocus
                            aria-label="New list name"
                            id={`${idPrefix}-new-list-name`}
                            value={newListName}
                            onChange={(e) => setNewListName(e.target.value)}
                            className="flex-1 text-xs py-1 px-1.5 border border-border rounded-sm bg-surface"
                        />
                        <button type="submit" className="text-xs font-semibold text-primary-dark">
                            Add
                        </button>
                    </form>
                )}
            </div>

            {categories.length > 0 && (
                <div>
                    <h2 className="text-xs font-bold uppercase tracking-wide text-text-muted px-2.5 mb-1">Categories</h2>
                    <div className="flex flex-col gap-0.5">
                        {categories.map((name) => (
                            <NavItem
                                key={name}
                                label={name}
                                swatch={categoryColor(name)}
                                active={active.type === "category" && active.name === name}
                                onClick={() => handleSelect({ type: "category", name })}
                            />
                        ))}
                    </div>
                </div>
            )}
        </>
    );

    return (
        <>
            <button
                type="button"
                className="md:hidden m-3 w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
                aria-label="Open contacts menu"
                onClick={() => setDrawerOpen(true)}
            >
                <HiOutlineBars3 size={20} aria-hidden="true" />
            </button>
            <nav aria-label="Contacts" className="hidden md:flex w-56 shrink-0 border-r border-border flex-col gap-4 p-3 overflow-y-auto">
                {navContent("desktop")}
            </nav>
            <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Contacts">
                <div className="flex flex-col gap-4">{navContent("mobile")}</div>
            </Drawer>
        </>
    );
}
