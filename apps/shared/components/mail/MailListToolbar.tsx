///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { HiOutlineAdjustmentsHorizontal, HiOutlineBarsArrowDown, HiOutlineStop } from "react-icons/hi2";
import { MessageListFilter, MessageListSort, MessageSortOrder } from "@rapidmx/react-shared/mail/mailApi.js";
import { Label } from "@rapidmx/react-shared/mail/labelsApi.js";
import MenuButton, { MenuSectionSpec } from "./MenuButton.js";
import { NewLabelDialog, labelSections, useLabelDraft } from "./labelMenu.js";
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
    /** The labels the list is currently narrowed to - any of them, not all. */
    labelUids: string[];
    /** Every label this mailbox has, for the Filter menu's own Labels submenu. */
    labels: Label[];
    onLabelUidsChange: (labelUids: string[]) => void;
    /** The mailbox a label created from the Filter menu belongs to. */
    mailboxUid: string;
    /** Handed a label just created from the Filter menu, for the caller to add to `labels`. */
    onLabelCreated: (label: Label) => void;
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
    /** Greys out the sort keys and order while something else decides the order entirely: a search (ranked
     * by relevance) or an aggregate view (one page merged from each mailbox). The Sort button itself stays
     * open, since "Show as conversations" lives in it. */
    sortKeysDisabled?: boolean;
    /** Says why, under the sort keys. */
    sortKeysNote?: string;
    /** Individual sort keys the current arrangement can't order by, each with the reason shown beside it -
     * the conversation list's own case, where the rows are thread summaries carrying no value for some of
     * these (see `CONVERSATION_SORT_UNAVAILABLE`). The rest stay pickable. */
    unavailableSortKeys?: Partial<Record<MessageListSort, string>>;
    /** Select mode acts on the messages of one mailbox - so it is offered over both the message list and
     * the conversation list (where a ticked row means every message of that conversation in this folder),
     * but not over an aggregate view, whose rows come from several mailboxes whose folders a single Move
     * couldn't name, nor over a list that is still loading or has no rows to tick. */
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
    labelUids,
    labels,
    onLabelUidsChange,
    mailboxUid,
    onLabelCreated,
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
    unavailableSortKeys,
    selectDisabled,
    selectDisabledReason,
}: MailListToolbarProps) {
    const activeFilter = filterLabel(filter);
    const orderLabels = SORT_ORDER_LABELS[sortBy];
    // The label picks are drafted while the Filter menu is open and applied in one go, so narrowing to
    // three labels is one refetch rather than three.
    const [filterMenuOpen, setFilterMenuOpen] = useState(false);
    const [creatingLabel, setCreatingLabel] = useState(false);
    const labelDraft = useLabelDraft(labelUids, [], filterMenuOpen);
    const chosenLabelName = labels.find((l) => l.uid === labelUids[0])?.name;
    // What the button says it is set to: the named filter, the labels, or both.
    const activeParts = [
        ...(activeFilter ? [activeFilter] : []),
        ...(labelUids.length === 1 ? [chosenLabelName ?? "1 label"] : labelUids.length > 1 ? [`${labelUids.length} labels`] : []),
    ];
    const filterButtonLabel = activeParts.length > 0 ? `Filter: ${activeParts.join(", ")}` : "Filter";

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

    filterSections.push({
        key: "labels",
        items: [
            {
                key: "labels",
                label: labelUids.length > 0 ? `Labels (${labelUids.length})` : "Labels",
                description: "Show only messages with the labels you pick",
                // A submenu rather than another group: a mailbox can have far more labels than the rest of
                // this menu has rows, and they are picked several at a time rather than one instead of another.
                submenu: labelSections({
                    labels,
                    state: labelDraft,
                    note: "Shows messages with any of the ticked labels.",
                    emptyNote: "This mailbox has no labels yet.",
                    commit: { label: "Apply labels", onSelect: () => onLabelUidsChange(labelDraft.draft), disabled: !labelDraft.dirty },
                    onCreate: () => setCreatingLabel(true),
                    // Clearing the label filter is worth doing in one step, so this applies straight away.
                    clear: { label: "Clear labels", keepOpen: false, disabled: labelUids.length === 0, onSelect: () => onLabelUidsChange([]) },
                }),
            },
        ],
    });

    const sortSections: MenuSectionSpec[] = [
        {
            key: "sortBy",
            label: "Sort by",
            note: sortKeysNote,
            items: MAIL_LIST_SORTS.map((entry) => ({
                key: entry.value,
                label: entry.label,
                // The reason a key is unavailable is shown on the row itself rather than folded into the
                // group's note, so it sits beside the one key it explains.
                description: unavailableSortKeys?.[entry.value],
                role: "menuitemradio" as const,
                checked: sortBy === entry.value,
                disabled: sortKeysDisabled || entry.value in (unavailableSortKeys ?? {}),
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
            <NewLabelDialog
                open={creatingLabel}
                onClose={() => setCreatingLabel(false)}
                mailboxUid={mailboxUid}
                onCreated={onLabelCreated}
            />
            <MenuButton
                aria-label={filterButtonLabel}
                label={filterButtonLabel}
                icon={<HiOutlineAdjustmentsHorizontal size={16} aria-hidden="true" className="shrink-0 text-text-muted" />}
                onOpenChange={setFilterMenuOpen}
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
                // Icon-only, so the tooltip is the only thing naming it on screen - replaced by the reason
                // while it is unavailable, which is the more useful thing to read at that moment.
                title={selectDisabled ? selectDisabledReason : "Select"}
                onClick={() => onSelectModeChange(!selectMode)}
                aria-label="Select"
                className={[
                    // Icon-only, like Outlook's own "select items" command: the glyph carries it and the
                    // name lives in `aria-label`/`title`. The pressed state is a filled, outlined box
                    // rather than only a colour change, so it stays legible next to a disabled one.
                    "ml-auto shrink-0 inline-flex items-center justify-center p-1.5 rounded-md hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent",
                    selectMode ? "bg-primary/10 text-primary-dark" : "text-text-muted",
                ].join(" ")}
            >
                {/* `hi2`'s plain outlined rounded square - the closest thing it has to Outlook's own
                    "select items" glyph, and the only unfilled box in it. */}
                <HiOutlineStop size={18} aria-hidden="true" className="shrink-0" />
            </button>
        </div>
    );
}
