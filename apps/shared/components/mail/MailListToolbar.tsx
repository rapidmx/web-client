///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineAdjustmentsHorizontal, HiOutlineBarsArrowDown, HiOutlineCheckCircle } from "react-icons/hi2";
import { MessageListFilter, MessageListSort, MessageSortOrder } from "@rapidmx/react-shared/mail/mailApi.js";
import MenuButton, { MenuSectionSpec } from "./MenuButton.js";
import {
    MAIL_LIST_CLASSIFICATION_FILTERS,
    MAIL_LIST_FILTERS,
    MAIL_LIST_SORTS,
    SORT_ORDER_LABELS,
    defaultSortOrder,
} from "./listPreferences.js";

export interface MailListToolbarProps {
    sortBy: MessageListSort;
    sortOrder: MessageSortOrder;
    filter: MessageListFilter;
    showAsConversations: boolean;
    onSortChange: (sortBy: MessageListSort, sortOrder: MessageSortOrder) => void;
    onFilterChange: (filter: MessageListFilter) => void;
    onShowAsConversationsChange: (showAsConversations: boolean) => void;
    selectMode: boolean;
    onSelectModeChange: (selectMode: boolean) => void;
    /** Offers the Focused/Other half of the filter vocabulary - an Inbox-only concept. */
    offerClassificationFilters: boolean;
    /** Search results are ranked by relevance across folders rather than listed from one, so the named
     * filters don't apply to them. */
    filterDisabled?: boolean;
    filterDisabledReason?: string;
    /** Greys out the sort keys and order while something else decides the order: a search (ranked by
     * relevance), an aggregate view (one page merged from each mailbox) or the conversation list (grouped
     * by latest activity). The Sort button itself stays open, since "Show as conversations" lives in it. */
    sortKeysDisabled?: boolean;
    /** Says why, under the sort keys. */
    sortKeysNote?: string;
    /** Select mode acts on messages of one mailbox: a conversation row isn't a message (and a mixed
     * parent/child selection has no sensible bulk semantics), and an aggregate view's rows come from
     * several mailboxes, whose folders a single Move couldn't name. */
    selectDisabled?: boolean;
    selectDisabledReason?: string;
}

/** The label for the filter currently in force, or `undefined` for "All" (which isn't worth naming on the
 * button). */
function filterLabel(filter: MessageListFilter): string | undefined {
    return [...MAIL_LIST_FILTERS, ...MAIL_LIST_CLASSIFICATION_FILTERS].find((entry) => entry.value === filter && entry.value !== "all")
        ?.label;
}

function sortLabel(sortBy: MessageListSort): string {
    // Every `MessageListSort` has an entry, so this never falls through.
    return MAIL_LIST_SORTS.find((entry) => entry.value === sortBy)!.label;
}

/**
 * The mail list's Outlook-style toolbar: a Filter menu, a Sort menu (which also carries "Show as
 * conversations", Outlook's own home for it - it arranges the list rather than acting on a message, and
 * keeping it there leaves the toolbar three controls wide, which is what fits a 400px phone) and a Select
 * toggle that turns the list into a multi-select with bulk actions.
 *
 * Both menus drive server-side parameters (`listMessages()`'s `sortBy`/`sortOrder`/`filter`), so they sort
 * and filter the whole folder rather than the page that happens to be loaded.
 */
export default function MailListToolbar({
    sortBy,
    sortOrder,
    filter,
    showAsConversations,
    onSortChange,
    onFilterChange,
    onShowAsConversationsChange,
    selectMode,
    onSelectModeChange,
    offerClassificationFilters,
    filterDisabled,
    filterDisabledReason,
    sortKeysDisabled,
    sortKeysNote,
    selectDisabled,
    selectDisabledReason,
}: MailListToolbarProps) {
    const activeFilter = filterLabel(filter);
    const orderLabels = SORT_ORDER_LABELS[sortBy];

    const filterSections: MenuSectionSpec[] = [
        {
            key: "filter",
            label: "Filter",
            items: MAIL_LIST_FILTERS.map((entry) => ({
                key: entry.value,
                label: entry.label,
                role: "menuitemradio" as const,
                checked: filter === entry.value,
                onSelect: () => onFilterChange(entry.value),
            })),
        },
    ];
    if (offerClassificationFilters) {
        filterSections.push({
            key: "classification",
            label: "Focused Inbox",
            note: "One filter at a time: picking Focused or Other replaces the filter above.",
            items: MAIL_LIST_CLASSIFICATION_FILTERS.map((entry) => ({
                key: entry.value,
                label: entry.label,
                role: "menuitemradio" as const,
                checked: filter === entry.value,
                onSelect: () => onFilterChange(entry.value),
            })),
        });
    }

    const sortSections: MenuSectionSpec[] = [
        {
            key: "sortBy",
            label: "Sort by",
            note: sortKeysNote,
            items: MAIL_LIST_SORTS.map((entry) => ({
                key: entry.value,
                label: entry.label,
                role: "menuitemradio" as const,
                checked: sortBy === entry.value,
                disabled: sortKeysDisabled,
                // Switching field resets the direction to the one that reads naturally for it, rather than
                // carrying Date's newest-first over to Subject as a surprising Z-A.
                onSelect: () => onSortChange(entry.value, defaultSortOrder(entry.value)),
            })),
        },
        {
            key: "sortOrder",
            label: "Order",
            items: (["desc", "asc"] as const).map((order) => ({
                key: order,
                label: orderLabels[order],
                role: "menuitemradio" as const,
                checked: sortOrder === order,
                disabled: sortKeysDisabled,
                onSelect: () => onSortChange(sortBy, order),
            })),
        },
        {
            key: "arrange",
            items: [
                {
                    key: "conversations",
                    label: "Show as conversations",
                    description: "Group replies into one row",
                    role: "menuitemcheckbox" as const,
                    checked: showAsConversations,
                    onSelect: () => onShowAsConversationsChange(!showAsConversations),
                },
            ],
        },
    ];

    return (
        <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border">
            <MenuButton
                aria-label={activeFilter ? `Filter: ${activeFilter}` : "Filter"}
                label={activeFilter ? `Filter: ${activeFilter}` : "Filter"}
                icon={<HiOutlineAdjustmentsHorizontal size={16} aria-hidden="true" className="shrink-0 text-text-muted" />}
                sections={filterSections}
                disabled={filterDisabled}
                title={filterDisabled ? filterDisabledReason : undefined}
            />
            <MenuButton
                aria-label={`Sort: ${sortLabel(sortBy)}`}
                label={`Sort: ${sortLabel(sortBy)}`}
                icon={<HiOutlineBarsArrowDown size={16} aria-hidden="true" className="shrink-0 text-text-muted" />}
                sections={sortSections}
            />
            <button
                type="button"
                aria-pressed={selectMode}
                disabled={selectDisabled}
                title={selectDisabled ? selectDisabledReason : undefined}
                onClick={() => onSelectModeChange(!selectMode)}
                className={[
                    "ml-auto shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent",
                    selectMode ? "text-primary-dark font-semibold" : "text-text",
                ].join(" ")}
            >
                <HiOutlineCheckCircle size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
                Select
            </button>
        </div>
    );
}
